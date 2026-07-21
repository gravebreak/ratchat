import {GameIdentitySchema} from '../../defs/def-identity';
import {aType} from '../../defs/def-parse';
import type {GameIdentity, DefaultGameIdentity} from '../../defs/def-identity';
import type {KeyedParseFailureRecord} from '../../defs/def-parse';

import {ConfigService} from '../config';

import {AppError, handleError} from '../../utils/errors';
import {mergeIdentityDefaults, isUnknownArray} from '../../utils/parse';
import {createSaveQueue} from '../../utils/queue';
import {assertSafeStartup, getRepairPath} from '../../utils/repair';
import {existsFile, createJsonFile, readJsonFile, writeJsonFile} from '../../utils/serialize';

import {assertGamesEnabled, assertHorseRacingEnabled, assertFishingEnabled} from './game-utils/checks';

const MAX_INT = 4294967295;

export interface GameIdentityServiceDependencies{
	configService: ConfigService;

	gameUsersPath: string;
}

export class GameIdentityService {
	private gameUsers: Map<GameIdentity['playerid'], GameIdentity> = new Map();
	private gameUserQueue = createSaveQueue(() => this.saveGameUsers());

	private deps: GameIdentityServiceDependencies;
	constructor(dependencies: GameIdentityServiceDependencies){
		this.deps = dependencies;
		this.init();
	}

	private init(): void {
		assertSafeStartup(this.deps.gameUsersPath);
		this.initializeGameUsers();
	}

	public existsGameUser(playerid: GameIdentity['playerid']): boolean{
		const user = this.gameUsers.get(playerid);
		if(user){
			return true;
		}
		return false;
	}

	public getGameUser(playerid: GameIdentity['playerid']): GameIdentity {
		const user = this.gameUsers.get(playerid);
		if(!user){
			throw new AppError('get game user: no matching game user found to playerid', 'internal', 'warn');
		}
		return structuredClone(user);
	}

	public createGameUser(newplayerid: GameIdentity['playerid']): GameIdentity{
		if(this.gameUsers.has(newplayerid)){
			throw new AppError('create game user: game user already exists for playerid', 'internal', 'warn');
		}
		const newGameIdentity : GameIdentity = {
			playerid: newplayerid,
			...this.buildDefaultGameIdentity()
		};
		this.gameUsers.set(newplayerid, newGameIdentity);
		this.gameUserQueue.chain();
		return newGameIdentity;
	}

	public deleteGameUser(playerid: GameIdentity['playerid']): void {
		const user = this.gameUsers.get(playerid);
		if(!user){
			throw new AppError('delete game user: no matching game user found to playerid', 'internal', 'error');
		}
		this.gameUsers.delete(playerid);
		this.gameUserQueue.chain();
	}

	public getGameUsersMap(): Map<GameIdentity['playerid'], GameIdentity> {
		const copy = new Map<GameIdentity['playerid'], GameIdentity>();

		for(const [playerid, gameIdentity] of this.gameUsers){
			copy.set(playerid, structuredClone(gameIdentity));
		}

		return copy;
	}

	public reloadGameUsers(): number{
		try{
			const raw = this.fetchGameUsersStrict();
			const resolvedGameUsers = this.resolveGameUsersStrict(raw);
			this.assignGameUsers(resolvedGameUsers);
			return resolvedGameUsers.size;
		}
		catch(error: unknown){
			if(error instanceof AppError){
				throw error;
			}

			handleError(error, 'Reload Game Users');

			throw new AppError('failed to reload game users: unknown error', 'user');
		}
	}

	public setLastGame(playerid: GameIdentity['playerid'], gamedate: number): GameIdentity {
		assertGamesEnabled(this.deps.configService, 'setLastGame');

		const user = this.gameUsers.get(playerid);
		const newDate = gamedate;
		if(!user){
			throw new AppError('set last game: no matching game user found to playerid', 'internal', 'warn');
		}
		user.lastGame = new Date(newDate);

		this.gameUserQueue.chain();
		return user;
	}

	public addGamePoints(playerid: GameIdentity['playerid'], pointsadd: number): GameIdentity{
		assertGamesEnabled(this.deps.configService, 'addGamePoints');

		if(pointsadd <= 0){
			throw new AppError('addGamePoints called with negative value', 'bug');
		}

		const gameId = this.gameUsers.get(playerid);
		if(!gameId){
			throw new AppError('add game points: no matching game user found to playerid', 'internal', 'warn');
		}

		const amount = Math.round(pointsadd);
		const newPoints = gameId.gamePoints + amount;
		if(newPoints >= MAX_INT){
			gameId.gamePoints = MAX_INT;
			this.gameUserQueue.chain();
			const name = this.deps.configService.getGameConfig().pointsName;
			throw new AppError(`you won the game, max ${name} gained. use /broke to start again`, 'user');
		}

		gameId.gamePoints = newPoints;
		this.gameUserQueue.chain();
		return gameId;
	}

	public removeGamePoints(playerid: GameIdentity['playerid'], pointsremove: number): GameIdentity{
		assertGamesEnabled(this.deps.configService, 'removeGamePoints');

		if(pointsremove <= 0){
			throw new AppError('removeGamePoints called with neg value', 'bug');
		}

		const gameId = this.gameUsers.get(playerid);
		if(!gameId){
			throw new AppError('remove game points: no matching game user found to playerid', 'internal', 'warn');
		}

		const amount = Math.round(pointsremove);
		const newPoints = gameId.gamePoints - amount;
		if(newPoints < 0){
			throw new AppError("you can't pay more than you have.", 'user');
		}

		gameId.gamePoints = newPoints;
		this.gameUserQueue.chain();
		return gameId;
	}

	public setGamePointsDefault(playerid: GameIdentity['playerid']): GameIdentity{
		assertGamesEnabled(this.deps.configService, 'setGamePointsDefault');

		const gameId = this.gameUsers.get(playerid);
		if(!gameId){
			throw new AppError('set game points default: no matching game user found to playerid', 'internal', 'warn');
		}
		const newPoints = Math.round(this.deps.configService.getGameConfig().pointStartAmt);
		gameId.gamePoints = newPoints;
		this.gameUserQueue.chain();
		return gameId;
	}

	public adjustHorseWinnings(playerid: GameIdentity['playerid'], delta: number): GameIdentity{
		assertGamesEnabled(this.deps.configService, 'adjustHorseWinnings');
		assertHorseRacingEnabled(this.deps.configService, 'adjustHorseWinnings');

		const amount = Math.round(delta);
		if(amount === 0){
			throw new AppError('adjustHorseWinnings called with near zero value', 'bug');
		}

		const gameId = this.gameUsers.get(playerid);
		if(!gameId){
			throw new AppError('adjust horse winnings: no matching game user found to playerid', 'internal', 'warn');
		}

		const newWinnings = gameId.horseWinnings + amount;
		if(newWinnings >= MAX_INT){
			gameId.horseWinnings = MAX_INT;
		}
		else if(newWinnings <= -MAX_INT){
			gameId.horseWinnings = -MAX_INT;
		}
		else{
			gameId.horseWinnings = newWinnings;
		}

		this.gameUserQueue.chain();
		return gameId;
	}

	public incrementHorseBetWins(playerid: GameIdentity['playerid'], place: keyof GameIdentity['horseBetWins']): GameIdentity {
		assertGamesEnabled(this.deps.configService, 'incrementHorseBetWins');
		assertHorseRacingEnabled(this.deps.configService, 'incrementHorseBetWins');

		const gameId = this.gameUsers.get(playerid);
		if(!gameId){
			throw new AppError('increment horse bet wins: no matching game user found to playerid', 'internal', 'warn');
		}

		gameId.horseBetWins[place]++;
		this.gameUserQueue.chain();
		return gameId;
	}

	public setHorseBetBiggestWin(playerid: GameIdentity['playerid'], payout: number, stake: number): GameIdentity {
		assertGamesEnabled(this.deps.configService, 'setHorseBetBiggestWin');
		assertHorseRacingEnabled(this.deps.configService, 'setHorseBetBiggestWin');
		const gameId = this.gameUsers.get(playerid);

		if(!gameId){
			throw new AppError('set horse bet biggest win: no matching game user found to playerid', 'internal', 'warn');
		}

		gameId.horseBetBiggestWin = {payout: payout, stake: stake};
		this.gameUserQueue.chain();
		return gameId;
	}

	public setFishingBestCatch(playerid: GameIdentity['playerid'], bestCatch: string, value: number): GameIdentity {
		assertGamesEnabled(this.deps.configService, 'setFishingBestCatch');
		assertFishingEnabled(this.deps.configService, 'setFishingBestCatch');

		const gameId = this.gameUsers.get(playerid);
		if(!gameId){
			throw new AppError('set fishing best catch: no matching game user found to playerid', 'internal', 'warn');
		}

		gameId.fishingBestCatch = bestCatch;
		gameId.fishingBestCatchValue = Math.ceil(value);

		this.gameUserQueue.chain();
		return gameId;
	}

	public addFishingFishCaught(playerid: GameIdentity['playerid'], fishCaught: string): GameIdentity{
		assertGamesEnabled(this.deps.configService, 'addFishingFishCaught');
		assertFishingEnabled(this.deps.configService, 'addFishingFishCaught');

		const gameId = this.gameUsers.get(playerid);
		if(!gameId){
			throw new AppError('add fishing fish caught: no matching game user found to playerid', 'internal', 'warn');
		}
		if(gameId.fishingFishCaught.includes(fishCaught)){
			throw new AppError('add fishing fish caught: duplicate entry call', 'bug');
		}

		gameId.fishingFishCaught.push(fishCaught);
		this.gameUserQueue.chain();
		return gameId;
	}

	public incrementFishingCatches(playerid: GameIdentity['playerid']): GameIdentity {
		assertGamesEnabled(this.deps.configService, 'incrementFishingCatches');
		assertFishingEnabled(this.deps.configService, 'incrementFishingCatches');

		const gameId = this.gameUsers.get(playerid);
		if(!gameId){
			throw new AppError('increment fishing catches: no matching game user found to playerid', 'internal', 'warn');
		}

		gameId.fishingCatches++;
		this.gameUserQueue.chain();
		return gameId;
	}

	public addFishingWinnings(playerid: GameIdentity['playerid'], pointsadd: number): GameIdentity{
		assertGamesEnabled(this.deps.configService, 'addFishingWinnings');
		assertFishingEnabled(this.deps.configService, 'addFishingWinnings');
		if(pointsadd <= 0){
			throw new AppError('addFishingWinnings called with negative value', 'bug');
		}

		const gameId = this.gameUsers.get(playerid);
		if(!gameId){
			throw new AppError('add fishing winnings: no matching game user found to playerid', 'internal', 'warn');
		}

		const amount = Math.round(pointsadd);
		const newPoints = gameId.fishingWinnings + amount;
		if(newPoints >= MAX_INT){
			gameId.fishingWinnings = MAX_INT;
		}
		else{
			gameId.fishingWinnings = newPoints;
		}
		this.gameUserQueue.chain();

		return gameId;
	}

	private buildDefaultGameIdentity(): DefaultGameIdentity{
		return{
			gamePoints: Math.round(this.deps.configService.getGameConfig().pointStartAmt),
			lastGame: new Date(0),
			horseWinnings: 0,
			horseBetWins: {firsts: 0, seconds: 0, thirds: 0},
			horseBetBiggestWin: {payout: 0, stake: 0},
			duelingWins: 0,
			duelingHonor: 0,
			blackjackWinnings: 0,
			blackjackBlackjacks: 0,
			fishingFishCaught: [],
			fishingCatches: 0,
			fishingWinnings: 0,
			fishingBestCatch: null,
			fishingBestCatchValue: null,

		};
	}

	private fetchGameUsersStrict(): unknown{
		if(!existsFile(this.deps.gameUsersPath)){
			throw new AppError(`game users file not found at ${this.deps.gameUsersPath}`, 'internal', 'warn');
		}
		return readJsonFile(this.deps.gameUsersPath);
	}

	private resolveGameUsersStrict(input: unknown): Map<GameIdentity['playerid'], GameIdentity>{
		if(!isUnknownArray(input)){
			throw new AppError('game user data was not an array, refusing to reload', 'internal', 'warn');
		}

		const resolvedGameUsers = new Map<GameIdentity['playerid'], GameIdentity>();
		const defaultGameId = this.buildDefaultGameIdentity();

		for(const entry of input){
			if(!isUnknownArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string'){
				throw new AppError('malformed game user record found, refusing to reload', 'internal', 'warn');
			}

			const [playerid, raw] = entry;
			const [gameIdentity, failures] = mergeIdentityDefaults(raw, aType.gid, defaultGameId, GameIdentitySchema);

			if(failures.length > 0 || gameIdentity === null || gameIdentity.playerid !== playerid || gameIdentity.gamePoints > MAX_INT){
				throw new AppError('game user record failed validation, refusing to reload', 'internal', 'warn');
			}

			resolvedGameUsers.set(playerid, gameIdentity);
		}

		return resolvedGameUsers;
	}

	private assignGameUsers(resolvedGameUsers: Map<GameIdentity['playerid'], GameIdentity>): void {
		this.gameUsers = resolvedGameUsers;
		this.gameUserQueue.chain();
	}

	private async saveGameUsers(): Promise<void> {
		try{
			await writeJsonFile(this.deps.gameUsersPath, Array.from(this.gameUsers.entries()));
		}
		catch(error: unknown){
			handleError(error, 'Save Game Users');
		}
	}

	private initializeGameUsers(): void {
		try{
			const raw = this.fetchGameUsers();
			const [resolvedGameUsers, resolveFailures] = this.resolveGameUsers(raw);

			if(resolveFailures.length > 0){
				console.error(`Load Game Users found ${resolveFailures.length} field failure(s) across all records, writing repair file`);
				createJsonFile(getRepairPath(this.deps.gameUsersPath), resolveFailures);
			}

			this.assignGameUsers(resolvedGameUsers);
			console.log(`${resolvedGameUsers.size} game users loaded from disk.`);
		}
		catch(error: unknown){
			handleError(error, 'Load Game Users (Startup)');
			this.gameUsers = new Map();
		}
	}

	private fetchGameUsers(): unknown{
		const gameUsers: unknown[] = [];
		try{
			if(!existsFile(this.deps.gameUsersPath)){
				createJsonFile(this.deps.gameUsersPath, gameUsers);
				return gameUsers;
			}
			return readJsonFile(this.deps.gameUsersPath);
		}
		catch(error: unknown){
			handleError(error);
			return gameUsers;
		}
	}

	private resolveGameUsers(input: unknown): [Map<GameIdentity['playerid'], GameIdentity>, KeyedParseFailureRecord[]]{
		const resolvedGameUsers = new Map<GameIdentity['playerid'], GameIdentity>();
		const failures: KeyedParseFailureRecord[] = [];

		if(!isUnknownArray(input)){
			console.warn('Game user data was not an array, starting fresh');
			return [resolvedGameUsers, failures];
		}

		const defaultGameId = this.buildDefaultGameIdentity();

		for(const entry of input){
			if(!isUnknownArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string'){
				console.warn('Skipping malformed game user record entry');
				continue;
			}

			const [playerid, raw] = entry;
			try{
				const [gameIdentity, mergeFailures] = mergeIdentityDefaults(raw, aType.gid, defaultGameId, GameIdentitySchema);

				if(mergeFailures.length > 0){
					for(const failure of mergeFailures){
						failures.push({
							...failure,
							recordKey: playerid
						});
					}
				}
				if(gameIdentity === null){
					//unrecoverable field, returned as failure from merge
					continue;
				}
				if(gameIdentity.playerid !== playerid){
					failures.push({
						raw: raw,
						label: aType.gid,
						field: 'playerid',
						invalidValue: gameIdentity.playerid,
						substitutedValue: playerid,
						recordKey: playerid
					});
					continue;
				}

				if(gameIdentity.gamePoints > MAX_INT){
					failures.push({
						raw: raw,
						label: aType.gid,
						field: 'gamePoints',
						invalidValue: gameIdentity.gamePoints,
						substitutedValue: undefined,
						recordKey: playerid
					});
					continue;
				}

				resolvedGameUsers.set(playerid, gameIdentity);
			}
			catch(error: unknown){
				handleError(error, `Load Game Users (Record ${playerid})`);
				continue;
			}
		}

		return [resolvedGameUsers, failures];
	}
}
