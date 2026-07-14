import {default as express} from 'express';
import { createServer } from 'http';
import { join } from 'node:path';
import { Server } from 'socket.io';

import { clearInput, keepInput } from './defs/def-input';
import { eType, mType } from './defs/def-message';
import { tType } from './defs/def-moderation';
import type { Identity } from './defs/def-identity';

import { CacheService } from './services/cache';
import { ConfigService } from './services/config';
import { DispatchService } from './services/dispatch';
import { ModerationService } from './services/moderation';
import { SecurityService } from './services/security';
import { GameIdentityService } from './services/games/game-identity';
import { IdentityService } from './services/identity';
import { GameStateService } from './services/games/game-state';
import { StateService } from './services/state';
import { MarkovService } from './services/markov';
import { MessageService } from './services/message';
import { GameCommandService } from './services/games/game-command';
import { CommandService } from './services/command';

import { getBaseNick } from './utils/format';
import { handleError } from './utils/errors';

main().catch(error => {
	console.error('Fatal error:', error);
	process.exit(1);
});

async function main(): Promise<void> {
	//TODO: remove this line

	if(!process.env.IP_PEPPER){
		throw new Error('FATAL ERROR: IP_PEPPER environment variable is not set.');
	}

	const app = express();
	const httpserver = createServer(app);
	const io = new Server(httpserver, {path:'/ratchat/socket.io/', connectionStateRecovery:{}});
	
	const serverConfigPath = join(__dirname, 'config.json');
	const markovConfigPath = join(__dirname, 'markov.json');
	const gameConfigPath = join(__dirname, 'minigames.json');
	
	const basenickFilterPath = join(__dirname, 'services/filters', 'filter-basenick.json');
	const profFilterPath = join(__dirname, 'services/filters','filter-profanity.json');
	
	const usersPath = join(__dirname, 'data', 'users.json');
	const gameUsersPath = join(__dirname, 'data', 'game-users.json');
	const bansPath = join(__dirname, 'data', 'bans.json');
	const brainPath = join(__dirname, 'data', 'brain.db');
	const fishingRecordsPath = join(__dirname, 'data', 'fish-records.json');
	const horseRecordsPath = join(__dirname, 'data', 'horse-records.json');

	const gracePeriod = 3000;
	let inGrace = true;

	const cacheService = new CacheService();
	if(process.env.REDIS_URL){
		await cacheService.startRedisClient();
	}
	else{
		console.warn('WARNING: REDIS_URL environment variable is not set. Restart persistence is not available.');
	}

	const configService = new ConfigService({
		serverConfigPath: serverConfigPath,
		markovConfigPath: markovConfigPath,
		gameConfigPath: gameConfigPath
	});
	
	const dispatchService = new DispatchService({
		cacheService: cacheService,
		configService: configService
	});

	const moderationService = new ModerationService({
		configService: configService, 

		basenickFilterPath: basenickFilterPath,
		profFilterPath: profFilterPath,
		clientCommands: ['export', 'clear', 'clr', 'background', 'bg', 'bgreset', 'dark', 'mute'],
		clientSubCommands: ['info', 'ip', 'list', 'all', 'allevents', 'eventlist', ...Object.values(eType)]
	});

	const securityService = new SecurityService({
		configService: configService,

		bansPath: bansPath,
	});

	const gameIdentityService = new GameIdentityService({
		configService: configService,

		gameUsersPath: gameUsersPath
	});

	const identityService = new IdentityService({
		moderationService: moderationService,
		gameIdentityService: gameIdentityService,

		usersPath: usersPath
	});

	const gameStateService = new GameStateService({
		cacheService: cacheService,
		dispatchService: dispatchService,
		gameIdentityService: gameIdentityService,
		identityService: identityService,

		fishingRecordsPath: fishingRecordsPath,
		horseRecordsPath: horseRecordsPath
	});

	const stateService = new StateService({
		cacheService: cacheService,
		configService: configService,
		dispatchService: dispatchService,
		identityService: identityService,

		io: io
	});
			
	//Redis history load
	if(cacheService.existsRedisClient()){
		await dispatchService.restoreChatHistory();
		await dispatchService.restoreMessageCounter();
		await stateService.restoreAnnouncement();
		if(configService.getMarkovConfig().enabled){
			await stateService.restoreMarkovSleep();
		}
	}

	let markovService: MarkovService | null = null;
	if(configService.getMarkovConfig().enabled){
		markovService = new MarkovService({
			configService: configService,
			dispatchService: dispatchService,
			moderationService: moderationService,
			identityService: identityService,
			stateService: stateService,

			brainPath: brainPath,
			io: io
		});
	}

	const messageService = new MessageService({
		configService: configService,
		dispatchService: dispatchService,
		moderationService: moderationService,
		identityService: identityService,
		stateService: stateService,
		markovService: markovService,

		io: io
	});

	const gameCommandService = new GameCommandService({
		configService: configService,
		dispatchService: dispatchService,
		gameIdentityService: gameIdentityService,
		identityService: identityService,
		gameStateService: gameStateService
	});

	const commandService = new CommandService({
		configService: configService,
		dispatchService: dispatchService,
		moderationService: moderationService,
		securityService: securityService,
		gameIdentityService: gameIdentityService,
		identityService: identityService,
		stateService: stateService,
		markovService: markovService,
		messageService: messageService,
		gameCommandService: gameCommandService
	});

	moderationService.appendBaseNickFilter([...commandService.getCommands(), ...gameCommandService.getGameCommands()]);

	//Emote fetchs
	try{
		await stateService.updateEmotes(io);
		console.log('startup emotes loaded');
	}
	catch(error: unknown){
		handleError(error, 'Startup Emote Load');
	}
	
	//Socket.IO listener
	io.on('connection', (socket) => {
		
		try{
			if(securityService.existsBan(socket.handshake.address)){
				dispatchService.sendSystemChat(socket, mType.error, 'You are banned.');
				socket.disconnect(true);
				console.log('a banned user attempted to join');
			}
		}
		catch(error: unknown){
			handleError(error, 'Main Function Ban Check');
		}

		//On connection welcome, announcement messages, emote payload, message history
		const welcomeMsg = configService.getServerConfig().welcomeMsg;
		const announcement = stateService.getAnnouncement();
		const emotes = stateService.getEmotes();
		
		if(emotes.size > 0){
			const emotePayload = Object.fromEntries(emotes);
			dispatchService.sendEmoteList(socket, emotePayload);
		}
		dispatchService.sendChatHistory(socket);
		dispatchService.sendEventList(socket);

		if(!inGrace){
			dispatchService.sendSystemChat(socket, mType.welcome, `${welcomeMsg}`);
			if(announcement){
				dispatchService.sendSystemChat(socket, mType.ann, `announcement: ${announcement}`);
			}
		}

		//Identity Service
		const clientGUID = socket.handshake.auth.token;
		let returningUser: Identity | null = null;
		
		if(identityService.existsUser(clientGUID)){
			returningUser = identityService.getUser(clientGUID);
		}

		if(returningUser){
			stateService.updateSocketUser(io, socket.id, returningUser);
			dispatchService.sendIdentity(socket, returningUser);
			if(!inGrace){
				dispatchService.sendSystemChat(socket, mType.info, `welcome back, ${getBaseNick(returningUser.fullnick)}`);
			}
			let scount = 0;
			for (const [, u] of stateService.getSocketUsersMap()){
				if(u.guid === returningUser.guid){
					scount++;
				}
			}
			if(scount === 1){
				try{
					moderationService.moderateTime(returningUser, tType.joinleave);
					if(!inGrace){
						dispatchService.sendSystemChat(io.except(socket.id), mType.ann,`${getBaseNick(returningUser.fullnick)} connected`);
					}
					identityService.setLastMessage(returningUser.guid, Date.now(), false);
				}
				catch(error: unknown){
					handleError(error, 'Main Function Reconnect');
				}
			}
		} 
		else {
			dispatchService.sendSystemChat(socket,mType.error,'system: please use the /nick <nickname> to set a nickname or /import <GUID> to import one');
			//GDPR warning
			dispatchService.sendSystemChat(socket,mType.error,"system: be aware either command will store data regarding your session. type '/gdpr info' for more info");
			dispatchService.sendSystemChat(socket,mType.info,'system: feel free to use /help or /h to see all available commands. some commands will not be available until you set your nickname!');
			dispatchService.sendSystemChat(socket,mType.info,'we recommend increasing the zoom of your browser to 200% for the best viewing experience :)');
			
			//force broadcastUsers for lurkers check
			stateService.broadcastUsers(io);
		}

		//Message Handling
		socket.on('toServerChat', async (msg, callback) => {
			const user = stateService.getSocketUser(socket.id);

			// Check if it's a command
			if(msg.startsWith('/')){
				try{
					const result = await commandService.handleCommand(msg, socket, io, user);
					callback(result);
					return;
				}
				catch(error: unknown){
					dispatchService.sendUserError(socket, error, 'Main Function Command Check');
					callback(keepInput);
					return;
				}
			}

			//Prevent users from chatting without an identity
			if(!user){
				dispatchService.sendSystemChat(socket, mType.error, 'system: please set your nickname with /chrat <nickname> before chatting');
				callback(clearInput);
				return;
			}

			//Sanitize and broadcast
			callback(messageService.handleChat(msg, user, socket, false));
		});

		socket.on('requesteventlist', (callback) => {
			dispatchService.sendEventList(socket);
			callback();
		});

		//Disconnect flow
		socket.on('disconnect', () => {
			const socketUsers = stateService.getSocketUsersMap();
			const disuser = socketUsers.get(socket.id) ?? null;

			if(disuser){
				stateService.deleteSocketUser(io, socket.id);
				let scount = 0;
				for(const [, u] of socketUsers){
					if(u.guid === disuser.guid){
						scount++;
					}
				}
				if(scount === 0){
					try{
						moderationService.moderateTime(disuser, tType.joinleave);
						if(!inGrace){
							dispatchService.sendSystemChat(io, mType.ann, `${getBaseNick(disuser.fullnick)} disconnected`);
						}
						identityService.setLastMessage(disuser.guid, Date.now());
					}
					catch(error: unknown){
						handleError(error, 'Main Function Disconnect');
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
	httpserver.listen(configService.getServerConfig().PORT, () => {
		console.log(`server running at http://localhost:${configService.getServerConfig().PORT}`);
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