import { createServer } from 'http';
import { join } from 'node:path';

import { Server } from 'socket.io';
import {default as express} from 'express';

import { mType, tType } from '../shared/schema';
import type { Identity } from '../shared/schema';

import { MessageService } from './services/message';
import { StateService } from './services/state';
import { ModerationService } from './services/moderation';
import { IdentityService } from './services/identity';
import { SecurityService } from './services/security';
import { CommandService } from './services/command';
import { MarkovService } from './services/markov';

import { getDisplayNick } from './utils/format';

if(!process.env.IP_PEPPER){
	console.error('FATAL ERROR: IP_PEPPER environment variable is not set.');
	process.exit(1);
}

if(!process.env.REDIS_URL){
	console.warn('WARNING: REDIS_URL environmen variable is not set. Restart persistence is not available.')
}

const app = express();
const httpserver = createServer(app);
const io = new Server(httpserver, {path:"/ratchat/socket.io/", connectionStateRecovery:{}});
const usersPath = join(__dirname, 'data', 'users.json');
const serverConfigPath = join(__dirname, 'config.json');
const markovConfigPath = join(__dirname, 'markov.json');
const miniConfigPath = join(__dirname, 'minigames.json');
const nickFilterPath = join(__dirname, 'nickfilter.json');
const profFilterPath = join(__dirname, 'profanityfilter.json');
const bansPath = join(__dirname, 'data', 'bans.json');
const brainPath = join(__dirname, 'data', 'brain.db')

const messageService = new MessageService({

});

const stateService = new StateService({
	messageService: messageService,

	serverConfigPath: serverConfigPath,
	markovConfigPath: markovConfigPath,
	miniConfigPath: miniConfigPath,
	io: io
});

const moderationService = new ModerationService({
	stateService: stateService, 

	nickFilterPath: nickFilterPath,
	profFilterPath: profFilterPath
});

const identityService = new IdentityService({
	moderationService: moderationService,
	stateService: stateService,
	
	usersPath: usersPath
});

const securityService = new SecurityService({
	stateService: stateService,
	messageService: messageService,
	identityService: identityService,

	bansPath: bansPath,
	io: io
})

let markovService: MarkovService | null = null; 
if(stateService.getMarkovConfig().enabled){
	markovService = new MarkovService({
		messageService: messageService,
		stateService: stateService,
		moderationService: moderationService,
		identityService: identityService,

		brainPath: brainPath,
		io: io,
	})
}

const commandService = new CommandService({
	messageService: messageService,
	stateService: stateService,
	moderationService: moderationService,
	identityService: identityService,
	securityService: securityService,
	markovService: markovService,
});

//CONNECTION POINT

io.on('connection', (socket) => {
	
	try{
		if(securityService.checkBan(socket.handshake.address)){
			messageService.sendSys(socket, mType.error, 'You are banned.');
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
		messageService.send(socket, mType.emote, emotePayload);
	}
	for (const [id, msg] of messageService.getChatHistory()){
		messageService.send(socket, mType.chat, msg)
	}
	messageService.sendSys(socket, mType.welcome, `${welcomeMsg}`)
	if(announcement){
		messageService.sendSys(socket, mType.ann, `announcement: ${announcement}`)
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
		messageService.send(socket, mType.identity, returningUser);
		messageService.sendSys(socket, mType.info, `welcome back, ${getDisplayNick(returningUser.nick)}`);
		
		let scount = 0
		for (const [, u] of stateService.getSocketUsers()){
			if(u.guid === returningUser.guid) scount++;
		}
		if(scount === 1){
			try{
				const broadcast = moderationService.timeCheck(returningUser, tType.joinleave);
				messageService.sendSys(io.except(socket.id), mType.ann,`${getDisplayNick(returningUser.nick)} connected`);
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
		messageService.sendSys(socket,mType.error,"system: please use the /nick <nickname> to set a nickname or /import <GUID> to import one");
		//GDPR warning
		messageService.sendSys(socket,mType.error,"system: be aware either command will store data regarding your session. type '/gdpr info' for more info");
		messageService.sendSys(socket,mType.info,"system: feel free to use /help or /h to see all available commands. some commands will not be available until you set your nickname!");
		messageService.sendSys(socket,mType.info,"we recommend increasing the zoom of your browser to 200% for the best viewing experience :)");
		
		//force broadcastUsers for lurkers check
		stateService.broadcastUsers(io);
	}

	//Message Handling
	socket.on('toServerChat', async (msg, callback) => {
		const user = stateService.getSocketUsers().get(socket.id);

		// Check if it's a command
		if(msg.startsWith('/')){
			try{
				let clear = await commandService.commandHandler(msg, socket, io, user);
				if(clear){
					if(typeof callback === 'function'){
						callback();
					}
				}
				return;
			}
			catch(error: unknown){
				if(error instanceof Error){
					messageService.sendSys(socket, mType.error, `system: ${error.message}`)
					return;
				}
				else{
					console.error("Unexpected non-error thrown:", error);
				}
			}
		}

		//Prevent users from chatting without an identity
		if(!user){
			messageService.sendSys(socket, mType.error, "system: please set your nickname with /chrat <nickname> before chatting");
			if(typeof callback === 'function'){
				callback();
			} 
			return;
		}

		//Sanitize and broadcast
		try{
			const safe = moderationService.textCheck(msg, user, 'chat');
			messageService.sendChat(io, user, safe, stateService.getServerConfig().msgArrayLen);
			
			if(markovService && stateService.getMarkovConfig().learning){
				queueMicrotask(() => {
					try{
						markovService!.markovLearn(safe)
					}
					catch(error: unknown){
						if(error instanceof Error){
							console.warn('markov learning error:', error.message);
						}
						else{
							console.error("Unexpected non-error thrown:", error);
						}
					}	
				});
			}

			try{
				const wasAfk = user.isAfk;
				identityService.setLastMessage(user.guid, Date.now());
				if(wasAfk){
					stateService.broadcastUsers(io);
				}
			} 
			catch(error: unknown){
				if(error instanceof Error){
					console.warn(error.message);
					throw error;
				} 
				else{
					console.error("Unexpected non-error thrown:", error);
					throw new Error("Unexpected error");
				}

			}

			if(typeof callback === 'function'){
				callback();
			}
		}
		catch(error: unknown){
			if(error instanceof Error){
				messageService.sendSys(socket, mType.error, `system: ${error.message}`)
			} 
			else{
				console.error("Unexpected non-error thrown:", error);
			}
			return;
		}
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
					messageService.sendSys(io, mType.ann, `${getDisplayNick(disuser.nick)} disconnected`);
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

//Fetch emotes on startup
async function startUp(){
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
}
startUp();

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