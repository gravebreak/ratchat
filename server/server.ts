import { createServer } from 'http';
import { join } from 'node:path';
import { createClient } from 'redis';
import type { RedisClientType } from 'redis';

import { Server } from 'socket.io';
import {default as express} from 'express';

import { eType, mType, tType } from '../shared/schema';
import type { Identity } from '../shared/schema';

import { DispatchService } from './services/dispatch';
import { StateService } from './services/state';
import { ModerationService } from './services/moderation';
import { GameIdentityService } from './services/games/game-identity';
import { IdentityService } from './services/identity';
import { SecurityService } from './services/security';
import { MarkovService } from './services/markov';
import { MessageService } from './services/message';
import { CommandService } from './services/command';

import { getDisplayNick } from './utils/format';
import { GameCommandService } from './services/games/game-command';


main().catch(error => {
	console.error('Fatal error:', error);
	process.exit(1);
});

async function main(){

	if(!process.env.IP_PEPPER){
		throw new Error('FATAL ERROR: IP_PEPPER environment variable is not set.');
	}

	const app = express();
	const httpserver = createServer(app);
	const io = new Server(httpserver, {path:"/ratchat/socket.io/", connectionStateRecovery:{}});
	const usersPath = join(__dirname, 'data', 'users.json');
	const serverConfigPath = join(__dirname, 'config.json');
	const markovConfigPath = join(__dirname, 'markov.json');
	const gameConfigPath = join(__dirname, 'minigames.json');
	const nickFilterPath = join(__dirname, 'nickfilter.json');
	const profFilterPath = join(__dirname, 'profanityfilter.json');
	const bansPath = join(__dirname, 'data', 'bans.json');
	const brainPath = join(__dirname, 'data', 'brain.db');
	const gameUsersPath = join(__dirname, 'data', 'game-users.json');
	const REDIS_TTL = 604800;
	let redisClient: RedisClientType | null = null;
	const gracePeriod = 3000;
	let inGrace = true;
	const clearInput: boolean = true;
	const keepInput: boolean = false;

	if(process.env.REDIS_URL){
		const client : RedisClientType = createClient({url: process.env.REDIS_URL});

		try{
			client.on('error', () => {}); //suppress errors until startup completes
			client.on('reconnecting', () => {});
			client.on('connect', () => {
				if(client.options.socket){
					const port = 'port' in client.options.socket ? client.options.socket.port : 'unknown'
					console.log(`Redis client connected on port: ${port}`);
				}
			});
			await Promise.race([
				client.connect(),
				new Promise((_, reject) => setTimeout(() => reject(new Error('Redis startup timeout')), 3000)),
			]);
			redisClient = client;
			client.removeAllListeners('error');
			client.removeAllListeners('reconnecting');
		}
		catch(error: unknown){
			client.destroy();
			if(error instanceof Error){
				console.error('Redis startup connection error:', error.message);
			} 
			else{
				throw new Error(`Unexpected non-error thrown: ${error}`);
			}
		}

	}
	else{
		console.warn('WARNING: REDIS_URL environment variable is not set. Restart persistence is not available.');
	}

	const dispatchService = new DispatchService({
		redisClient: redisClient,
		redisTTL: REDIS_TTL
	});

	const stateService = new StateService({
		dispatchService: dispatchService,

		serverConfigPath: serverConfigPath,
		markovConfigPath: markovConfigPath,
		gameConfigPath: gameConfigPath,
		redisClient: redisClient,
		redisTTL: REDIS_TTL,
		io: io
	});
	
	//Redis error handler
	if(redisClient){
		let reconnectTimer: NodeJS.Timeout | null = null;

		redisClient.on('reconnecting', () => {
			if(!reconnectTimer){
				console.warn('Redis connection lost, reconnecting...');
				reconnectTimer = setTimeout(() => {
					if(redisClient){ //protection against type errors on .destroy
						redisClient.removeAllListeners();
						redisClient.destroy();
						redisClient = null;
						dispatchService.messageRedisFallback();
						stateService.stateRedisFallback();
						console.error('Redis reconnection timeout exceeded 5s, fell back to stateless');
					}
				}, 5000);
			}
		});

		redisClient.on('connect', () => {	  
			if(reconnectTimer){
				clearTimeout(reconnectTimer);
				reconnectTimer = null;
			}
		});

		redisClient.on('error', (error) => console.warn('Redis client error:', error.message));
	}

	//Redis history load
	if(redisClient){
		await dispatchService.restoreChatHistory(stateService.getServerConfig().msgArrayLen, stateService.getServerConfig().msgArrayTimeout);
		await dispatchService.restoreMessageCounter();
		await stateService.restoreAnnouncement();
	}

	const moderationService = new ModerationService({
		stateService: stateService, 

		nickFilterPath: nickFilterPath,
		profFilterPath: profFilterPath,
		clientCommands: ['export', 'clear', 'clr', 'background', 'bg', 'bgreset', 'dark', 'mute'],
		clientSubCommands: ['info', 'ip', 'list', 'all', 'allevents', 'eventlist', ...Object.values(eType)]
	});

	const gameIdentityService = new GameIdentityService({
		stateService: stateService,

		gameUsersPath: gameUsersPath
	})

	const identityService = new IdentityService({
		moderationService: moderationService,
		stateService: stateService,
		gameIdentityService: gameIdentityService,
		
		usersPath: usersPath
	});

	const securityService = new SecurityService({
		stateService: stateService,
		dispatchService: dispatchService,
		identityService: identityService,

		bansPath: bansPath,
		io: io
	})

	let markovService: MarkovService | null = null; 
	if(stateService.getMarkovConfig().enabled){
		markovService = new MarkovService({
			dispatchService: dispatchService,
			stateService: stateService,
			moderationService: moderationService,
			identityService: identityService,

			brainPath: brainPath,
			io: io
		})
	}

	const messageService = new MessageService({
		dispatchService: dispatchService,
		stateService: stateService,
		moderationService: moderationService,
		identityService: identityService,
		markovService: markovService,

		io: io
	});

	const gameCommandService = new GameCommandService({
		dispatchService: dispatchService,
		stateService: stateService,
		gameIdentityService: gameIdentityService,
		identityService: identityService
	});

	const commandService = new CommandService({
		dispatchService: dispatchService,
		stateService: stateService,
		moderationService: moderationService,
		gameIdentityService: gameIdentityService,
		identityService: identityService,
		securityService: securityService,
		markovService: markovService,
		messageService: messageService,
		gameCommandService: gameCommandService,
	});
	moderationService.addToNickFilter([...commandService.getCommands(), ...gameCommandService.getGameCommands()]);

	//Emote fetchs
	try{
		await stateService.updateEmotes(io)
		console.log('startup emotes loaded');
	}
	catch(error: unknown){
		if(error instanceof Error){
			console.warn(`startup emotes failed: ${error.message}`);
		} 
		else{
			console.error("Unexpected non-error thrown:", error);
		}
	}
	
	//Socket.IO listener
	io.on('connection', (socket) => {
		
		try{
			if(securityService.checkBan(socket.handshake.address)){
				dispatchService.sendSystemChat(socket, mType.error, 'You are banned.');
				socket.disconnect(true);
				console.log('a banned user attempted to join')
			}
		}
		catch(error: unknown){
			if(error instanceof Error){
				console.error(error.message);
			} 
			else{
				console.error("Unexpected non-error thrown:", error);
			}
		}

		//On connection welcome, announcement messages, emote payload, message history
		const welcomeMsg = stateService.getServerConfig().welcomeMsg;
		const announcement = stateService.getAnnouncement();
		const emotes = stateService.getEmotes();
		
		if(emotes.size > 0){
			const emotePayload = Object.fromEntries(emotes);
			dispatchService.sendEmoteList(socket, emotePayload);
		}
		dispatchService.sendChatHistory(socket);
		dispatchService.sendEventList(socket);

		if(!inGrace){
			dispatchService.sendSystemChat(socket, mType.welcome, `${welcomeMsg}`)
			if(announcement){
				dispatchService.sendSystemChat(socket, mType.ann, `announcement: ${announcement}`)
			}
		}

		//Identity Service
		const clientGUID = socket.handshake.auth.token;
		let returningUser: Identity | null = null;
		
		try{
			returningUser = identityService.getUser(clientGUID)
		} 
		catch(error: unknown){
			if(error instanceof Error){
				//swallowed, expected new user flow
			} 
			else{
				console.error("Unexpected non-error thrown:", error);
			}
		}

		if(returningUser){
			stateService.updateSocketUser(io, socket.id, returningUser);
			dispatchService.sendIdentity(socket, returningUser);
			if(!inGrace){
				dispatchService.sendSystemChat(socket, mType.info, `welcome back, ${getDisplayNick(returningUser.nick)}`);
			}
			let scount = 0
			for (const [, u] of stateService.getSocketUsers()){
				if(u.guid === returningUser.guid) scount++;
			}
			if(scount === 1){
				try{
					moderationService.timeCheck(returningUser, tType.joinleave);
					if(!inGrace){
						dispatchService.sendSystemChat(io.except(socket.id), mType.ann,`${getDisplayNick(returningUser.nick)} connected`);
					}
					identityService.setLastMessage(returningUser.guid, Date.now(), false);
				}
				catch(error: unknown){
					if(error instanceof Error){
						//swallowing to prevent join/leave spam
					}
					else{
						console.error("Unexpected non-error thrown:", error);
					}
				}
			}
		} 
		else {
			dispatchService.sendSystemChat(socket,mType.error,"system: please use the /nick <nickname> to set a nickname or /import <GUID> to import one");
			//GDPR warning
			dispatchService.sendSystemChat(socket,mType.error,"system: be aware either command will store data regarding your session. type '/gdpr info' for more info");
			dispatchService.sendSystemChat(socket,mType.info,"system: feel free to use /help or /h to see all available commands. some commands will not be available until you set your nickname!");
			dispatchService.sendSystemChat(socket,mType.info,"we recommend increasing the zoom of your browser to 200% for the best viewing experience :)");
			
			//force broadcastUsers for lurkers check
			stateService.broadcastUsers(io);
		}

		//Message Handling
		socket.on('toServerChat', async (msg, callback) => {
			const user = stateService.getSocketUsers().get(socket.id);

			// Check if it's a command
			if(msg.startsWith('/')){
				try{
					const result = await commandService.commandHandler(msg, socket, io, user);
					callback(result);
					return;
				}
				catch(error: unknown){
					if(error instanceof Error){
						dispatchService.sendSystemChat(socket, mType.error, `system: ${error.message}`)
					}
					else{
						console.error("Unexpected non-error thrown:", error);
					}
					callback(keepInput);
					return;
				}
			}

			//Prevent users from chatting without an identity
			if(!user){
				dispatchService.sendSystemChat(socket, mType.error, "system: please set your nickname with /chrat <nickname> before chatting");
				callback(clearInput);
				return;
			}

			//Sanitize and broadcast
			callback(messageService.handleChat(msg, user, socket, false));
			return;
		});

		socket.on('requesteventlist', (callback) => {
			dispatchService.sendEventList(socket);
			callback();
		});

		//Disconnect flow
		socket.on('disconnect', () => {
			const disuser = stateService.getSocketUsers().get(socket.id);

			if(disuser){
				stateService.deleteSocketUser(io, socket.id);

				let scount = 0;
				for (const [, u] of stateService.getSocketUsers()){
					if(u.guid === disuser.guid) scount++;
				}
				if(scount === 0){
					try{
						moderationService.timeCheck(disuser, tType.joinleave);
						if(!inGrace){
							dispatchService.sendSystemChat(io, mType.ann, `${getDisplayNick(disuser.nick)} disconnected`);
						}
						identityService.setLastMessage(disuser.guid, Date.now());
					}
					catch(error: unknown){
						if(error instanceof Error){
							//swallowing to prevent join/leave spam
						}
						else{
							console.error("Unexpected non-error thrown:", error);
						}
					}
				}
			}
			else{
				//lurker disconnect
				stateService.broadcastUsers(io);
			}
		});
	});
		
	//Client Deployment
	app.get('/ratchat', (req, res) => {
		res.setHeader('X-Robots-Tag', 'noindex, nofollow');
		res.sendFile('www/ratchat.html', { root : __dirname });
	});

	//Health check
	app.get('/ratchat/health', (req, res) => {
		res.status(200).send('ok');
	});

	//Server standup
	httpserver.listen(stateService.getServerConfig().PORT, () => {
		console.log(`server running at http://localhost:${stateService.getServerConfig().PORT}`);
		const now = new Date();
		console.log ('server startup timestamp: ', now.toLocaleString());
	});

	//Grace timer
	setTimeout(() => {
		inGrace = false;
		console.log('startup grace ended', new Date().toLocaleString());
	}, gracePeriod);
}

process.on('uncaughtException', err => {
	const now = new Date();
	console.error(`Uncaught exception timestamp: ${now.toLocaleString()} error:`, err);
});

process.on('unhandledRejection', err => {
	const now = new Date();
	console.error(`Unhandled rejection timestamp: ${now.toLocaleString()} error:`, err);
});

process.on('SIGTERM', () => {
	const now = new Date();
	console.log(`Received SIGTERM timestamp: ${now.toLocaleString()}`);
	process.exit(0);
});

process.on('SIGINT', () => {
	const now = new Date();
	console.log(`Received SIGINT timestamp: ${now.toLocaleString()}`);
	process.exit(0);
});

process.on('SIGHUP', () => {
	const now = new Date();
	console.log(`Received SIGHUP timestamp: ${now.toLocaleString()}`);
	process.exit(0);
});

process.on('SIGQUIT', () => {
	const now = new Date();
	console.log(`Received SIGQUIT timestamp: ${now.toLocaleString()}`);
	process.exit(0);
});

process.on('exit', code => {
	const now = new Date();
	console.log(`Process exiting with code ${code} timestamp: ${now.toLocaleString()}`);
});