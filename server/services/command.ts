import { Server, Socket } from 'socket.io';

import type { Command, Identity } from '../../shared/schema.ts';
import { tType, mType } from '../../shared/schema';

import { MessageService } from './message';
import { StateService } from './state';
import { ModerationService } from './moderation';
import { IdentityService } from '../services/identity';
import { SecurityService } from '../services/security';
import { MarkovService } from './markov';

export interface CommandServiceDependencies {
	messageService: MessageService;
	stateService: StateService;
	moderationService: ModerationService;
	identityService: IdentityService;
	securityService: SecurityService;
	markovService: MarkovService | null;
}

export class CommandService {
	private commands: Record<string, (ctx: Command) => boolean | Promise<boolean>> = {};
	private activeCommands: Map<string, boolean> = new Map();
	private deps: CommandServiceDependencies;

	constructor(dependencies: CommandServiceDependencies) {
		this.deps = dependencies;
		this.registerCommands();
	}

	public async commandHandler(msg: string, socket: Socket, io: Server, userOrUndef?: Identity | undefined): Promise<boolean>{
		const args = msg.slice(1).trim().split(/ +/);
		const commandName = args.shift()?.toLowerCase() || '';
		
		let user = userOrUndef ?? null;

		if(this.activeCommands.get(socket.id)){
			return false;
		}

		this.activeCommands.set(socket.id, true);
		
		try{
			const clearText = await this.execute(commandName, {
				socket,
				io,
				args,
				fullArgs: args.join(' '),
				commandUser: user
				});
			
			return clearText;
		}

		finally{
			this.activeCommands.delete(socket.id)
		}
	}


	//execute the command, true to clear 
	private async execute(name: string, ctx: Command): Promise<boolean> {
		const handler = this.commands[name];
		if (handler) {
			//true to clear input, false to keep
			return await handler(ctx);
		} else {
			this.deps.messageService.sendSys(ctx.socket, mType.error, "system: that's not a command lol");
			return false;
		}
	}

	private registerCommands() {
		let markovNick = 'markov'
		if(this.deps.stateService.markovUser){
			markovNick = this.deps.stateService.markovUser.nick.substring(7);
		}
		
		// ------------------------------------------------------------------
		// STANDARD COMMANDS
		// ------------------------------------------------------------------
		
		this.commands['help'] = (ctx) => {
			const config = this.deps.stateService.getConfig();
			const helpMessages = [
				'/help, /h, or /commands : View this list.',
				'/chrat or /nick <nickname> : Change your nickname to <nickname>.',
				"/color or /colour <#RRGGBB> : Change your nickname's color to hex #RRGGBB.",
				//./dark handled client side
				'/dark : by popular demand, toggle dark mode!',
				//./clear and /clr are handled client side
				'/clear or /clr : removes all visible messsages on your screen. (others can still see them)',
				//./export is handled client side
				"/export : returns your GUID for later importing on other devices. if you like your name don't share it :)",
				'/import : import a GUID exported earlier to reclaim your nickname. must match exactly!',
				'/afk <status> : toggle AFK status in the user listing, and sets status if one is provided.',
				'/status or /me : set your status in the user listing',
				'/background or /bg : set your background image. use /bgreset to clear',
				'/gdpr <flag> : <info> for more information, <export> for a copy of your data, and <delete> to wipe your data.',
			];

			if(this.deps.markovService){
				helpMessages.push(
					`/markov or /${markovNick} <seed> : generate random markov chain, optionally starting with <seed>.`
				);
			}

			helpMessages.push(
				'',
				'the button with the smiley face shows available emotes. click to add to your message!',
				'the button with the silhouettes closes the user status bar. useful on mobile!'
			);

			if (ctx.commandUser?.isMod) {
				helpMessages.push(
					'',
					'--- Moderator Commands ---',
					'/announce or /announcement <text> : Send an announcement to all users.',
					'/ban <user> : Permanently IP bans a user with nickname "user" - huge pain to reverse so no jokes',
					`/timeout or /to <user> <#> : Mutes nickname "user" for # seconds. defaults to ${config.timeoutDef} seconds if blank`,
					'/delete <1> : Delete a message with ID 1.',
					'/emotes <emotesetID> : adds an emote set from 7tv. leave blank to reload from config',
					'/unemotes <emotesetID> : remove all emotes whose names match an emote set from 7tv. consider using /emotes after to reload baseline emotes',
					'/loadusers : reload users from disk. locks server thread while doing it, so only call if you know what you are doing'
				);
				if(this.deps.markovService){
					helpMessages.push(
						'/botstatus <status> : set the status for the markov bot',
						'/botsleep : puts the markov bot to sleep, disabling calls, or wakes him up if asleep'
					)
				}
			}


			const formatTable = helpMessages.join('\n');
			this.deps.messageService.sendSys(ctx.socket, mType.info, formatTable);
			return true;
		};

		this.commands['nick'] = async (ctx) => {
			const newNick = ctx.fullArgs

			if(ctx.commandUser){
				try{
					const oldNick = ctx.commandUser.nick.substring(7)
					const safe = this.deps.moderationService.textCheck(newNick, ctx.commandUser, 'nick');
					const user = this.deps.identityService.setNick(ctx.commandUser.guid, safe);
					this.deps.stateService.updateSocketUser(ctx.io, ctx.socket.id, user);
					this.deps.messageService.send(ctx.socket, mType.identity, user);
					this.deps.messageService.sendSys(ctx.io, mType.ann, `${oldNick} changed their username to ${user.nick.substring(7)}`);
					return true;
				} 
				catch (e: any) {
				this.deps.messageService.sendSys(ctx.socket, mType.error, `system: ${e.message}`);
				return false;
				}
			}
			else{
				try{
					const safe = this.deps.moderationService.textCheckNewUser(newNick, 'nick');
					this.deps.messageService.sendSys(ctx.socket, mType.info, `creating user...`);
					const batch = await this.deps.stateService.signupQueue(ctx.socket, safe);
					if(batch){
						const user = this.deps.identityService.setNick(ctx.commandUser, safe);
						this.deps.stateService.updateSocketUser(ctx.io, ctx.socket.id, user);
						this.deps.messageService.send(ctx.socket, mType.identity, user);
						this.deps.messageService.sendSys(ctx.socket, mType.info, 'system: your new identity has been loaded. consider using /export to save for later use')
						this.deps.messageService.sendSys(ctx.io, mType.ann, `${user.nick.substring(7)} has joined teh ratchat`);
						return true;
					}
					else{
						this.deps.messageService.sendSys(ctx.socket, mType.error, "system: username signup error. please try again");
						return false;
					}
				}
				catch (e: any) {
				this.deps.messageService.sendSys(ctx.socket, mType.error, `system: ${e.message}`);
				return false;
				}
			}
		};

		this.commands['color'] = (ctx) => {
			if (!ctx.commandUser){
				this.deps.messageService.sendSys(ctx.socket, mType.error, "system: please use /chrat <nickname> before trying to set a color");
				return true;
			}
			try{
				const safe = this.deps.moderationService.textCheck(ctx.args[0], ctx.commandUser, 'color');
				const user = this.deps.identityService.setColor(ctx.commandUser.guid, safe);

				this.deps.stateService.updateSocketUser(ctx.io, ctx.socket.id, user,);
				this.deps.messageService.send(ctx.socket, mType.identity, user);
				this.deps.messageService.sendSys(ctx.socket, mType.info, `system: your color has been updated to ${user.nick.substring(0,7)}`);

				return true;
			}
			catch (e: any) {
				this.deps.messageService.sendSys(ctx.socket, mType.error, `system: ${e.message}`);
				return false;
			}
		};
		
		//anti-canadian trap
		this.commands['colour'] = (ctx) => {
			this.deps.messageService.sendSys(ctx.socket, mType.error, "system: lern to speak american");
			return false;
		}

		this.commands['import'] = (ctx) => {
			//check arg is legitimate GUID
			const newGUID = ctx.args[0];
			const GUIDregex = new RegExp("^[{]?[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}[}]?$");
			
			if (!GUIDregex.test(newGUID)) {
				this.deps.messageService.sendSys(ctx.socket, mType.error, "system: not a valid GUID");
				return false;
			}

			try {
				const updatedUser = this.deps.identityService.getUser(newGUID);

				this.deps.stateService.updateSocketUser(ctx.io, ctx.socket.id, updatedUser);
				this.deps.messageService.send(ctx.socket, mType.identity, updatedUser);
				this.deps.messageService.sendSys(ctx.socket, mType.info, `system: identity changed to ${updatedUser.nick.substring(7)}`);
				
				//if existing user show them disconnecting
				if (ctx.commandUser) {
					this.deps.messageService.sendSys(ctx.io, mType.ann, `${ctx.commandUser.nick.substring(7)} disconnected`);
				}

				this.deps.messageService.sendSys(ctx.io, mType.ann, `${updatedUser.nick.substring(7)} connected`);
				
				return true;
			} catch (e: any) {
				this.deps.messageService.sendSys(ctx.socket, mType.error, `system: ${e.message}`);
				return false;
			}
		};

		this.commands['afk'] = (ctx) => {
			if (!ctx.commandUser){
				this.deps.messageService.sendSys(ctx.socket, mType.error, "system: please use /chrat <nickname> before trying to go afk lmao");
				return true;
			} 
			
			try {
				this.deps.moderationService.timeCheck(ctx.commandUser, tType.other);
				const afkUser = this.deps.identityService.toggleAfk(ctx.commandUser.guid);
				

				this.deps.stateService.updateSocketUser(ctx.io, ctx.socket.id, afkUser);
				this.deps.messageService.sendSys(ctx.socket, mType.info, afkUser.isAfk ? "you've gone afk" : `welcome back, ${afkUser.nick.substring(7)}`);

				if(ctx.fullArgs && ctx.fullArgs.trim().length > 0){
					return this.commands['status'](ctx);
				}
			
				return true;
			} catch (e: any) {
				this.deps.messageService.sendSys(ctx.socket, mType.error, `system: ${e.message}`);
				return false;
			}
		};

		this.commands['status'] = (ctx) => {
			if (!ctx.commandUser){
				this.deps.messageService.sendSys(ctx.socket, mType.error, "system: please use /chrat <nickname> before trying to facebook post");
				return true;
			}
			try{
				const safe = this.deps.moderationService.textCheck(ctx.fullArgs, ctx.commandUser, 'status');
				const user = this.deps.identityService.setStatus(ctx.commandUser.guid, safe);

				this.deps.stateService.updateSocketUser(ctx.io, ctx.socket.id, user);
				this.deps.messageService.sendSys(ctx.socket, mType.info, `your status is now: ${user.status}`);
				
				return true;

			}
			catch (e: any) {
				this.deps.messageService.sendSys(ctx.socket, mType.error, `system: ${e.message}`);
				return false;
			}
		};

		this.commands['gdpr'] = (ctx) => {
			const subComm = ctx.args[0];
			switch (subComm) {
				case 'info':
					const infoMsgs = [
						'---------------------------------------------------------------------------------------------',
						'We store the following data server side:',
						'guid			|	Unique identifier and allows multiple sessions to have the same nickname',
						'nick			|	Chosen nickname and color set by the /nick and /color commands',
						'lastChanged	|	Timestamp of when nickname was last changed to prevent nick abuse',
						'status			|	Chosen status displayed in user listing set by /status command',
						'isMod			|	Flag for allowing moderator actions',
						'lastMessage	|	Timestamp of last message sent for timeout enforcement and nickname cleanup',
						'isAfk			|	AFK flag for user listing set by /afk command',
						'---------------------------------------------------------------------------------------------',
						'We store the following information locally:',
						'ratGUID		|	a local copy of the GUID for message construction',
						'ratBG			|	a local version of image selected for background image (not sent to server)',
						'ratMode		| 	a local indicator if dark mode is enabled for client appearence',
						'---------------------------------------------------------------------------------------------',
					];
					if(this.deps.stateService.getMarkovConfig().learning){
						infoMsgs.push(
							'This server uses an optional Markov chain feature that learns from user chat messages.',
							'Messages are stripped of usernames and fully deconstructed into anonymous word fragments before being saved.',
							'No identifiable or reconstructable message information is saved. No authors, no timestamps, no messsage history, etc.',
							'As such, portions of your messages may be used as Markov chain text in an anonymous capacity consistent with Recital 26 of the GDPR.',
							'---------------------------------------------------------------------------------------------',
						);
					}

					infoMsgs.push(
					'Use /gdpr info to see this message again',
					'Use /gdpr ip to see specific information on how and why we use IP addresses',
					'Use /gdpr export to see a copy of your data stored on the server, if any.',
					'Use /gdpr delete to permanently remove your data from the server. this will prevent you from utilizing the application.',
					'---------------------------------------------------------------------------------------------',
					);

					const formatTable = infoMsgs.join('\n');
					this.deps.messageService.sendSys(ctx.socket, mType.info, formatTable);
					return true;
				case 'ip':
					const ipMsgs = [
						'---------------------------------------------------------------------------------------------',
						'We utilize IP addresses for ban enforcement and system protection as allowed under Article 6(1)(f) of the GDPR to protect the service from spam and abuse.',
						'These IP addresses are only stored long term in the event of a ban from bad behavior.',
						'An IP address is stored only with a timestamp. This timestamp is to allow a review process to reverse bans after an amount of time.',
						'If an IP address is stored, it is rendered human unreadable by a one way salted cryptography hash. A "plain-text" IP address is never stored.',
						'Any time a user connects, their IP is hashed in the same way and compared to the stored bans.',
						'An IP address is only linked to a user at the instant of banning in order to select the correct IP to ban. This linkage is not stored.',
						'---------------------------------------------------------------------------------------------'
					];
					const formatIpTable = ipMsgs.join('\n');
					this.deps.messageService.sendSys(ctx.socket, mType.info, formatIpTable);
					return true;

				case 'export':
					if (!ctx.commandUser){
						this.deps.messageService.sendSys(ctx.socket, mType.error, "system: no server stored data");
						return true;
					}

					this.deps.messageService.sendSys(ctx.socket, mType.info, `Server stored info: ${JSON.stringify(ctx.commandUser, null, 4)}`);
					return true;

				case 'delete':
					if (!ctx.commandUser){
						this.deps.messageService.sendSys(ctx.socket, mType.error, "system: no server stored data");
						return true;
					}

					try {
						const targetGuid = ctx.commandUser.guid;
						const targetNick = ctx.commandUser.nick;
				
						// Local deletion ID
						const sentinelId = { guid: 'RESET_IDENTITY' } as Identity;
						
						//iterate through all sockets to find matches
						const allSockets = ctx.io.sockets.sockets;
						allSockets.forEach((socket) => {
							const mappedUser = this.deps.stateService.getSocketUsers().get(socket.id);
							if(mappedUser && mappedUser.guid === targetGuid){
								this.deps.messageService.send(socket, mType.identity, sentinelId);
								this.deps.stateService.updateSocketUser(ctx.io, socket.id, ctx.commandUser!);
								this.deps.messageService.sendSys(socket, mType.info, 'goodbye is ur data');
							}

						});

						this.deps.identityService.deleteUser(targetGuid);
						this.deps.messageService.sendSys(ctx.io, mType.ann, `${targetNick.substring(7)} disconnected`);
						return true;

					} catch (e: any) {
						this.deps.messageService.sendSys(ctx.socket, mType.error, `system: ${e.message}`);
						return false;
					}

				default:
					this.deps.messageService.sendSys(ctx.socket, mType.error, "system: please use with 'info', 'ip', 'export' or 'delete' after /gdpr");
					return false;
			}
		};

		this.commands['markov'] = async (ctx) => {
				if(!this.deps.markovService){
					this.deps.messageService.sendSys(ctx.socket, mType.error, "system: that's not a command lol");
					return false;
				}
				if (!ctx.commandUser){
					this.deps.messageService.sendSys(ctx.socket, mType.error, "system: please use /chrat <nickname> before trying to generate random text");
					return true;
				}
				try{
					this.deps.moderationService.timeCheck(ctx.commandUser, tType.chat);
				}
				catch(e:any){
					this.deps.messageService.sendSys(ctx.socket, mType.error, `system: ${e.message}`);
					return false;
				}

				const markovUser = this.deps.stateService.markovUser;
				if(!markovUser){
					this.deps.messageService.sendSys(ctx.socket, mType.error, "system: we couldn't find a markov bot");
					return true;
				}

				if(this.deps.stateService.markovSleep){
					this.deps.messageService.sendSys(ctx.socket, mType.error, `shh, ${markovUser.nick.substring(7)} is sleeping`);
					return true;
				}

				if(!ctx.commandUser.isMod){
					if(markovUser.isAfk){
						this.deps.messageService.sendSys(ctx.socket, mType.error, `${markovNick} needs a cooldown`)
						return false;
					}		
				}

				try{
					let seed = ''
					if(ctx.args[0]){
						seed = this.deps.moderationService.textCheck(ctx.args[0], ctx.commandUser, tType.chat);
					}
					this.deps.messageService.sendSys(ctx.socket, mType.info, 'generating markov text...');
					const gentext = await this.deps.markovService.markovGen(ctx.io, seed);
					this.deps.messageService.sendMarkov(ctx.io, gentext, markovUser, ctx.commandUser, seed);
					if(!ctx.commandUser.isMod){
						this.deps.stateService.toggleMarkov(ctx.io);
					}
					return true;

				}
				catch (e: any) {
					this.deps.messageService.sendSys(ctx.socket, mType.error, `system: ${e.message}`);
					this.deps.identityService.setLastMessage(ctx.commandUser.guid, Date.now());
					return false;
				}
		};

		// ------------------------------------------------------------------
		// MODERATOR COMMANDS
		// ------------------------------------------------------------------

		this.commands['announce'] = (ctx) => {
			if (!ctx.commandUser?.isMod){
				this.deps.messageService.sendSys(ctx.socket, mType.error, "naughty naughty");
				return true;
			}
			try{
				const safe = this.deps.moderationService.textCheck(ctx.fullArgs, ctx.commandUser, 'chat');
				this.deps.stateService.setAnnouncement(ctx.io, safe)
				if(safe.length === 0){
					this.deps.messageService.sendSys(ctx.socket, mType.info, 'announcement cleared');
				}
				return true;
			}
			catch(e: any){
				this.deps.messageService.sendSys(ctx.socket, mType.error, `system: ${e.message}`)
				return false;
			}
		};

		this.commands['ban'] = (ctx) => {
			if (!ctx.commandUser?.isMod){
				this.deps.messageService.sendSys(ctx.socket, mType.error, "naughty naughty");
				return true;
			}
			if (!ctx.args[0]){
				this.deps.messageService.sendSys(ctx.socket, mType.error, "missing target");
				return false;
			}
			
			try{
				const target = this.deps.identityService.getUserByNick(ctx.fullArgs);
				const msgArray: number[] = []
				for (const [id, msg] of this.deps.messageService.getChatHistory()){
					const msgNick = msg.author.substring(7);
					if(msgNick.toLowerCase() === target.nick.toLowerCase()){
						msgArray.push(id);
					}
				}

				//delete messages if any
				if (msgArray.length > 0){
					this.deps.messageService.deleteMessage(ctx.io, msgArray);
				}
				
				this.deps.securityService.banUser(target);
			}
			catch(e: any){
				this.deps.messageService.sendSys(ctx.socket, mType.error, e.message);
				return false;
			}

			this.deps.messageService.sendSys(ctx.io, mType.info, `${ctx.fullArgs} has been banned.`);
			return true;
		};

		this.commands['timeout'] = (ctx) => {
			if (!ctx.commandUser?.isMod){
				this.deps.messageService.sendSys(ctx.socket, mType.error, "naughty naughty");
				return true;
			}
			if (!ctx.args[0]){
				this.deps.messageService.sendSys(ctx.socket, mType.error, "missing target");
				return false;
			}

			const targetNick = ctx.args[0]
			try{
				const targetUser = this.deps.identityService.getUserByNick(targetNick)
				
				//set duration in seconds
				const durationInput = parseInt(ctx.args[1]);
				const duration = isNaN(durationInput) || durationInput <0 ? 300 : durationInput;
				const now = Date.now();
				const maxAllowed = 30*24*60*60*1000

				//apply the timeout to the future
				let unMute = now + (duration * 1000);
				
				if(unMute > now + maxAllowed){
					unMute = now + maxAllowed;
				}

				this.deps.identityService.setLastMessage(targetUser.guid, unMute);

				//messages to delete
				const msgArray: number[] = []
				for (const [id, msg] of this.deps.messageService.getChatHistory()){
					const msgNick = msg.author.substring(7);
					if(msgNick.toLowerCase() === targetNick.toLowerCase()){
						msgArray.push(id);
					}
				}

				//delete messages if any
				if (msgArray.length > 0){
					this.deps.messageService.deleteMessage(ctx.io, msgArray);
				}

				this.deps.messageService.sendSys(ctx.io, mType.info, `${targetNick} has been timed out.`);
				return true;
			} catch(e: any){
				this.deps.messageService.sendSys(ctx.socket, mType.error, `${e.message}`);
				return false; 
			}
		};

		this.commands['delete'] = (ctx) => {
			if (!ctx.commandUser?.isMod){
				this.deps.messageService.sendSys(ctx.socket, mType.error, "naughty naughty");
				return true;
			}

			if (!ctx.args[0] || isNaN(Number(ctx.args[0]))){
				this.deps.messageService.sendSys(ctx.socket, mType.error, "please provide message id");
				return false;
			} 

			const delArray : number[] = [];
			delArray.push(Number(ctx.args[0]));

			this.deps.messageService.deleteMessage(ctx.io,delArray);

			return true;
		};

		this.commands['emotes'] = async (ctx) => {
			if (!ctx.commandUser?.isMod) {
				this.deps.messageService.sendSys(ctx.socket, mType.error, "naughty naughty");
			return true;
			}

			let targetID = ctx.args[0];

			if(targetID){
				this.deps.messageService.sendSys(ctx.socket, mType.info, `fetching new emote set ${targetID}...`);
			}
			else{
				this.deps.messageService.sendSys(ctx.socket, mType.info, 'reloading emotes from config...');
			}

			try{
				const size = await this.deps.stateService.updateEmotes(ctx.io, targetID);
				this.deps.messageService.sendSys(ctx.socket, mType.info, `${size} emotes loaded`);
				return true;
			} catch(e: any){
				this.deps.messageService.sendSys(ctx.socket, mType.error, `system: ${e.message}`);
				return false;
			}
		};

		this.commands['unemotes'] = async (ctx) => {
			if (!ctx.commandUser?.isMod) {
				this.deps.messageService.sendSys(ctx.socket, mType.error, "naughty naughty");
			return true;
			}

			let targetID = ctx.args[0];
			this.deps.messageService.sendSys(ctx.socket, mType.info, `removing emote set ${targetID}...`);
			
			try{
				const size = await this.deps.stateService.removeEmotes(ctx.io, targetID);
				this.deps.messageService.sendSys(ctx.socket, mType.info, `${size} emotes removed`);
				return true;
			} catch(e: any){
				this.deps.messageService.sendSys(ctx.socket, mType.error, `system: ${e.message}`);
				return false;
			}
		};

		this.commands['loadusers'] = (ctx) => {
			if (!ctx.commandUser?.isMod) {
				this.deps.messageService.sendSys(ctx.socket, mType.error, "naughty naughty");
			return true;
			}
			
			try{
				const size = this.deps.identityService.reloadUsers();
				this.deps.messageService.sendSys(ctx.socket, mType.info, `${size} users reloaded`);
				return true;
			} catch(e: any){
				this.deps.messageService.sendSys(ctx.socket, mType.error, `system: ${e.message}`);
				return false;
			}
		};

		this.commands['botstatus'] = (ctx) => {
			if(!this.deps.markovService){
				this.deps.messageService.sendSys(ctx.socket, mType.error, "system: that's not a command lol");
				return false;
			}
			if (!ctx.commandUser?.isMod) {
				this.deps.messageService.sendSys(ctx.socket, mType.error, "naughty naughty");
				return true;
			}

			const markovUser = this.deps.stateService.markovUser;
			if(!markovUser){
				this.deps.messageService.sendSys(ctx.socket, mType.error, "system: we couldn't find a markov bot");
				return false;
			}
			try{
				const safe = this.deps.moderationService.textCheck(ctx.fullArgs, ctx.commandUser, 'status');
				markovUser.status = safe;
				this.deps.stateService.broadcastUsers(ctx.io);
				this.deps.messageService.sendSys(ctx.socket, mType.info, `${markovNick} status is now: ${markovUser.status}`);
				return true;
			} 
			catch(e: any){
				this.deps.messageService.sendSys(ctx.socket, mType.error, `system: ${e.message}`);
				return false;
			}
		};
		
		this.commands['botsleep'] = (ctx) => {
			if(!this.deps.markovService){
				this.deps.messageService.sendSys(ctx.socket, mType.error, "system: that's not a command lol");
				return false;
			}
			if (!ctx.commandUser?.isMod) {
				this.deps.messageService.sendSys(ctx.socket, mType.error, "naughty naughty");
				return true;
			}

			const markovUser = this.deps.stateService.markovUser;
			const markovSleep = this.deps.stateService.sleepMarkov(ctx.io);

			if(!markovUser){
				this.deps.messageService.sendSys(ctx.socket, mType.error, "system: we couldn't find a markov bot");
				return false;
			}

			if(markovSleep){
				this.deps.messageService.sendSys(ctx.socket, mType.info, `${markovNick} is sleepin now. honk shoo`);
				return true;
			}
			else{
				this.deps.messageService.sendSys(ctx.socket, mType.info, `${markovNick} is awake now. rise and grind`);
				return true;
			}
		};
		
		// ------------------------------------------------------------------
		// ALIASES
		// ------------------------------------------------------------------

		this.commands['h'] = this.commands['commands'] = this.commands['help'];
		this.commands['chrat'] = this.commands['nickname'] = this.commands['name'] = this.commands['nick'];
		this.commands['me'] = this.commands['status'];
		this.commands['to'] = this.commands['timeout'];
		this.commands['announcement'] = this.commands['announce'];
		this.commands['emote'] = this.commands ['emotes'];
		this.commands['unemote'] = this.commands ['unemotes'];
		if (!this.commands[markovNick]) {
			this.commands[markovNick] = this.commands['markov'];
		}

	}
}