import {cType, fType} from '../defs/def-events';
import {keepInput, clearInput} from '../defs/def-input';
import {tType} from '../defs/def-moderation';
import type {Command} from '../defs/def-commands';
import type {RatServer, RatSocket} from '../defs/def-events';
import type {Identity} from '../defs/def-identity';
import type {InputStatus} from '../defs/def-input';

import {ConfigService} from './config';
import {DispatchService} from './dispatch';
import {ModerationService} from './moderation';
import {SecurityService} from './security';
import {GameIdentityService} from './games/game-identity';
import {IdentityService} from './identity';
import {GameStateService} from './games/game-state';
import {StateService} from './state';
import {MarkovService} from './markov';
import {MessageService} from './message';
import {GameCommandService} from './games/game-command';

import {getBaseNick, getNickColor} from '../utils/format';
import {AppError, handleError} from '../utils/errors';
import {isValidGUID} from '../utils/validate';

type CommandEntry = {
	requiresMod: boolean;
	requiresMarkov: boolean;
	handler: (ctx: Command) => InputStatus | Promise<InputStatus>;
}

export interface CommandServiceDependencies {
	configService: ConfigService;
	dispatchService: DispatchService;
	moderationService: ModerationService;
	securityService: SecurityService;
	gameIdentityService: GameIdentityService;
	identityService: IdentityService;
	gameStateService: GameStateService;
	stateService: StateService;
	markovService: MarkovService | null;
	messageService: MessageService;
	gameCommandService: GameCommandService;
}

export class CommandService {
	private commands: Record<string, CommandEntry> = {};
	private activeCommands: Map<RatSocket['id'], boolean> = new Map();
	private gameCommandNames: Set<string> = new Set();
	private markovBaseNick: string = 'markov';

	private deps: CommandServiceDependencies;
	constructor(dependencies: CommandServiceDependencies){
		this.deps = dependencies;
		this.init();
	}

	private init(): void {
		this.initializeMarkovCommand();
		this.initializeCommands();
		this.initializeGameCommands();
	}

	public async handleCommand(msg: string, socket: RatSocket, io: RatServer, caller: Identity | null): Promise<InputStatus>{
		const args = msg.slice(1).trim().split(/ +/);
		const commandName = args.shift()?.toLowerCase() || '';

		if(this.gameCommandNames.has(commandName)){
			if(!this.deps.configService.getGameConfig().enabled){
				return this.sendNotCommand(socket);
			}

			if(caller){
				return await this.deps.gameCommandService.handleGameCommand(msg, socket, io, caller);
			}
			else{
				return this.sendRegistrationWarning(socket, 'game, gamer');
			}
		}

		if(this.activeCommands.get(socket.id)){
			return keepInput;
		}

		this.activeCommands.set(socket.id, true);

		try{
			const result = await this.executeCommand(commandName, {
				socket,
				io,
				args,
				fullArgs: args.join(' '),
				commandUser: caller,
				commandName: commandName
			});

			return result;
		}
		catch(error: unknown){
			this.deps.dispatchService.sendUserErrorMessage(socket, error, `Handle Command: ${commandName}`);
			return keepInput;
		}
		finally{
			this.activeCommands.delete(socket.id);
		}
	}

	public getCommands(): string[]{
		return Object.keys(this.commands);
	}

	private sendRegistrationWarning(socket: RatSocket, action: string = 'do that'): InputStatus {
		const error = new AppError(`please use /chrat <nickname> before trying to ${action}`, 'user');
		this.deps.dispatchService.sendUserErrorMessage(socket, error, 'Registration Warning');
		return clearInput;
	}

	private sendNotCommand(socket: RatSocket): InputStatus {
		const error = new AppError("that's not a command lol", 'user');
		this.deps.dispatchService.sendUserErrorMessage(socket, error, 'Command Service Not Command');
		return keepInput;
	}

	private async executeCommand(name: string, ctx: Command): Promise<InputStatus> {
		const entry = this.commands[name];
		if(!entry){
			return this.sendNotCommand(ctx.socket);
		}

		const noMarkov = !this.deps.markovService;
		const notMod = !ctx.commandUser?.isMod;
		if(entry.requiresMarkov && noMarkov){
			return this.sendNotCommand(ctx.socket);
		}
		if(entry.requiresMod && notMod){
			const error = new AppError('naughty naughty', 'user');
			this.deps.dispatchService.sendUserErrorMessage(ctx.socket, error, 'Command Service Not Mod');
			return clearInput;
		}

		return await entry.handler(ctx);
	}

	private initializeMarkovCommand(): void {
		if(this.deps.configService.getMarkovConfig().enabled && this.deps.stateService.markovUser){
			this.markovBaseNick = getBaseNick(this.deps.stateService.markovUser.fullnick);
		}
		else{
			this.markovBaseNick = 'markov';
		}
	}

	private initializeCommands(): void {
		this.registerStandardCommands();
		this.registerModeratorCommands();
		this.registerGdprCommands();

		this.commands['h'] = this.commands['commands'] = this.commands['help'];
		this.commands['chrat'] = this.commands['nickname'] = this.commands['name'] = this.commands['nick'];
		this.commands['b'] = this.commands['bold'];
		this.commands['me'] = this.commands['i'] = this.commands['italics'];
		this.commands['to'] = this.commands['timeout'];
		this.commands['announcement'] = this.commands['announce'];
		this.commands['emote'] = this.commands['emotes'];
		this.commands['unemote'] = this.commands['unemotes'];
		if(!this.commands[this.markovBaseNick]){
			this.commands[this.markovBaseNick] = this.commands['markov'];
		}
	}

	private registerStandardCommands(): void{
		this.commands['help'] = {
			requiresMod: false,
			requiresMarkov: false,
			handler: (ctx): InputStatus => {

				const helpMessages = [
					'/help, /h, or /commands : View this list.',
					'/mutehelp : information on how to use the /mute and /unmute features.'
				];

				if(ctx.commandUser?.isMod){
					helpMessages.push(
						'/modhelp : see available moderator commands'
					);
				}

				if(this.deps.configService.getGameConfig().enabled){
					helpMessages.push(
						'/gamehelp : See all available minigame commands!'
					);
				}

				helpMessages.push(
					'/chrat or /nick <nickname> : Change your nickname to <nickname>.',
					"/color or /colour <#RRGGBB> : Change your nickname's color to hex #RRGGBB.",
					//./dark handled client side
					'/dark : by popular demand, toggle dark mode!',
					//./clear and /clr are handled client side
					'/clear or /clr : removes all visible messages on your screen. (others can still see them)',
					//./export is handled client side
					"/export : returns your GUID for later importing on other devices. if you like your name don't share it :)",
					'/import : import a GUID exported earlier to reclaim your nickname. must match exactly!',
					'/afk <status> : toggle AFK status in the user listing, and sets status if one is provided.',
					'/status : set your status in the user listing',
					'/b or /bold : send your message with emphasis',
					'/i or /italics : speak softly and carry a big stick',
					'/mono : send your message with monotyped font',
					//./background and /bg handled client side
					'/background or /bg : set your background image. use /bgreset to clear',
					'/gdpr <flag> : <info> or <ip> for more information, <export> for a copy of your data, and <delete> to wipe your data.',
					"/spoiler <text> : wraps your message in a spoiler warning. btw darth vader is luke's dad"
				);

				if(this.deps.markovService){
					if(this.commands[this.markovBaseNick] === this.commands['markov']){
						helpMessages.push(
							`/markov or /${this.markovBaseNick} <seed> : generate random markov chain, optionally starting with <seed>.`
						);
					}
					else{
						helpMessages.push(
							'/markov <seed> : generate random markov chain, optionally starting with <seed>.'
						);
					}
				}

				helpMessages.push(
					'',
					'the button with the smiley face shows available emotes. click to add to your message!',
					'the button with the silhouettes closes the user status bar. useful on mobile!'
				);

				const formatTable = helpMessages.join('\n');
				this.deps.dispatchService.sendSystemChatPayload(ctx.socket, cType.info, formatTable);
				return clearInput;
			}
		};

		this.commands['mutehelp'] = {
			requiresMod: false,
			requiresMarkov: false,
			handler:(ctx): InputStatus => {
				const helpMessages = [
					"/mutehelp : information on how to use the /mute feature. you're looking at it",
					//./mute and /m are handled client side
					'/mute or /m <event> : suppress minigame announcements from a specific <event>. will not retroactively remove event notifications.',
					'/mute or /m <user> : hide all messages from a <user>. also hides historical messages you may have received.',
					'/mute list or /m list : displays a list of all muted users and events',
					'/mute eventlist or /m eventlist : displays a list of events that can be muted',
					'/mute allevents : mute all events',
					//./unmute is handled client side
					'/unmute <user/event> : unmutes a <user> or an <event>. also will unhide hidden messages from <user> that you may have received.',
					'/unmute all : unmutes all muted names and events.',
					'/unmute allevents : unmutes all events. users remain muted',
				];

				const formatTable = helpMessages.join('\n');
				this.deps.dispatchService.sendSystemChatPayload(ctx.socket, cType.info, formatTable);
				return clearInput;
			}
		};

		this.commands['nick'] = {
			requiresMod: false,
			requiresMarkov: false,
			handler: async (ctx): Promise<InputStatus> => {
				const newBaseNick = ctx.fullArgs;

				if(ctx.commandUser){
					try{
						const oldBaseNick = getBaseNick(ctx.commandUser.fullnick);
						const safe = this.deps.moderationService.moderateText(newBaseNick, ctx.commandUser, 'base');
						const user = this.deps.identityService.setBaseNick(ctx.commandUser.guid, safe);
						this.deps.stateService.updateSocketUser(ctx.io, ctx.socket.id, user);
						this.deps.dispatchService.sendIdentityPayload(ctx.socket, user);
						this.deps.dispatchService.sendSystemChatPayload(ctx.io, cType.ann, `${oldBaseNick} changed their username to ${getBaseNick(user.fullnick)}`);
						return clearInput;
					}
					catch(error: unknown){
						this.deps.dispatchService.sendUserErrorMessage(ctx.socket, error, 'Nick Command');
						return keepInput;
					}
				}
				else{
					try{
						const safe = this.deps.moderationService.moderateNewUserBaseNick(newBaseNick, 'base');
						this.deps.dispatchService.sendSystemChatPayload(ctx.socket, cType.info, 'creating user...');
						const batch = await this.deps.stateService.queueSignup(ctx.socket, safe);
						if(batch){
							const user = this.deps.identityService.createNewUser(safe);
							this.deps.stateService.updateSocketUser(ctx.io, ctx.socket.id, user);
							this.deps.dispatchService.sendIdentityPayload(ctx.socket, user);
							this.deps.dispatchService.sendSystemChatPayload(ctx.socket, cType.info, 'system: your new identity has been loaded. consider using /export to save for later use');
							this.deps.dispatchService.sendSystemChatPayload(ctx.io, cType.ann, `${getBaseNick(user.fullnick)} has joined teh ratchat`);
							return clearInput;
						}
						else{
							throw new AppError('username signup error. please try again', 'user');
						}
					}
					catch(error: unknown){
						this.deps.dispatchService.sendUserErrorMessage(ctx.socket, error,'Nick Command New User');
						return keepInput;
					}
				}
			}
		};

		this.commands['color'] = {
			requiresMod: false,
			requiresMarkov: false,
			handler: (ctx): InputStatus => {
				if(!ctx.commandUser){
					return this.sendRegistrationWarning(ctx.socket, 'set a color');
				}
				try{
					const safe = this.deps.moderationService.moderateText(ctx.args[0], ctx.commandUser, 'color');
					const user = this.deps.identityService.setColor(ctx.commandUser.guid, safe);

					this.deps.stateService.updateSocketUser(ctx.io, ctx.socket.id, user);
					this.deps.dispatchService.sendIdentityPayload(ctx.socket, user);
					this.deps.dispatchService.sendSystemChatPayload(ctx.socket, cType.info, `system: your color has been updated to ${getNickColor(user.fullnick)}`);

					return clearInput;
				}
				catch(error: unknown){
					this.deps.dispatchService.sendUserErrorMessage(ctx.socket, error, 'Color Command');
					return keepInput;
				}
			}
		};

		//anti-canadian trap
		this.commands['colour'] = {
			requiresMod: false,
			requiresMarkov: false,
			handler: (ctx): InputStatus => {
				if(!ctx.commandUser){
					return this.sendRegistrationWarning(ctx.socket, 'set a colour');
				}
				const error = new AppError('lern to speak american', 'user');
				this.deps.dispatchService.sendUserErrorMessage(ctx.socket, error, 'Colour Command');
				return keepInput;
			}
		};

		this.commands['import'] = {
			requiresMod: false,
			requiresMarkov: false,
			handler: (ctx): InputStatus => {
				try{
					const newGUID = ctx.args[0];
					if(!isValidGUID(newGUID)){
						throw new AppError('not a valid GUID', 'user');
					}
					const updatedUser = this.deps.identityService.getUser(newGUID);

					this.deps.stateService.updateSocketUser(ctx.io, ctx.socket.id, updatedUser);
					this.deps.dispatchService.sendIdentityPayload(ctx.socket, updatedUser);
					this.deps.dispatchService.sendSystemChatPayload(ctx.socket, cType.info, `system: identity changed to ${getBaseNick(updatedUser.fullnick)}`);

					//if existing user show them disconnecting
					if(ctx.commandUser){
						this.deps.dispatchService.sendSystemChatPayload(ctx.io, cType.ann, `${getBaseNick(ctx.commandUser.fullnick)} disconnected`);
					}

					this.deps.dispatchService.sendSystemChatPayload(ctx.io, cType.ann, `${getBaseNick(updatedUser.fullnick)} connected`);

					return clearInput;
				}
				catch(error: unknown){
					this.deps.dispatchService.sendUserErrorMessage(ctx.socket, error, 'GUID Import Command');
					return keepInput;
				}
			}
		};

		this.commands['afk'] = {
			requiresMod: false,
			requiresMarkov: false,
			handler: async (ctx): Promise<InputStatus> => {
				if(!ctx.commandUser){
					return this.sendRegistrationWarning(ctx.socket, 'go afk lmao');
				}

				try{
					this.deps.moderationService.assertUserNotTimedout(ctx.commandUser);
					this.deps.moderationService.moderateTime(ctx.commandUser.lastChanged, tType.other);
					const afkUser = this.deps.identityService.toggleAfk(ctx.commandUser.guid);

					this.deps.stateService.updateSocketUser(ctx.io, ctx.socket.id, afkUser);
					this.deps.dispatchService.sendSystemChatPayload(ctx.socket, cType.info, afkUser.isAfk ? "you've gone afk" : `welcome back, ${getBaseNick(afkUser.fullnick)}`);

					if(ctx.fullArgs && ctx.fullArgs.trim().length > 0){
						return await this.executeCommand('status', ctx);
					}

					return clearInput;
				}
				catch(error: unknown){
					this.deps.dispatchService.sendUserErrorMessage(ctx.socket, error, 'AFK Command');
					return keepInput;
				}
			}
		};

		this.commands['status'] = {
			requiresMod: false,
			requiresMarkov: false,
			handler: (ctx): InputStatus => {
				if(!ctx.commandUser){
					return this.sendRegistrationWarning(ctx.socket, 'facebook post');
				}
				try{
					const safe = this.deps.moderationService.moderateText(ctx.fullArgs, ctx.commandUser, 'status');
					const user = this.deps.identityService.setStatus(ctx.commandUser.guid, safe);

					this.deps.stateService.updateSocketUser(ctx.io, ctx.socket.id, user);
					this.deps.dispatchService.sendSystemChatPayload(ctx.socket, cType.info, `your status is now: ${user.status}`);

					return clearInput;

				}
				catch(error: unknown){
					this.deps.dispatchService.sendUserErrorMessage(ctx.socket, error, 'Status Command');
					return keepInput;
				}
			}
		};

		this.commands['bold'] = {
			requiresMod: false,
			requiresMarkov: false,
			handler: (ctx): InputStatus => {
				if(!ctx.commandUser){
					return this.sendRegistrationWarning(ctx.socket, 'chat, boldly');
				}
				return this.deps.messageService.handleChat(ctx.fullArgs, ctx.commandUser, ctx.socket, [fType.b], false);
			}
		};

		this.commands['italics'] = {
			requiresMod: false,
			requiresMarkov: false,
			handler: (ctx): InputStatus => {
				if(!ctx.commandUser){
					return this.sendRegistrationWarning(ctx.socket, 'roleplay');
				}
				return this.deps.messageService.handleChat(ctx.fullArgs, ctx.commandUser, ctx.socket, [fType.i], false);
			}
		};

		this.commands['mono'] = {
			requiresMod: false,
			requiresMarkov: false,
			handler: (ctx): InputStatus => {
				if(!ctx.commandUser){
					return this.sendRegistrationWarning(ctx.socket, 'roleplay as a robot');
				}
				return this.deps.messageService.handleChat(ctx.fullArgs, ctx.commandUser, ctx.socket, [fType.mono], false);
			}
		};

		this.commands['spoiler'] = {
			requiresMod: false,
			requiresMarkov: false,
			handler: (ctx): InputStatus => {
				if(!ctx.commandUser){
					return this.sendRegistrationWarning(ctx.socket, 'ruin things for everyone else');
				}
				return this.deps.messageService.handleChat(ctx.fullArgs, ctx.commandUser, ctx.socket, [], true);
			}
		};

		this.commands['markov'] = {
			requiresMod: false,
			requiresMarkov: true,
			handler: async (ctx): Promise<InputStatus> => {
				if(!ctx.commandUser){
					return this.sendRegistrationWarning(ctx.socket, 'generate random text');
				}
				try{
					this.deps.moderationService.assertUserNotTimedout(ctx.commandUser);
					this.deps.moderationService.moderateTime(ctx.commandUser.lastMessage, tType.chat);

					const markovUser = this.deps.stateService.markovUser;
					if(!markovUser){
						throw new AppError("couldn't find a markov bot, please try again", 'user');
					}

					if(this.deps.stateService.markovSleep){
						this.deps.dispatchService.sendSystemChatPayload(ctx.socket, cType.info, `shh, ${getBaseNick(markovUser.fullnick)} is sleeping`);
						return clearInput;
					}

					if(!ctx.commandUser.isMod){
						if(markovUser.isAfk){
							throw new AppError(`${this.markovBaseNick} needs a cooldown`, 'user');
						}
					}

					let seed = '';
					if(ctx.args[0]){
						seed = this.deps.moderationService.moderateText(ctx.args[0], ctx.commandUser, tType.chat);
					}

					if(!this.deps.markovService){
						return this.sendNotCommand(ctx.socket);
					}

					this.deps.dispatchService.sendSystemChatPayload(ctx.socket, cType.info, 'generating markov text...');

					const gentext = await this.deps.markovService.generateMarkovText(ctx.io, seed);
					const format = this.deps.markovService.generateMarkovFormats();
					const spoiler = this.deps.markovService.generateMarkovSpoiler();

					this.deps.dispatchService.sendMarkovChatPayload(ctx.io, gentext, markovUser, ctx.commandUser, format, spoiler, seed);
					if(!ctx.commandUser.isMod){
						this.deps.stateService.toggleMarkov(ctx.io);
					}
					return clearInput;
				}
				catch(error: unknown){
					this.deps.identityService.setLastMessage(ctx.commandUser.guid, Date.now());
					this.deps.dispatchService.sendUserErrorMessage(ctx.socket, error, 'Markov Command Generation');
					return keepInput;
				}
			}
		};
	}

	private registerModeratorCommands(): void {
		this.commands['modhelp'] = {
			requiresMod: true,
			requiresMarkov: false,
			handler: (ctx): InputStatus => {
				const config = this.deps.configService.getServerConfig();

				const helpMessages = [
					'--- Moderator Commands ---',
					'/modhelp : view mod commands. this list. right here.',
					'/announce or /announcement <text> : Send an announcement to all users.',
					`/ban <user> : IP bans a user with nickname "user" for ${config.banLength} days - only the server admin can reverse it so no joke bans`,
					`/timeout or /to <user> <#> : Mutes nickname "user" for # seconds. defaults to ${config.timeoutDef} seconds if blank`,
					"/delete <msgID (#)> : Delete the most recent message with ID <msgID>. If it's not the most recent, fire it off again.",
					'/emotes <emotesetID> : adds an emote set from 7tv. leave blank to reload from config',
					'/unemotes <emotesetID> : remove all emotes whose names match an emote set from 7tv. consider using /emotes after to reload baseline emotes',
					'/loadusers : reload users from disk. locks server thread while doing it, so only call if you know what you are doing'
				];
				if(this.deps.markovService){
					helpMessages.push(
						'/botstatus <status> : set the status for the markov bot',
						'/botsleep : puts the markov bot to sleep, disabling calls, or wakes him up if asleep'
					);
				}

				const formatTable = helpMessages.join('\n');
				this.deps.dispatchService.sendSystemChatPayload(ctx.socket, cType.info, formatTable);
				return clearInput;
			}
		};

		this.commands['announce'] = {
			requiresMod: true,
			requiresMarkov: false,
			handler: (ctx): InputStatus => {
				try{
					if(!ctx.commandUser){
						throw new AppError('Undefined user in Mod Command Call', 'bug');
					}
					const safe = this.deps.moderationService.moderateText(ctx.fullArgs, ctx.commandUser, 'chat');
					this.deps.stateService.setAnnouncement(ctx.io, safe);
					if(safe.length === 0){
						this.deps.dispatchService.sendSystemChatPayload(ctx.socket, cType.info, 'announcement cleared');
					}
					return clearInput;
				}
				catch(error: unknown){
					this.deps.dispatchService.sendUserErrorMessage(ctx.socket, error, 'Announce Command');
					return keepInput;
				}
			}
		};

		this.commands['ban'] = {
			requiresMod: true,
			requiresMarkov: false,
			handler: (ctx): InputStatus => {

				try{
					if(!ctx.args[0]){
						throw new AppError('missing target', 'user');
					}

					const targetBaseNick = ctx.args[0];

					if(!this.deps.identityService.existsUserByBaseNick(targetBaseNick)){
						throw new AppError(`couldn't find user with nickname ${targetBaseNick}`, 'user');
					}

					const msgArray: number[] = [];
					for (const [id, msg] of this.deps.dispatchService.getChatHistory()){
						const msgBaseNick = getBaseNick(msg.author);
						if(msgBaseNick.toLowerCase() === targetBaseNick.toLowerCase()){
							msgArray.push(id);
						}
					}
					if(msgArray.length > 0){
						this.deps.dispatchService.deleteMessages(ctx.io, msgArray);
						this.deps.dispatchService.sendSystemChatPayload(ctx.socket, cType.info, `deleted ${msgArray.length} user messages`);
					}

					for (const [socketID, identity] of this.deps.stateService.getSocketUsersMap()){
						if(getBaseNick(identity.fullnick).toLowerCase() === targetBaseNick.toLowerCase()){
							try{
								const targetsocket = ctx.io.sockets.sockets.get(socketID);
								if(targetsocket){
									this.deps.securityService.setBan(targetsocket);
									this.deps.dispatchService.sendDeleteClientLocalDataPayload(targetsocket, identity.guid);
									this.deps.dispatchService.sendSystemChatPayload(targetsocket, cType.info, 'You have been banned.');
									targetsocket.disconnect();
								}
							}
							catch(error: unknown){
								handleError(error, 'Command Ban Loop');
								continue;
							}
						}
					}

					this.deps.identityService.deleteUserByBaseNick(targetBaseNick);
					this.deps.gameStateService.reconcileRecords();

					this.deps.dispatchService.sendSystemChatPayload(ctx.io, cType.info, `${targetBaseNick} has been banned.`);
					return clearInput;
				}
				catch(error: unknown){
					this.deps.dispatchService.sendUserErrorMessage(ctx.socket, error, 'Ban Command');
					return keepInput;
				}
			}
		};

		this.commands['timeout'] = {
			requiresMod: true,
			requiresMarkov: false,
			handler: (ctx): InputStatus => {
				try{
					if(!ctx.args[0]){
						throw new AppError('missing target', 'user');
					}
					const targetBaseNick = ctx.args[0];

					if(!this.deps.identityService.existsUserByBaseNick(targetBaseNick)){
						throw new AppError(`couldn't find user with nickname ${targetBaseNick}`, 'user');
					}

					const config = this.deps.configService.getServerConfig();

					//set duration in seconds
					const durationInput = parseInt(ctx.args[1], 10);
					const duration = isNaN(durationInput) || durationInput <0 ? config.timeoutDef : durationInput;
					const now = Date.now();
					const maxAllowed = 30*24*60*60*1000;

					//apply the timeout to the future
					let unMute = now + (duration * 1000);

					if(unMute > now + maxAllowed){
						unMute = now + maxAllowed;
					}

					this.deps.identityService.setLastMessageByBaseNick(targetBaseNick, unMute);

					//messages to delete
					const msgArray: number[] = [];
					for (const [id, msg] of this.deps.dispatchService.getChatHistory()){
						const msgBaseNick = getBaseNick(msg.author);
						if(msgBaseNick.toLowerCase() === targetBaseNick.toLowerCase()){
							msgArray.push(id);
						}
					}

					//delete messages if any
					if(msgArray.length > 0){
						this.deps.dispatchService.deleteMessages(ctx.io, msgArray);
					}

					this.deps.dispatchService.sendSystemChatPayload(ctx.io, cType.info, `${targetBaseNick} has been timed out.`);
					return clearInput;
				}
				catch(error: unknown){
					this.deps.dispatchService.sendUserErrorMessage(ctx.socket, error, 'Timeout Command');
					return keepInput;
				}
			}
		};

		this.commands['delete'] = {
			requiresMod: true,
			requiresMarkov: false,
			handler: (ctx): InputStatus => {
				const id = Number(ctx.args[0]);

				if(!ctx.args[0] || !Number.isInteger(id) || id < 0){
					const error = new AppError('please provide a valid message id', 'user');
					this.deps.dispatchService.sendUserErrorMessage(ctx.socket, error, 'Delete Command');
					return keepInput;
				}

				this.deps.dispatchService.deleteMessages(ctx.io, [id]);

				return clearInput;
			}
		};

		this.commands['emotes'] = {
			requiresMod: true,
			requiresMarkov: false,
			handler: async (ctx): Promise<InputStatus> => {
				const targetID = ctx.args[0];

				if(targetID){
					this.deps.dispatchService.sendSystemChatPayload(ctx.socket, cType.info, `fetching new emote set ${targetID}...`);
				}
				else{
					this.deps.dispatchService.sendSystemChatPayload(ctx.socket, cType.info, 'reloading emotes from config...');
				}

				try{
					const size = await this.deps.stateService.updateEmotes(ctx.io, targetID);
					this.deps.dispatchService.sendSystemChatPayload(ctx.socket, cType.info, `${size} emotes loaded`);
					return clearInput;
				}
				catch(error: unknown){
					this.deps.dispatchService.sendUserErrorMessage(ctx.socket, error, 'Emotes Command');
					return keepInput;
				}
			}
		};

		this.commands['unemotes'] = {
			requiresMod: true,
			requiresMarkov: false,
			handler: async (ctx): Promise<InputStatus> => {
				const targetID = ctx.args[0];
				this.deps.dispatchService.sendSystemChatPayload(ctx.socket, cType.info, `removing emote set ${targetID}...`);

				try{
					const size = await this.deps.stateService.deleteEmotes(ctx.io, targetID);
					this.deps.dispatchService.sendSystemChatPayload(ctx.socket, cType.info, `${size} emotes removed`);
					return clearInput;
				}
				catch(error: unknown){
					this.deps.dispatchService.sendUserErrorMessage(ctx.socket, error, 'Unemotes Command');
					return keepInput;
				}
			}
		};

		this.commands['loadusers'] = {
			requiresMod: true,
			requiresMarkov: false,
			handler: (ctx): InputStatus => {
				try{
					const size = this.deps.identityService.reloadUsers();
					this.deps.dispatchService.sendSystemChatPayload(ctx.socket, cType.info, `${size} users reloaded`);
					const gameSize = this.deps.gameIdentityService.reloadGameUsers();
					this.deps.dispatchService.sendSystemChatPayload(ctx.socket, cType.info, `${gameSize} game users reloaded`);
					return clearInput;
				}
				catch(error: unknown){
					this.deps.dispatchService.sendUserErrorMessage(ctx.socket, error, 'Load Users Command');
					return keepInput;
				}
			}
		};

		this.commands['botstatus'] = {
			requiresMod: true,
			requiresMarkov: true,
			handler: (ctx): InputStatus => {
				try{
					const markovUser = this.deps.stateService.markovUser;
					if(!markovUser){
						throw new AppError("couldn't find a markov bot", 'user');
					}
					if(!ctx.commandUser){
						throw new AppError('Undefined user in Mod Command Call', 'bug');
					}
					const safe = this.deps.moderationService.moderateText(ctx.fullArgs, ctx.commandUser, 'status');
					markovUser.status = safe;
					this.deps.stateService.broadcastUsers(ctx.io);
					this.deps.dispatchService.sendSystemChatPayload(ctx.socket, cType.info, `${this.markovBaseNick} status is now: ${markovUser.status}`);
					return clearInput;
				}
				catch(error: unknown){
					this.deps.dispatchService.sendUserErrorMessage(ctx.socket, error, 'Bot Status Command');
					return keepInput;
				}
			}
		};

		this.commands['botsleep'] = {
			requiresMod: true,
			requiresMarkov: true,
			handler: (ctx): InputStatus => {
				const markovUser = this.deps.stateService.markovUser;
				if(!markovUser){
					const error = new AppError("couldn't find a markov bot", 'user');
					this.deps.dispatchService.sendUserErrorMessage(ctx.socket, error, 'Bot Sleep Command');
					return keepInput;
				}

				const markovSleep = this.deps.stateService.toggleMarkovSleep(ctx.io);

				if(markovSleep){
					this.deps.dispatchService.sendSystemChatPayload(ctx.socket, cType.info, `${this.markovBaseNick} is sleepin now. honk shoo`);
					return clearInput;
				}
				else{
					this.deps.dispatchService.sendSystemChatPayload(ctx.socket, cType.info, `${this.markovBaseNick} is awake now. rise and grind`);
					return clearInput;
				}
			}
		};
	}

	private registerGdprCommands(): void {
		this.commands['gdpr'] = {
			requiresMod: false,
			requiresMarkov: false,
			handler: (ctx): InputStatus => {
				const subComm = ctx.args[0];
				switch (subComm){
					case 'info':{
						const config = this.deps.configService.getServerConfig();
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
							`chatHistory	|	Up to ${config.msgArrayLen} messages are temporarily cached for session continuity and automatically expire after ${config.msgArrayTimeout} seconds.`,
							'---------------------------------------------------------------------------------------------',
							'We also store some data for minigames server side:',
							'gamePoints		|	A number representing the minigame points earned',
							'lastGame		|	Timestamp of when the last time locked minigame was played to prevent spam',
							'---------------------------------------------------------------------------------------------',
							'We store the following information locally:',
							'ratGUID		|	a local copy of the GUID for message construction',
							'ratBG			|	a local version of image selected for background image (not sent to server)',
							'ratMode		| 	a local indicator if dark mode is enabled for client appearance',
							'ratMutedUsers	|	a local list of usernames whose messages are hidden by default in the client',
							'ratMutedEvents	|	a local list of minigame events whose announcements are ignored',
						];
						if(this.deps.configService.getMarkovConfig().learning){
							infoMsgs.push(
								'---------------------------------------------------------------------------------------------',
								'This server uses an optional Markov chain feature that learns from user chat messages.',
								'Messages are stripped of usernames and fully deconstructed into anonymous word fragments before being saved.',
								'No identifiable or reconstructable message information is saved. No authors, no timestamps, no message history, etc.',
								'As such, portions of your messages may be used as Markov chain text in an anonymous capacity consistent with Recital 26 of the GDPR.',
							);
						}

						infoMsgs.push(
							'---------------------------------------------------------------------------------------------',
							'Use /gdpr info to see this message again',
							'Use /gdpr ip to see specific information on how and why we use IP addresses',
							'Use /gdpr export to see a copy of your data stored on the server, if any.',
							'Use /gdpr delete to permanently remove your data from the server. this will prevent you from utilizing the application.',
							'---------------------------------------------------------------------------------------------',
							`If you have questions or concerns, please email ${config.gdprcontact}`
						);

						const formatTable = infoMsgs.join('\n');
						this.deps.dispatchService.sendSystemChatPayload(ctx.socket, cType.info, formatTable);
						return clearInput;
					}

					case 'ip':{
						const ipMsgs = [
							'---------------------------------------------------------------------------------------------',
							'We utilize IP addresses for ban enforcement and system protection as allowed under Article 6(1)(f) of the GDPR to protect the service from spam and abuse.',
							'These IP addresses are only stored long term in the event of a ban from bad behavior.',
							'An IP address is stored only with a timestamp, and is automatically and permanently deleted after a set retention period defined by server policy.',
							'If an IP address is stored, it is rendered human unreadable by a one way salted cryptography hash. A "plain-text" IP address is never stored.',
							'Any time a user connects, their IP is hashed in the same way and compared to the stored bans.',
							'An IP address is only linked to a user at the instant of banning in order to select the correct IP to ban. This linkage is not stored.',
							'---------------------------------------------------------------------------------------------'
						];
						const formatIpTable = ipMsgs.join('\n');
						this.deps.dispatchService.sendSystemChatPayload(ctx.socket, cType.info, formatIpTable);
						return clearInput;
					}

					case 'export':{
						if(!ctx.commandUser){
							this.deps.dispatchService.sendSystemChatPayload(ctx.socket, cType.info, 'You have no server stored data.');
							return clearInput;
						}
						try{
							const user = this.deps.identityService.getUser(ctx.commandUser.guid);
							const gameUser = this.deps.gameIdentityService.getGameUser(ctx.commandUser.playerid);

							this.deps.dispatchService.sendSystemChatPayload(ctx.socket, cType.info, `Server stored user info: ${JSON.stringify(user, null, 4)}`);
							this.deps.dispatchService.sendSystemChatPayload(ctx.socket, cType.info, `Server stored game info: ${JSON.stringify(gameUser, null, 4)}`);
							return clearInput;
						}
						catch(error: unknown){
							this.deps.dispatchService.sendUserErrorMessage(ctx.socket, error, 'GDPR Export Command');
							return keepInput;
						}
					}

					case 'delete':{
						if(!ctx.commandUser){
							this.deps.dispatchService.sendSystemChatPayload(ctx.socket, cType.info, 'You have no server stored data.');
							return clearInput;
						}
						if(ctx.args[1] !== 'confirm'){
							this.deps.dispatchService.sendSystemChatPayload(ctx.socket, cType.info, "WARNING: this will permanently delete your account and all server-side data! type '/gdpr delete confirm' to proceed.", [fType.b]);
							return keepInput;
						}

						try{
							const targetGuid = ctx.commandUser.guid;
							const targetFullNick = ctx.commandUser.fullnick;

							if(!this.deps.identityService.existsUser(targetGuid)){
								this.deps.dispatchService.sendSystemChatPayload(ctx.socket, cType.info, 'No server side data found.');
							}
							else{
								this.deps.identityService.deleteUser(targetGuid);
								this.deps.gameStateService.reconcileRecords();
								this.deps.dispatchService.sendSystemChatPayload(ctx.socket, cType.info, 'Your server side data has been deleted.');
							}

							//iterate through all sockets to find matches
							const socketUsers = this.deps.stateService.getSocketUsersMap();
							const allSockets = ctx.io.sockets.sockets;
							allSockets.forEach((socket) => {
								const mappedUser = socketUsers.get(socket.id);
								if(mappedUser && mappedUser.guid === targetGuid){
									this.deps.dispatchService.sendDeleteClientLocalDataPayload(socket, targetGuid);
									this.deps.stateService.deleteSocketUser(ctx.io, socket.id);
								}
							});

							this.deps.dispatchService.sendSystemChatPayload(ctx.io, cType.ann, `${getBaseNick(targetFullNick)} disconnected`);
							return clearInput;

						}
						catch(error: unknown){
							this.deps.dispatchService.sendUserErrorMessage(ctx.socket, error, 'GDPR Delete Command');
							return keepInput;
						}
					}

					default:{
						const error = new AppError("please use with 'info', 'ip', 'export' or 'delete' after /gdpr", 'user');
						this.deps.dispatchService.sendUserErrorMessage(ctx.socket, error, 'GDPR Command');
						return keepInput;
					}
				}
			}
		};
	}

	private initializeGameCommands(): void {
		for(const name of this.deps.gameCommandService.getGameCommands()){
			this.gameCommandNames.add(name);
		}
	}
}
