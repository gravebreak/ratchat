import { Server, Socket } from 'socket.io';

import { tType, mType } from '../../shared/schema';
import type { Command, Identity } from '../../shared/schema';

import { DispatchService } from './dispatch';
import { StateService } from './state';
import { ModerationService } from './moderation';
import { GameIdentityService } from './games/game-identity';
import { IdentityService } from './identity';
import { SecurityService } from './security';
import { MarkovService } from './markov';
import { MessageService } from './message'

import { getDisplayNick, getDisplayColor } from '../utils/format';
import { isValidGUID } from '../utils/input';

const clearInput: boolean = true;
const keepInput: boolean = false;

export interface CommandServiceDependencies {
	dispatchService: DispatchService;
	stateService: StateService;
	gameIdentityService: GameIdentityService;
	moderationService: ModerationService;
	identityService: IdentityService;
	securityService: SecurityService;
	markovService: MarkovService | null;
	messageService: MessageService;
}

export class CommandService {
	private commands: Record<string, (ctx: Command) => boolean | Promise<boolean>> = {};
	private activeCommands: Map<string, boolean> = new Map();
	
	private deps: CommandServiceDependencies;
	constructor(dependencies: CommandServiceDependencies){
		this.deps = dependencies;
		this.registerCommands();
	}

	public async commandHandler(msg: string, socket: Socket, io: Server, userOrUndef?: Identity | undefined): Promise<boolean>{
		const args = msg.slice(1).trim().split(/ +/);
		const commandName = args.shift()?.toLowerCase() || '';
		
		let user = userOrUndef ?? null;

		if(this.activeCommands.get(socket.id)){
			return keepInput;
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

	public getCommands(): string[]{
		return Object.keys(this.commands);
	}

	//execute the command, true to clear 
	private async execute(name: string, ctx: Command): Promise<boolean> {
		const handler = this.commands[name];
		if(handler){
			//true to clear input, false to keep
			return await handler(ctx);
		} else {
			this.deps.dispatchService.sendSystemChat(ctx.socket, mType.error, "system: that's not a command lol");
			return keepInput;
		}
	}

	private registerCommands(){
		let markovNick = 'markov'
		if(this.deps.stateService.markovUser){
			markovNick = getDisplayNick(this.deps.stateService.markovUser.nick);
		}
		
		// ------------------------------------------------------------------
		// STANDARD COMMANDS
		// ------------------------------------------------------------------
		
		this.commands['help'] = (ctx) => {
			const config = this.deps.stateService.getServerConfig();
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
				//./mute and /m are handled client side
				'/mute or /m <event> : suppress minigame announcements from a specific <event>. will not retroactively remove event notfications.',
				'/mute or /m <user> : hide all messages from a <user>. also hides historical messages you may have recieved.',
				'/mute list or /m list : displays a list of all muted users and events',
				'/mute eventlist or /m eventlist : displays a list of events that can be muted',
				//./unmute is handled client side
				'/unmute <user/event> : unmutes a <user> or an <event>. also will unhide hidden messages from <user> that you may have recieved.',
				'/unmute all : unmutes all muted names and events.',
				"/spoiler <text> : wraps your message in a spoiler warning. btw darth vader is luke's dad"
			];

			if(this.deps.markovService){
				if(this.commands[markovNick] === this.commands['markov']){
					helpMessages.push(
						`/markov or /${markovNick} <seed> : generate random markov chain, optionally starting with <seed>.`
					);
				}
				else{
					helpMessages.push(
						`/markov <seed> : generate random markov chain, optionally starting with <seed>.`
					);
				}
			}

			helpMessages.push(
				'',
				'the button with the smiley face shows available emotes. click to add to your message!',
				'the button with the silhouettes closes the user status bar. useful on mobile!'
			);

			if(ctx.commandUser?.isMod){
				helpMessages.push(
					'',
					'--- Moderator Commands ---',
					'/announce or /announcement <text> : Send an announcement to all users.',
					'/ban <user> : Permanently IP bans a user with nickname "user" - huge pain to reverse so no jokes',
					`/timeout or /to <user> <#> : Mutes nickname "user" for # seconds. defaults to ${config.timeoutDef} seconds if blank`,
					"/delete <msgID (#)> : Delete the most recent message with ID <msgID>. If it's not the most recent, fire it off again.",
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
			this.deps.dispatchService.sendSystemChat(ctx.socket, mType.info, formatTable);
			return clearInput;
		}

		this.commands['nick'] = async (ctx) => {
			const newNick = ctx.fullArgs

			if(ctx.commandUser){
				try{
					const oldNick = getDisplayNick(ctx.commandUser.nick)
					const safe = this.deps.moderationService.textCheck(newNick, ctx.commandUser, 'nick');
					const user = this.deps.identityService.setNick(ctx.commandUser.guid, safe);
					this.deps.stateService.updateSocketUser(ctx.io, ctx.socket.id, user);
					this.deps.dispatchService.sendIdentity(ctx.socket, user);
					this.deps.dispatchService.sendSystemChat(ctx.io, mType.ann, `${oldNick} changed their username to ${getDisplayNick(user.nick)}`);
					return clearInput;
				} 
				catch(error: unknown){
					if(error instanceof Error){
						this.deps.dispatchService.sendSystemChat(ctx.socket, mType.error, `system: ${error.message}`);
					} 
					else{
						console.error("Unexpected non-error thrown:", error);
						this.deps.dispatchService.sendSystemChat(ctx.socket, mType.error, `system: unexpected error`);
					}
					return keepInput;
				}
			}
			else{
				try{
					const safe = this.deps.moderationService.textCheckNewUser(newNick, 'nick');
					this.deps.dispatchService.sendSystemChat(ctx.socket, mType.info, `creating user...`);
					const batch = await this.deps.stateService.signupQueue(ctx.socket, safe);
					if(batch){
						const user = this.deps.identityService.setNick(ctx.commandUser, safe);
						this.deps.stateService.updateSocketUser(ctx.io, ctx.socket.id, user);
						this.deps.dispatchService.sendIdentity(ctx.socket, user);
						this.deps.dispatchService.sendSystemChat(ctx.socket, mType.info, 'system: your new identity has been loaded. consider using /export to save for later use')
						this.deps.dispatchService.sendSystemChat(ctx.io, mType.ann, `${getDisplayNick(user.nick)} has joined teh ratchat`);
						return clearInput;
					}
					else{
						this.deps.dispatchService.sendSystemChat(ctx.socket, mType.error, "system: username signup error. please try again");
						return keepInput;
					}
				}
				catch(error: unknown){
					if(error instanceof Error){
						this.deps.dispatchService.sendSystemChat(ctx.socket, mType.error, `system: ${error.message}`);
					} 
					else{
						console.error("Unexpected non-error thrown:", error);
						this.deps.dispatchService.sendSystemChat(ctx.socket, mType.error, `system: unexpected error`);
					}
					return keepInput;
				}
			}
		}

		this.commands['color'] = (ctx) => {
			if(!ctx.commandUser){
				this.deps.dispatchService.sendSystemChat(ctx.socket, mType.error, "system: please use /chrat <nickname> before trying to set a color");
				return clearInput;
			}
			try{
				const safe = this.deps.moderationService.textCheck(ctx.args[0], ctx.commandUser, 'color');
				const user = this.deps.identityService.setColor(ctx.commandUser.guid, safe);

				this.deps.stateService.updateSocketUser(ctx.io, ctx.socket.id, user,);
				this.deps.dispatchService.sendIdentity(ctx.socket, user);
				this.deps.dispatchService.sendSystemChat(ctx.socket, mType.info, `system: your color has been updated to ${getDisplayColor(user.nick)}`);

				return clearInput;
			}
			catch(error: unknown){
				if(error instanceof Error){
					this.deps.dispatchService.sendSystemChat(ctx.socket, mType.error, `system: ${error.message}`);
				} 
				else{
					console.error("Unexpected non-error thrown:", error);
					this.deps.dispatchService.sendSystemChat(ctx.socket, mType.error, `system: unexpected error`);
				}
				return keepInput;
			}
		}
		
		//anti-canadian trap
		this.commands['colour'] = (ctx) => {
			this.deps.dispatchService.sendSystemChat(ctx.socket, mType.error, "system: lern to speak american");
			return keepInput;
		}

		this.commands['import'] = (ctx) => {
			//check arg is legitimate GUID
			const newGUID = ctx.args[0];
			
			if(!isValidGUID(newGUID)){
				this.deps.dispatchService.sendSystemChat(ctx.socket, mType.error, "system: not a valid GUID");
				return keepInput;
			}

			try{
				const updatedUser = this.deps.identityService.getUser(newGUID);

				this.deps.stateService.updateSocketUser(ctx.io, ctx.socket.id, updatedUser);
				this.deps.dispatchService.sendIdentity(ctx.socket, updatedUser);
				this.deps.dispatchService.sendSystemChat(ctx.socket, mType.info, `system: identity changed to ${getDisplayNick(updatedUser.nick)}`);
				
				//if existing user show them disconnecting
				if(ctx.commandUser){
					this.deps.dispatchService.sendSystemChat(ctx.io, mType.ann, `${getDisplayNick(ctx.commandUser.nick)} disconnected`);
				}

				this.deps.dispatchService.sendSystemChat(ctx.io, mType.ann, `${getDisplayNick(updatedUser.nick)} connected`);
				
				return clearInput;
			} 
			catch(error: unknown){
					if(error instanceof Error){
						this.deps.dispatchService.sendSystemChat(ctx.socket, mType.error, `system: ${error.message}`);
					} 
					else{
						console.error("Unexpected non-error thrown:", error);
						this.deps.dispatchService.sendSystemChat(ctx.socket, mType.error, `system: unexpected error`);
					}
				return keepInput;
			}
		}

		this.commands['afk'] = (ctx) => {
			if(!ctx.commandUser){
				this.deps.dispatchService.sendSystemChat(ctx.socket, mType.error, "system: please use /chrat <nickname> before trying to go afk lmao");
				return clearInput;
			} 
			
			try{
				this.deps.moderationService.timeCheck(ctx.commandUser, tType.other);
				const afkUser = this.deps.identityService.toggleAfk(ctx.commandUser.guid);
				

				this.deps.stateService.updateSocketUser(ctx.io, ctx.socket.id, afkUser);
				this.deps.dispatchService.sendSystemChat(ctx.socket, mType.info, afkUser.isAfk ? "you've gone afk" : `welcome back, ${getDisplayNick(afkUser.nick)}`);

				if(ctx.fullArgs && ctx.fullArgs.trim().length > 0){
					return this.commands['status'](ctx);
				}
			
				return clearInput;
			} 
			catch(error: unknown){
				if(error instanceof Error){
					this.deps.dispatchService.sendSystemChat(ctx.socket, mType.error, `system: ${error.message}`);
				} 
				else{
					console.error("Unexpected non-error thrown:", error);
					this.deps.dispatchService.sendSystemChat(ctx.socket, mType.error, `system: unexpected error`);
				}
				return keepInput;
			}
		}

		this.commands['status'] = (ctx) => {
			if(!ctx.commandUser){
				this.deps.dispatchService.sendSystemChat(ctx.socket, mType.error, "system: please use /chrat <nickname> before trying to facebook post");
				return clearInput;
			}
			try{
				const safe = this.deps.moderationService.textCheck(ctx.fullArgs, ctx.commandUser, 'status');
				const user = this.deps.identityService.setStatus(ctx.commandUser.guid, safe);

				this.deps.stateService.updateSocketUser(ctx.io, ctx.socket.id, user);
				this.deps.dispatchService.sendSystemChat(ctx.socket, mType.info, `your status is now: ${user.status}`);
				
				return clearInput;

			}
			catch(error: unknown){
				if(error instanceof Error){
					this.deps.dispatchService.sendSystemChat(ctx.socket, mType.error, `system: ${error.message}`);
				} 
				else{
					console.error("Unexpected non-error thrown:", error);
					this.deps.dispatchService.sendSystemChat(ctx.socket, mType.error, `system: unexpected error`);
				}
				return keepInput;
			}
		}

		this.commands['gdpr'] = (ctx) => {
			const subComm = ctx.args[0];
			switch (subComm){
				case 'info':
					const config = this.deps.stateService.getServerConfig();
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
						`chatHistory	|	Up to ${config.msgArrayLen} messages are temporarily cached for session contintunity and automatically expire after ${config.msgArrayTimeout} seconds.`,
						'---------------------------------------------------------------------------------------------',
						'We also store some data for minigames server side:',
						'gamePoints		|	A number representing the minigame points earned',
						'lastGame		|	Timestamp of when the last time locked minigame was played to prevent spam',
						'---------------------------------------------------------------------------------------------',
						'We store the following information locally:',
						'ratGUID		|	a local copy of the GUID for message construction',
						'ratBG			|	a local version of image selected for background image (not sent to server)',
						'ratMode		| 	a local indicator if dark mode is enabled for client appearence',
						'ratMutedUsers	|	a local list of usernames whose messages are hidden by default in the client',
						'ratMutedEvents	|	a local list of minigame events whose announcements are ignored',
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
					this.deps.dispatchService.sendSystemChat(ctx.socket, mType.info, formatTable);
					return clearInput;
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
					this.deps.dispatchService.sendSystemChat(ctx.socket, mType.info, formatIpTable);
					return clearInput;

				case 'export':
					if(!ctx.commandUser){
						this.deps.dispatchService.sendSystemChat(ctx.socket, mType.error, "system: no server stored data");
						return clearInput;
					}
					const user = this.deps.identityService.getUser(ctx.commandUser.guid);
					const gameUser = this.deps.gameIdentityService.getGameUser(ctx.commandUser.guid);

					this.deps.dispatchService.sendSystemChat(ctx.socket, mType.info, `Server stored user info: ${JSON.stringify(user, null, 4)}`);
					this.deps.dispatchService.sendSystemChat(ctx.socket, mType.info, `Server stored game info: ${JSON.stringify(gameUser, null, 4)}`);
					return clearInput;

				case 'delete':
					if(!ctx.commandUser){
						this.deps.dispatchService.sendSystemChat(ctx.socket, mType.error, "system: no server stored data");
						return clearInput;
					}
					if(ctx.args[1] !== 'confirm'){
						this.deps.dispatchService.sendSystemChat(ctx.socket, mType.error, "warning: this will permanently delete your account and all server-side data. type '/gdpr delete confirm' to proceed.");
						return keepInput;
					}

					try{
						const targetGuid = ctx.commandUser.guid;
						const targetNick = ctx.commandUser.nick;

						try{
							this.deps.identityService.deleteUser(targetGuid);
							this.deps.dispatchService.sendSystemChat(ctx.socket, mType.info, 'Your server side data has been deleted.');
						}
						catch(error: unknown){
							if(error instanceof Error){
								this.deps.dispatchService.sendSystemChat(ctx.socket, mType.info, 'No server side data found.');
							} 
							else{
								console.error("Unexpected non-error thrown:", error);
								this.deps.dispatchService.sendSystemChat(ctx.socket, mType.error, `system: unexpected error`);
								return keepInput;
							}
						}

						//iterate through all sockets to find matches
						const allSockets = ctx.io.sockets.sockets;
						allSockets.forEach((socket) => {
							const mappedUser = this.deps.stateService.getSocketUsers().get(socket.id);
							if(mappedUser && mappedUser.guid === targetGuid){
								this.deps.dispatchService.sendClearLocalData(socket, targetGuid);
								this.deps.stateService.deleteSocketUser(ctx.io, socket.id);
							}
						});

						this.deps.dispatchService.sendSystemChat(ctx.io, mType.ann, `${getDisplayNick(targetNick)} disconnected`);
						return clearInput;

					} 
					catch(error: unknown){
						if(error instanceof Error){
							this.deps.dispatchService.sendSystemChat(ctx.socket, mType.error, `system: ${error.message}`);
						} 
						else{
							console.error("Unexpected non-error thrown:", error);
							this.deps.dispatchService.sendSystemChat(ctx.socket, mType.error, `system: unexpected error`);
						}
						return keepInput;
					}
				default:
					this.deps.dispatchService.sendSystemChat(ctx.socket, mType.error, "system: please use with 'info', 'ip', 'export' or 'delete' after /gdpr");
					return keepInput;
			}
		}

		this.commands['markov'] = async (ctx) => {
				if(!this.deps.markovService){
					this.deps.dispatchService.sendSystemChat(ctx.socket, mType.error, "system: that's not a command lol");
					return keepInput;
				}
				if(!ctx.commandUser){
					this.deps.dispatchService.sendSystemChat(ctx.socket, mType.error, "system: please use /chrat <nickname> before trying to generate random text");
					return clearInput;
				}
				try{
					this.deps.moderationService.timeCheck(ctx.commandUser, tType.chat);
				}
				catch(error: unknown){
					if(error instanceof Error){
						this.deps.dispatchService.sendSystemChat(ctx.socket, mType.error, `system: ${error.message}`);
					} 
					else{
						console.error("Unexpected non-error thrown:", error);
						this.deps.dispatchService.sendSystemChat(ctx.socket, mType.error, `system: unexpected error`);
					}
					return keepInput;
				}

				const markovUser = this.deps.stateService.markovUser;
				if(!markovUser){
					this.deps.dispatchService.sendSystemChat(ctx.socket, mType.error, "system: we couldn't find a markov bot");
					return clearInput;
				}

				if(this.deps.stateService.markovSleep){
					this.deps.dispatchService.sendSystemChat(ctx.socket, mType.error, `shh, ${getDisplayNick(markovUser.nick)} is sleeping`);
					return clearInput;
				}

				if(!ctx.commandUser.isMod){
					if(markovUser.isAfk){
						this.deps.dispatchService.sendSystemChat(ctx.socket, mType.error, `${markovNick} needs a cooldown`)
						return keepInput;
					}		
				}

				try{
					let seed = ''
					if(ctx.args[0]){
						seed = this.deps.moderationService.textCheck(ctx.args[0], ctx.commandUser, tType.chat);
					}
					this.deps.dispatchService.sendSystemChat(ctx.socket, mType.info, 'generating markov text...');
					const gentext = await this.deps.markovService.markovGen(ctx.io, seed);
					this.deps.dispatchService.sendMarkovChat(ctx.io, gentext, markovUser, ctx.commandUser, seed);
					if(!ctx.commandUser.isMod){
						this.deps.stateService.toggleMarkov(ctx.io);
					}
					return clearInput;

				}
				catch(error: unknown){
					if(error instanceof Error){
						this.deps.dispatchService.sendSystemChat(ctx.socket, mType.error, `system: ${error.message}`);
					} 
					else{
						console.error("Unexpected non-error thrown:", error);
						this.deps.dispatchService.sendSystemChat(ctx.socket, mType.error, `system: unexpected error`);
					}
					this.deps.identityService.setLastMessage(ctx.commandUser.guid, Date.now());
					return keepInput;
				}
		}

		this.commands['spoiler'] = (ctx) => {
			if(!ctx.commandUser){
				this.deps.dispatchService.sendSystemChat(ctx.socket, mType.error, "system: please use /chrat <nickname> before chatting");
				return clearInput;
			}
			return this.deps.messageService.handleChat(ctx.fullArgs, ctx.commandUser, ctx.socket, true);
		}

		// ------------------------------------------------------------------
		// MODERATOR COMMANDS
		// ------------------------------------------------------------------

		this.commands['announce'] = (ctx) => {
			if(!ctx.commandUser?.isMod){
				this.deps.dispatchService.sendSystemChat(ctx.socket, mType.error, "naughty naughty");
				return clearInput;
			}
			try{
				const safe = this.deps.moderationService.textCheck(ctx.fullArgs, ctx.commandUser, 'chat');
				this.deps.stateService.setAnnouncement(ctx.io, safe)
				if(safe.length === 0){
					this.deps.dispatchService.sendSystemChat(ctx.socket, mType.info, 'announcement cleared');
				}
				return clearInput;
			}
			catch(error: unknown){
				if(error instanceof Error){
					this.deps.dispatchService.sendSystemChat(ctx.socket, mType.error, `system: ${error.message}`);
				} 
				else{
					console.error("Unexpected non-error thrown:", error);
					this.deps.dispatchService.sendSystemChat(ctx.socket, mType.error, `system: unexpected error`);
				}
				return keepInput;
			}
		}

		this.commands['ban'] = (ctx) => {
			if(!ctx.commandUser?.isMod){
				this.deps.dispatchService.sendSystemChat(ctx.socket, mType.error, "naughty naughty");
				return clearInput;
			}
			if(!ctx.args[0]){
				this.deps.dispatchService.sendSystemChat(ctx.socket, mType.error, "missing target");
				return keepInput;
			}
			
			try{
				const target = this.deps.identityService.getUserByNick(ctx.fullArgs);
				const msgArray: number[] = []
				for (const [id, msg] of this.deps.dispatchService.getChatHistory()){
					const msgNick = getDisplayNick(msg.author);
					if(msgNick.toLowerCase() === target.nick.toLowerCase()){
						msgArray.push(id);
					}
				}

				//delete messages if any
				if(msgArray.length > 0){
					this.deps.dispatchService.deleteMessage(ctx.io, msgArray);
				}
				
				this.deps.securityService.banUser(target);
			}
			catch(error: unknown){
				if(error instanceof Error){
					this.deps.dispatchService.sendSystemChat(ctx.socket, mType.error, `system: ${error.message}`);
				} 
				else{
					console.error("Unexpected non-error thrown:", error);
					this.deps.dispatchService.sendSystemChat(ctx.socket, mType.error, `system: unexpected error`);
				}
				return keepInput;
			}

			this.deps.dispatchService.sendSystemChat(ctx.io, mType.info, `${ctx.fullArgs} has been banned.`);
			return clearInput;
		}

		this.commands['timeout'] = (ctx) => {
			if(!ctx.commandUser?.isMod){
				this.deps.dispatchService.sendSystemChat(ctx.socket, mType.error, "naughty naughty");
				return clearInput;
			}
			if(!ctx.args[0]){
				this.deps.dispatchService.sendSystemChat(ctx.socket, mType.error, "missing target");
				return keepInput;
			}

			const targetNick = ctx.args[0]
			try{
				const targetUser = this.deps.identityService.getUserByNick(targetNick)
				const config = this.deps.stateService.getServerConfig();
				
				//set duration in seconds
				const durationInput = parseInt(ctx.args[1]);
				const duration = isNaN(durationInput) || durationInput <0 ? config.timeoutDef : durationInput;
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
				for (const [id, msg] of this.deps.dispatchService.getChatHistory()){
					const msgNick = getDisplayNick(msg.author);
					if(msgNick.toLowerCase() === targetNick.toLowerCase()){
						msgArray.push(id);
					}
				}

				//delete messages if any
				if(msgArray.length > 0){
					this.deps.dispatchService.deleteMessage(ctx.io, msgArray);
				}

				this.deps.dispatchService.sendSystemChat(ctx.io, mType.info, `${targetNick} has been timed out.`);
				return clearInput;
			} 
			catch(error: unknown){
				if(error instanceof Error){
					this.deps.dispatchService.sendSystemChat(ctx.socket, mType.error, `system: ${error.message}`);
				} 
				else{
					console.error("Unexpected non-error thrown:", error);
					this.deps.dispatchService.sendSystemChat(ctx.socket, mType.error, `system: unexpected error`);
				}
				return keepInput; 
			}
		}

		this.commands['delete'] = (ctx) => {
			if(!ctx.commandUser?.isMod){
				this.deps.dispatchService.sendSystemChat(ctx.socket, mType.error, "naughty naughty");
				return clearInput;
			}
			
			const id = Number(ctx.args[0]);

			if(!ctx.args[0] || isNaN(id) || id < 0){
				this.deps.dispatchService.sendSystemChat(ctx.socket, mType.error, "please provide a valid message id");
				return keepInput;
			}

			this.deps.dispatchService.deleteMessage(ctx.io, [id]);

			return clearInput;
		}

		this.commands['emotes'] = async (ctx) => {
			if(!ctx.commandUser?.isMod){
				this.deps.dispatchService.sendSystemChat(ctx.socket, mType.error, "naughty naughty");
			return clearInput;
			}

			let targetID = ctx.args[0];

			if(targetID){
				this.deps.dispatchService.sendSystemChat(ctx.socket, mType.info, `fetching new emote set ${targetID}...`);
			}
			else{
				this.deps.dispatchService.sendSystemChat(ctx.socket, mType.info, 'reloading emotes from config...');
			}

			try{
				const size = await this.deps.stateService.updateEmotes(ctx.io, targetID);
				this.deps.dispatchService.sendSystemChat(ctx.socket, mType.info, `${size} emotes loaded`);
				return clearInput;
			} 
			catch(error: unknown){
				if(error instanceof Error){
					this.deps.dispatchService.sendSystemChat(ctx.socket, mType.error, `system: ${error.message}`);
				} 
				else{
					console.error("Unexpected non-error thrown:", error);
					this.deps.dispatchService.sendSystemChat(ctx.socket, mType.error, `system: unexpected error`);
				}
				return keepInput;
			}
		}

		this.commands['unemotes'] = async (ctx) => {
			if(!ctx.commandUser?.isMod){
				this.deps.dispatchService.sendSystemChat(ctx.socket, mType.error, "naughty naughty");
			return clearInput;
			}

			let targetID = ctx.args[0];
			this.deps.dispatchService.sendSystemChat(ctx.socket, mType.info, `removing emote set ${targetID}...`);
			
			try{
				const size = await this.deps.stateService.removeEmotes(ctx.io, targetID);
				this.deps.dispatchService.sendSystemChat(ctx.socket, mType.info, `${size} emotes removed`);
				return clearInput;
			} 
			catch(error: unknown){
				if(error instanceof Error){
					this.deps.dispatchService.sendSystemChat(ctx.socket, mType.error, `system: ${error.message}`);
				} 
				else{
					console.error("Unexpected non-error thrown:", error);
					this.deps.dispatchService.sendSystemChat(ctx.socket, mType.error, `system: unexpected error`);
				}
				return keepInput;
			}
		}

		this.commands['loadusers'] = (ctx) => {
			if(!ctx.commandUser?.isMod){
				this.deps.dispatchService.sendSystemChat(ctx.socket, mType.error, "naughty naughty");
			return clearInput;
			}
			
			try{
				const size = this.deps.identityService.reloadUsers();
				this.deps.dispatchService.sendSystemChat(ctx.socket, mType.info, `${size} users reloaded`);
				const gameSize = this.deps.gameIdentityService.reloadGameUsers();
				this.deps.dispatchService.sendSystemChat(ctx.socket, mType.info, `${gameSize} game users reloaded`)
				return clearInput;
			} 
			catch(error: unknown){
				if(error instanceof Error){
					this.deps.dispatchService.sendSystemChat(ctx.socket, mType.error, `system: ${error.message}`);
				} 
				else{
					console.error("Unexpected non-error thrown:", error);
					this.deps.dispatchService.sendSystemChat(ctx.socket, mType.error, `system: unexpected error`);
				}
				return keepInput;
			}
		}

		this.commands['botstatus'] = (ctx) => {
			if(!this.deps.markovService){
				this.deps.dispatchService.sendSystemChat(ctx.socket, mType.error, "system: that's not a command lol");
				return keepInput;
			}
			if(!ctx.commandUser?.isMod){
				this.deps.dispatchService.sendSystemChat(ctx.socket, mType.error, "naughty naughty");
				return clearInput;
			}

			const markovUser = this.deps.stateService.markovUser;
			if(!markovUser){
				this.deps.dispatchService.sendSystemChat(ctx.socket, mType.error, "system: we couldn't find a markov bot");
				return keepInput;
			}
			try{
				const safe = this.deps.moderationService.textCheck(ctx.fullArgs, ctx.commandUser, 'status');
				markovUser.status = safe;
				this.deps.stateService.broadcastUsers(ctx.io);
				this.deps.dispatchService.sendSystemChat(ctx.socket, mType.info, `${markovNick} status is now: ${markovUser.status}`);
				return clearInput;
			} 
			catch(error: unknown){					
				if(error instanceof Error){
					this.deps.dispatchService.sendSystemChat(ctx.socket, mType.error, `system: ${error.message}`);
				} 
				else{
					console.error("Unexpected non-error thrown:", error);
					this.deps.dispatchService.sendSystemChat(ctx.socket, mType.error, `system: unexpected error`);
				}
				return keepInput;
			}
		}
		
		this.commands['botsleep'] = (ctx) => {
			if(!this.deps.markovService){
				this.deps.dispatchService.sendSystemChat(ctx.socket, mType.error, "system: that's not a command lol");
				return keepInput;
			}
			if(!ctx.commandUser?.isMod){
				this.deps.dispatchService.sendSystemChat(ctx.socket, mType.error, "naughty naughty");
				return clearInput;
			}

			const markovUser = this.deps.stateService.markovUser;
			const markovSleep = this.deps.stateService.sleepMarkov(ctx.io);

			if(!markovUser){
				this.deps.dispatchService.sendSystemChat(ctx.socket, mType.error, "system: we couldn't find a markov bot");
				return keepInput;
			}

			if(markovSleep){
				this.deps.dispatchService.sendSystemChat(ctx.socket, mType.info, `${markovNick} is sleepin now. honk shoo`);
				return clearInput;
			}
			else{
				this.deps.dispatchService.sendSystemChat(ctx.socket, mType.info, `${markovNick} is awake now. rise and grind`);
				return clearInput;
			}
		}
		
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
		if(!this.commands[markovNick]){
			this.commands[markovNick] = this.commands['markov'];
		}

	}
}