import {cType, fType, gType, hType} from '../../defs/def-events';
import {allGames} from '../../defs/def-config';
import {clearInput, keepInput} from '../../defs/def-input';
import {tType} from '../../defs/def-moderation';
import type {GameCommand} from '../../defs/def-commands';
import type {GameType} from '../../defs/def-config';
import type {RatServer, RatSocket, GameEventType, GameLine, GameTextPayload} from '../../defs/def-events';
import type {FishingCallback, HorseBet, HorseBetCallback, HorseBetResult} from '../../defs/def-games';
import type {Identity, GameIdentity} from '../../defs/def-identity';
import type {InputStatus} from '../../defs/def-input';

import {ConfigService} from '../config';
import {DispatchService} from '../dispatch';
import {ModerationService} from '../moderation';
import {GameIdentityService} from './game-identity';
import {IdentityService} from '../identity';
import {GameStateService} from './game-state';
import {StateService} from '../state';

import {AppError, handleError} from '../../utils/errors';
import {getBaseNick} from '../../utils/format';

import {createHorseBetsText, createHorseNameText, createHorseOddsText} from './game-utils/commentary';

type GameCommandEntry = {
	enabledFor: GameType[];
	handler: (ctx: GameCommand) => InputStatus | Promise<InputStatus>;
}

export interface GameCommandServiceDependencies {
	configService: ConfigService;
	dispatchService: DispatchService;
	moderationService: ModerationService;
	gameIdentityService: GameIdentityService;
	identityService: IdentityService;
	gameStateService: GameStateService;
	stateService: StateService;
}

export class GameCommandService {
	private gameCommands: Record<string, GameCommandEntry> = {};
	private activeGameCommands: Map<RatSocket['id'], boolean> = new Map();

	private deps: GameCommandServiceDependencies;
	constructor(dependencies: GameCommandServiceDependencies){
		this.deps = dependencies;
		this.init();
	}

	private init(): void {
		this.initializeGameCommands();
	}

	public async handleGameCommand(msg: string, socket: RatSocket, io: RatServer, caller: Identity): Promise<InputStatus>{
		const args = msg.slice(1).trim().split(/ +/);
		const commandName = args.shift()?.toLowerCase() || '';

		if(!this.deps.configService.getGameConfig().enabled){
			return this.sendNotCommand(socket);
		}

		if(this.activeGameCommands.get(socket.id)){
			return keepInput;
		}

		this.activeGameCommands.set(socket.id, true);

		try{
			const result = await this.executeGameCommand(commandName, {
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
			this.deps.dispatchService.sendUserErrorMessage(socket, error, `Handle Game Command: ${commandName}`);
			return keepInput;
		}
		finally{
			this.activeGameCommands.delete(socket.id);
		}
	}

	public getGameCommands(): string[]{
		return Object.keys(this.gameCommands);
	}

	private sendNotCommand(socket: RatSocket): InputStatus {
		const error = new AppError("that's not a command lol", 'user');
		this.deps.dispatchService.sendUserErrorMessage(socket, error, 'Game Command Service Not Command');
		return keepInput;
	}

	private sendUserPoints(playerid: GameIdentity['playerid'], socket: RatSocket, points: number, event: GameEventType): void {
		try{
			this.deps.gameIdentityService.addGamePoints(playerid, points);
			const nicepoints = points.toLocaleString('en-US');
			const name = this.deps.configService.getGameConfig().pointsName;
			const message: GameLine = [
				{text: "you've earned ", color: hType.normal, format: []},
				{text: `${nicepoints} `, color: hType.normal, format: [fType.b]},
				{text: name, color: hType.normal, format: [fType.b]},
				{text: ", don't spend it all in one place", color: hType.normal, format: []}
			];
			this.deps.dispatchService.sendGamePayload(socket, [message], event);
		}
		catch(error: unknown){
			this.deps.dispatchService.sendUserErrorMessage(socket, error, 'Send User Points');
		}
	}

	private async executeGameCommand(name: string, ctx: GameCommand): Promise<InputStatus> {
		const entry = this.gameCommands[name];

		if(!entry){
			return this.sendNotCommand(ctx.socket);
		}

		if(!entry.enabledFor.some(game => this.deps.configService.getGameConfig()[game])){
			return this.sendNotCommand(ctx.socket);
		}

		return await entry.handler(ctx);
	}

	private handleHorseCallback(playerid: GameIdentity['playerid'], results: HorseBetResult[], io: RatServer): void {
		for(const result of results){
			if(result.playerid !== playerid){
				throw new AppError('handleHorseCallback received a result for a mismatched playerid', 'internal', 'warn');
			}
		}

		const message: GameTextPayload = [];
		const jackpots: GameLine[] = [];
		let totalStake = 0;
		let totalPayout = 0;

		for(const result of results){
			totalStake += result.stake;
			totalPayout += result.payout;

			const horseName = createHorseNameText(result);
			let line: GameLine;
			if(result.payout > 0){
				line = [
					{text: `you won ${result.payout.toLocaleString('en-US')} betting on `, color: hType.normal, format: []},
					...horseName,
					{text: ` for ${result.stake.toLocaleString('en-US')}`, color: hType.normal, format: []}
				];

				let place: keyof GameIdentity['horseBetWins'] | null = null;
				if(result.place === 1){
					place = 'firsts';
				}
				else if(result.place === 2){
					place = 'seconds';
				}
				else if(result.place === 3){
					place = 'thirds';
				}
				else{
					handleError(new AppError(`horse bet result had payout but an unexpected place: ${result.place}`, 'internal', 'warn'), 'Record Horse Bet Win Place');
				}

				if(place){
					try{
						this.deps.gameIdentityService.incrementHorseBetWins(playerid, place);

						const gameUser = this.deps.gameIdentityService.getGameUser(playerid);
						if(result.payout > gameUser.horseBetBiggestWin.payout){
							this.deps.gameIdentityService.setHorseBetBiggestWin(playerid, result.payout, result.stake);
						}
					}
					catch(error: unknown){
						handleError(error, 'Record Horse Bet Win Stats');
					}
				}

				if(result.payout > this.deps.configService.getGameConfig().horseBetBigWin){
					try{
						const fullnick = this.deps.identityService.getFullNickByPlayerId(playerid);
						const basenick = getBaseNick(fullnick);
						const announcement: GameLine = [
							{text: 'jackpot! ', color: hType.normal, format: [fType.b]},
							{text: `${basenick} won ${result.payout.toLocaleString('en-US')} betting on `, color: hType.normal, format: []},
							...horseName,
							{text: ` for ${result.stake.toLocaleString('en-US')}!`, color: hType.normal, format: []}
						];
						jackpots.push(announcement);
					}
					catch(error: unknown){
						handleError(error, 'Horse Big Win Announcement');
					}
				}
			}
			else{
				line = [
					{text: `your bet of ${result.stake.toLocaleString('en-US')} on `, color: hType.normal, format: []},
					...horseName,
					{text: ' did not pay out.', color: hType.normal, format: []}
				];
			}
			message.push(line);
		}

		const netWinnings = totalPayout - totalStake;

		const summaryLine: GameLine = [];
		if(results.length > 1){
			if(netWinnings > 0){
				const totalWinnings = netWinnings + totalStake;
				summaryLine.push({text: `you made a total of ${totalWinnings.toLocaleString('en-US')} on ${totalStake.toLocaleString('en-US')} staked.`, color: hType.normal, format: []});
			}
			else if(netWinnings < 0){
				summaryLine.push({text: `you lost a total of ${Math.abs(netWinnings).toLocaleString('en-US')} on ${totalStake.toLocaleString('en-US')} staked.`, color: hType.normal, format: []});
			}
			else{
				summaryLine.push({text: `you broke even on ${totalStake.toLocaleString('en-US')} staked.`, color: hType.normal, format: []});
			}
			message.push(summaryLine);
		}

		let targetSocket: RatSocket | null = null;
		try{
			for(const [socketID, identity] of this.deps.stateService.getSocketUsersMap()){
				if(identity.playerid !== playerid){
					continue;
				}

				const foundSocket = io.sockets.sockets.get(socketID);
				if(foundSocket){
					this.deps.dispatchService.sendGamePayload(foundSocket, message, gType.horse);
					targetSocket = foundSocket;
				}
			}
			if(jackpots.length > 0){
				this.deps.dispatchService.sendGamePayload(io, jackpots, gType.horse);
			}
		}
		catch(error: unknown){
			handleError(error, 'Horse Bet Result Message');
		}

		if(totalPayout > 0){
			if(targetSocket){
				this.sendUserPoints(playerid, targetSocket, totalPayout, gType.horse);
			}
			else{
				try{
					this.deps.gameIdentityService.addGamePoints(playerid, totalPayout);
				}
				catch(error: unknown){
					handleError(error, 'Add Game Points (No Socket)');
				}
			}
		}

		if(netWinnings !== 0){
			try{
				this.deps.gameIdentityService.adjustHorseWinnings(playerid, netWinnings);
			}
			catch(error: unknown){
				handleError(error, 'Adjust Horse Winnings');
			}
		}
	}

	private handleFishingCallback(playerid: GameIdentity['playerid'], event: FishingCallback, io: RatServer): void {
		let message: GameLine;

		switch(event){
			case 'bite':{
				message = [{text: 'fish on! /catch it before it gets away!', color: hType.normal, format: [fType.b]}];
				break;
			}
			case 'expired':{
				message = [{text: 'damn, it got away...', color: hType.normal, format: []}];
				break;
			}
			case 'nothing':{
				message = [{text: 'looks like nothing bit...', color: hType.normal, format: []}];
				break;
			}
			default:{
				message = [{text: 'looks like nothing bit...', color: hType.normal, format: []}];
			}
		}

		for(const [socketID, identity] of this.deps.stateService.getSocketUsersMap()){
			if(identity.playerid !== playerid){
				continue;
			}

			const targetSocket = io.sockets.sockets.get(socketID);
			if(targetSocket){
				this.deps.dispatchService.sendGamePayload(targetSocket, [message], gType.fishing);
			}
		}
	}

	private initializeGameCommands(): void {
		this.registerGameCommands();
		this.registerHorseCommands();
		//this.registerDuelingCommands();
		//this.registerBlackjackCommands();
		this.registerFishingCommands();

		this.gameCommands['cast'] = this.gameCommands['fish'];
		for(let post = 0; post <= 9; post++){
			this.gameCommands[`bethorse${post}`] = this.gameCommands['bethorse'];
		}
		for(let post = 0; post <= 99; post++){
			this.gameCommands[`bethorse${String(post).padStart(2, '0')}`] = this.gameCommands['bethorse'];
		}
	}

	private registerGameCommands(): void {
		this.gameCommands['gamehelp'] = {
			enabledFor: allGames,
			handler: (ctx): InputStatus => {
				const config = this.deps.configService.getGameConfig();
				const helpMessages = [
					'/gamehelp  : View this list.',
				];
				if(config.fishing){
					helpMessages.push(
						'/fish to fish'
					);
				}

				const formatTable = helpMessages.join('\n');
				this.deps.dispatchService.sendSystemChatPayload(ctx.socket, cType.info, formatTable);
				return clearInput;
			}
		};
		this.gameCommands['testcolors'] = {
			enabledFor: allGames,
			handler: (ctx): InputStatus => {
				const colors = Object.values(hType);
				const formats = Object.values(fType);

				const textPayload: GameTextPayload = [];
				for(const color of colors){
					for(const format of formats){
						const line: GameLine = [
							{text: `[${color}][${format}]: The quick brown fox jumped over the lazy dog. 1234567890.`, color: color, format: [format]}
						];
						textPayload.push(line);
					}
				}

				this.deps.dispatchService.sendGamePayload(ctx.socket, textPayload, gType.horse, 250);

				return clearInput;
			}
		};
	}

	private registerHorseCommands(): void {
		this.gameCommands['bethorse'] = {
			enabledFor: ['horseRacing'],
			handler: (ctx): InputStatus => {
				let paid = false;
				let stake = 0;
				try{
					if(!this.deps.gameStateService.existsHorseSession()){
						throw new AppError("you can't bet when there isn't a race on", 'user');
					}

					if(ctx.commandName === 'bethorse'){
						throw new AppError('please pick a horse to bet on, e.g. /bethorse13', 'user');
					}

					const commandSlice = ctx.commandName.slice('bethorse'.length);
					const post = Number(commandSlice);
					if(Number.isNaN(post)){
						throw new AppError('resolved a non-numeric post number from command name', 'internal', 'warn');
					}

					const field = this.deps.gameStateService.getFieldHorseSession();
					const horse = field.find(entry => entry.horsePost === post);
					if(!horse){
						throw new AppError(`there is no horse numbered ${post}, use /odds to check the field`, 'user');
					}

					stake = Number(ctx.args[0]);
					if(Number.isNaN(stake)){
						throw new AppError('please provide a valid stake amount, e.g. /bethorse13 500', 'user');
					}
					if(stake <= 0 || !Number.isInteger(stake)){
						throw new AppError('very clever, please use a integer number larger than 0', 'user');
					}

					const player = this.deps.gameIdentityService.getGameUser(ctx.commandUser.playerid);
					this.deps.moderationService.moderateTime(player.lastGame, tType.game);

					this.deps.gameIdentityService.removeGamePoints(ctx.commandUser.playerid, stake);
					paid = true;

					const callback: HorseBetCallback = (results): void => {
						this.handleHorseCallback(ctx.commandUser.playerid, results, ctx.io);
					};

					const bet: HorseBet = {
						playerid: ctx.commandUser.playerid,
						horseName: horse.horseName,
						horsePost: horse.horsePost,
						horseColor: horse.horseColor,
						stake: stake,
						oddsNum: horse.oddsNum,
						oddsDen: horse.oddsDen,
						prerace: false,
						callback: callback
					};

					const placedBet = this.deps.gameStateService.pushBetHorseSession(bet);
					const message: GameTextPayload = createHorseBetsText([placedBet]);

					this.deps.gameIdentityService.setLastGame(ctx.commandUser.playerid, Date.now());
					this.deps.dispatchService.sendGamePayload(ctx.socket, message, gType.horse);
					return clearInput;
				}
				catch(error: unknown){
					this.deps.dispatchService.sendUserErrorMessage(ctx.socket, error, 'Bet Horse Command');
					if(paid){
						this.deps.gameIdentityService.addGamePoints(ctx.commandUser.playerid, stake);
					}
					return keepInput;
				}
			}
		};

		this.gameCommands['odds'] = {
			enabledFor: ['horseRacing'],
			handler: (ctx): InputStatus => {
				try{
					if(!this.deps.gameStateService.existsHorseSession()){
						throw new AppError("no race is currently scheduled. you'll need to wait for the next race", 'user');
					}

					const field = this.deps.gameStateService.getFieldHorseSession();
					const message = createHorseOddsText(field);

					this.deps.dispatchService.sendGamePayload(ctx.socket, message, gType.horse);
					return clearInput;
				}
				catch(error: unknown){
					this.deps.dispatchService.sendUserErrorMessage(ctx.socket, error, 'Odds Command');
					return clearInput;
				}
			}
		};

		this.gameCommands['bets'] = {
			enabledFor: ['horseRacing'],
			handler: (ctx): InputStatus => {
				try{
					if(!this.deps.gameStateService.existsHorseSession()){
						throw new AppError("no race is currently scheduled. you'll need to wait for the next race", 'user');
					}

					const bets = this.deps.gameStateService.getBetsHorseSession(ctx.commandUser.playerid);
					if(bets.length === 0){
						throw new AppError('gotta spend money to make money (no bets placed)', 'user');
					}

					const message = createHorseBetsText(bets);

					this.deps.dispatchService.sendGamePayload(ctx.socket, message, gType.horse);
					return clearInput;
				}
				catch(error: unknown){
					this.deps.dispatchService.sendUserErrorMessage(ctx.socket, error, 'Bets Command');
					return clearInput;
				}
			}
		};
	}

	private registerFishingCommands(): void {
		this.gameCommands['fish'] = {
			enabledFor: ['fishing'],
			handler: (ctx): InputStatus => {
				if(this.deps.gameStateService.existsFishingSession(ctx.commandUser.playerid)){
					const error = new AppError('you already have a line in the water', 'user');
					this.deps.dispatchService.sendUserErrorMessage(ctx.socket, error, 'Fish Command Exists');
					return clearInput;
				}
				let target = null;
				if(ctx.fullArgs){
					target = ctx.fullArgs;
				}

				try{
					const callback = (playerid: GameIdentity['playerid'], fishcallback: FishingCallback): void => {
						this.handleFishingCallback(playerid, fishcallback, ctx.io);
					};
					this.deps.gameStateService.createFishingSession(ctx.commandUser.playerid, target, callback);
				}
				catch(error: unknown){
					this.deps.dispatchService.sendUserErrorMessage(ctx.socket, error, 'Fish Command');
					return keepInput;
				}

				if(target){
					const message: GameLine = [
						{text: 'you carefully cast your line looking for ', color: hType.normal, format: []},
						{text: `"${target}"`, color: hType.normal, format: []},
						{text: '...', color: hType.normal, format: []}
					];
					this.deps.dispatchService.sendGamePayload(ctx.socket, [message], gType.fishing);
					return clearInput;
				}
				else{
					const message: GameLine = [{text: 'you cast out your line...', color: hType.normal, format: []}];
					this.deps.dispatchService.sendGamePayload(ctx.socket, [message], gType.fishing);
					return clearInput;
				}
			}
		};

		this.gameCommands['catch'] = {
			enabledFor: ['fishing'],
			handler: (ctx): InputStatus =>{
				if(!this.deps.gameStateService.existsFishingSession(ctx.commandUser.playerid)){
					const error = new AppError("you ain't got a line in the wooter. /fish to cast it out", 'user');
					this.deps.dispatchService.sendUserErrorMessage(ctx.socket, error, 'Catch Command Exists');
					return clearInput;
				}
				try{
					const fishResult = this.deps.gameStateService.catchFishingSession(ctx.commandUser.playerid);
					if(!fishResult){
						const message: GameLine = [{text: "your hook's empty...", color: hType.normal, format: []}];
						this.deps.dispatchService.sendGamePayload(ctx.socket, [message], gType.fishing);
						return clearInput;
					}

					const weight = fishResult.weight.toLocaleString('en-US', {maximumFractionDigits: 2});

					const message: GameLine = [
						{text: 'you caught a [', color: hType.normal, format: []},
						{text: fishResult.name.toLowerCase(), color: fishResult.color, format: []},
						{text: `] weighing ${weight} ounces. `, color: hType.normal, format: []}
					];

					if(fishResult.record){
						message.push({text: 'new server fish record! ', color: hType.normal, format: []});
					}
					if(fishResult.pb){
						message.push({text: 'new personal best catch! ', color: hType.normal, format: []});
					}
					if(fishResult.newcatch){
						message.push({text: "you've never seen one of those before. ", color: hType.normal, format: []});
					}
					if(fishResult.big){
						message.push({text: "that's a biggun' ", color: hType.normal, format: []});
					}
					if(fishResult.small){
						message.push({text: "that's a smallun' ", color: hType.normal, format: []});
					}

					this.deps.dispatchService.sendGamePayload(ctx.socket, [message], gType.fishing);
					this.deps.dispatchService.sendSystemChatPayload(ctx.socket, cType.info, fishResult.flavor);
					if(fishResult.record){
						const basenick = getBaseNick(ctx.commandUser.fullnick);
						const announcement: GameLine = [
							{text: basenick, color: hType.normal, format: []},
							{text: ' caught a new server record [', color: hType.normal, format: []},
							{text: fishResult.name.toLowerCase(), color: fishResult.color, format: []},
							{text: `] weighing ${weight} ounces!`, color: hType.normal, format: []}
						];
						this.deps.dispatchService.sendGamePayload(ctx.io, [announcement], gType.fishing);
					}
					const points = Math.ceil(fishResult.value);
					try{
						this.deps.gameIdentityService.addFishingWinnings(ctx.commandUser.playerid, points);
					}
					catch(error: unknown){
						handleError(error);
					}
					this.sendUserPoints(ctx.commandUser.playerid, ctx.socket, points, gType.fishing);
					return clearInput;
				}
				catch(error: unknown){
					this.deps.dispatchService.sendUserErrorMessage(ctx.socket, error, 'Catch Command');
					return keepInput;
				}
			}
		};
	}
}
