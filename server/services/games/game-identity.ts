import { GameIdentitySchema } from '../../defs/def-identity';
import { aType } from '../../defs/def-parse';
import type { GameIdentity, DefaultGameIdentity } from '../../defs/def-identity';
import type { KeyedParseFailureRecord } from '../../defs/def-parse';

import { StateService } from '../state';

import { AppError, handleError } from '../../utils/errors';
import { mergeIdentityDefaults } from '../../utils/parse';
import { createSaveQueue } from '../../utils/queue';
import { existsRepairFile, getRepairPath } from '../../utils/repair';
import { existsFile, createJsonFile, readJsonFile, writeJsonFile } from '../../utils/serialize';

const MAX_INT = 4294967295;

export interface GameIdentityServiceDependencies{
	stateService: StateService;

	gameUsersPath: string;
}

export class GameIdentityService {
	private gameUsers: Map<string, GameIdentity> = new Map();
	private gameUserQueue = createSaveQueue(() => this.saveGameUsers());

	private deps: GameIdentityServiceDependencies;
	constructor(dependencies: GameIdentityServiceDependencies){
		this.deps = dependencies;

		if(existsRepairFile(this.deps.gameUsersPath)){
			throw new AppError(`unresolved repair file found for ${this.deps.gameUsersPath} — review and delete before restarting`, 'internal', 'error');
		}
		
		try{
			if(!existsFile(this.deps.gameUsersPath)){
				createJsonFile(this.deps.gameUsersPath, []);
			}
			const count = this.loadGameUsers();
			console.log(`loaded ${count} game users from disk`);
		}
		catch(error: unknown){
			handleError(error, 'Load Game Users (Startup)');
		}
	}

	public setLastGame(playerid: string, gamedate: number): GameIdentity {
		if(!this.deps.stateService.getGameConfig().enabled){
			throw new AppError('setLastGame call with minigames disabled', 'bug');
		}

		const user = this.gameUsers.get(playerid);
		const newDate = gamedate;
		if(!user){
			throw new AppError('set last game: no matching game user found to playerid', 'internal', 'warn');
		}
		user.lastGame = new Date(newDate);

		this.gameUserQueue.chain();
		return user;
	}

	public setGamePoints(playerid:string, rawnumber: number): GameIdentity{
		if(!this.deps.stateService.getGameConfig().enabled){
			throw new AppError('setGamePoints call with minigames disabled', 'bug');
		}
		
		const gameId = this.gameUsers.get(playerid);
		const amount = Math.round(rawnumber);
		if(!gameId){
			throw new AppError('set game points: no matching game user found to playerid', 'internal', 'warn');
		}
		const newPoints = gameId.gamePoints + amount;
		if(newPoints >= MAX_INT){
			gameId.gamePoints = MAX_INT;
			this.gameUserQueue.chain();
			throw new AppError('you won the game, max points gained. use /broke to start again', 'user');
		}
		if(newPoints < 0){
			throw new AppError("you can't pay more than you have.", 'user');
		}
		gameId.gamePoints = newPoints;

		this.gameUserQueue.chain();
		return gameId;
	}

	public setGamePointsDefault(playerid:string): GameIdentity{
		if(!this.deps.stateService.getGameConfig().enabled){
			throw new AppError('setGamePointsDefault call with minigames disabled', 'bug');
		}

		const gameId = this.gameUsers.get(playerid);
		if(!gameId){
			throw new AppError('set game points default: no matching game user found to playerid', 'internal', 'warn');
		}
		const newPoints = Math.round(this.deps.stateService.getGameConfig().pointStartAmt);
		gameId.gamePoints = newPoints;
		this.gameUserQueue.chain();
		return gameId;
	}

	public existsGameUser(playerid: string): boolean{
		const user = this.gameUsers.get(playerid);
		if(user){
			return true;
		}
		return false;
	}
	
	public getGameUsersMap(): Map<string, GameIdentity> {
		const copy = new Map<string, GameIdentity>();

		for(const [playerid, gameIdentity] of this.gameUsers){
			copy.set(playerid, structuredClone(gameIdentity));
		}

		return copy;
	}

	public getGameUser(playerid: string): GameIdentity {
		const user = this.gameUsers.get(playerid);
		if(!user){
			throw new AppError('get game user: no matching game user found to playerid', 'internal', 'warn');
		}
		return user;
	}

	public createGameUser(inputPlayer: string): GameIdentity{
		if(this.gameUsers.has(inputPlayer)){
			throw new AppError('create game user: game user already exists for playerid', 'internal', 'warn');
		}
		const newGameIdentity : GameIdentity = {
			playerid: inputPlayer,
			...this.buildDefaultGameIdentity()
		};
		this.gameUsers.set(inputPlayer, newGameIdentity);
		this.gameUserQueue.chain();
		return newGameIdentity;
	}

	public deleteGameUser(playerid: string){
		const user = this.gameUsers.get(playerid);
		if(!user){
			throw new AppError('delete game user: no matching game user found to playerid', 'internal', 'error');
		}
		this.gameUsers.delete(playerid);
		this.gameUserQueue.chain();
	}

	public reloadGameUsers(): number{
		if(!existsFile(this.deps.gameUsersPath)){
			throw new AppError(`game users file not found at ${this.deps.gameUsersPath}`, 'user');
		}

		try{
			const reload = this.loadGameUsers();
			return reload;
		}
		catch(error: unknown){
			if(error instanceof AppError){
				throw error;
			}

			handleError(error, 'Reload Game Users');
			
			throw new AppError(`failed to reload game users: unknown error`, 'user');
		}
	}

	private buildDefaultGameIdentity(): DefaultGameIdentity{
		return{
			gamePoints: Math.round(this.deps.stateService.getGameConfig().pointStartAmt),
			lastGame: new Date(0),
			blackjackWinnings: 0,
			blackjackBlackjacks: 0,
			duelingWins: 0,
			duelingHonor: 0,
			fishingFishCaught: [],
			fishingCatches: 0,
			fishingWinnings: 0,
			fishingBestCatch: null,
			fishingBestCatchValue: null,
			horseWinnings: 0,
			horseBetWins: 0
		};
	}

	private loadGameUsers(): number {
		try{
			if(!existsFile(this.deps.gameUsersPath)){
				throw new AppError('loadGameUsers called without existence check', 'bug');
			}
			const parseData = readJsonFile(this.deps.gameUsersPath) as [string, unknown][];
			const defaultGameId = this.buildDefaultGameIdentity();
			const repairPath = getRepairPath(this.deps.gameUsersPath);
			const allFailures: KeyedParseFailureRecord[] = [];

			const loadedGameUsers = new Map<string, GameIdentity>();

			for (const [playerid, raw] of parseData){
				try{
					const [gameIdentity, failures] = mergeIdentityDefaults(raw, defaultGameId, aType.gid, GameIdentitySchema);

					if(failures.length > 0){
						for(const failure of failures){
							allFailures.push({
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
						allFailures.push({
							raw: raw,
							schemaName: aType.gid,
							field: 'playerid',
							invalidValue: gameIdentity.playerid,
							substitutedValue: playerid,
							recordKey: playerid
						});
						continue;
					}

					if(gameIdentity.gamePoints > MAX_INT){
						allFailures.push({
							raw: raw,
							schemaName: aType.gid,
							field: 'gamePoints',
							invalidValue: gameIdentity.gamePoints,
							substitutedValue: undefined,
							recordKey: playerid
						});
						continue;
					}

					loadedGameUsers.set(playerid, gameIdentity);
				}
				catch(error: unknown){
					handleError(error, `Load Game Users (Record ${playerid})`);
					continue;
				}
			}

			if(allFailures.length > 0){
				console.error(`Load Game Users found ${allFailures.length} field failure(s) across all records, writing repair file`);
				createJsonFile(repairPath, allFailures);
			}

			this.gameUsers = loadedGameUsers;
			this.gameUserQueue.chain();
			return this.gameUsers.size;
		} 
		catch(error: unknown){
			if(error instanceof AppError){
				throw error;
			}
			handleError(error, 'Load Game Users');
			
			throw new AppError(`failed to load game users: unknown error`, 'user');
		}
	}

	private async saveGameUsers(){
		try{
			await writeJsonFile(this.deps.gameUsersPath, Array.from(this.gameUsers.entries()));
		} 
		catch(error: unknown){
			handleError(error, 'Save Game Users');
		}
	}
}