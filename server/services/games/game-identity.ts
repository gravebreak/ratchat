import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { mkdir, writeFile } from "fs/promises";
import { dirname } from 'path';

import { GameIdentitySchema } from '../../../shared/schema';
import type { DefaultGameIdentity, GameIdentity } from '../../../shared/schema';

import { StateService } from '../state';

import { mergeDefaults } from '../../utils/defaults';
import { AppError, handleError } from '../../utils/errors';

const MAX_INT = 4294967295;

export interface GameIdentityServiceDependencies{
	stateService: StateService;

	gameUsersPath: string;
}

export class GameIdentityService {
	private gameUsers: Map<string, GameIdentity> = new Map();
	private gameUserQ = Promise.resolve();

	private deps: GameIdentityServiceDependencies;
	constructor(dependencies: GameIdentityServiceDependencies){
		this.deps = dependencies;
		
		try{
			const count =this.loadGameUsers();
			console.log(`loaded ${count} game users from disk`);
		}
		catch(error: unknown){
			handleError(error, 'Load Game Users (Startup)');
		}
	}

	public setLastGame(guid: string, gamedate: number): GameIdentity {
		if(!this.deps.stateService.getGameConfig().enabled){
			throw new AppError('setLastGame call wih minigames disabled', 'bug');
		}

		const user = this.gameUsers.get(guid);
		const newDate = gamedate;
		if(!user){
			throw new AppError('set last game: no matching game user found to GUID', 'internal', 'warn');
		}
		user.lastGame = new Date(newDate);

		this.saveGameUserQueue();
		return user;
	}

	public setGamePoints(guid:string, rawnumber: number): GameIdentity{
		if(!this.deps.stateService.getGameConfig().enabled){
			throw new AppError('setGamePoints call wih minigames disabled', 'bug');;
		}
		
		const gameId = this.gameUsers.get(guid);
		const amount = Math.round(rawnumber);
		if(!gameId){
			throw new AppError('set game points: no matching game user found to GUID', 'internal', 'warn');
		}
		const newPoints = gameId.gamePoints + amount;
		if(newPoints >= MAX_INT){
			gameId.gamePoints = MAX_INT;
			this.saveGameUserQueue();
			throw new AppError('you won the game, max points gained. use /broke to start again', 'user');
		}
		if(newPoints < 0){
			throw new AppError("you can't pay more than you have.", 'user');
		}
		gameId.gamePoints = newPoints;

		this.saveGameUserQueue();
		return gameId;
	}

	public setGamePointsDefault(guid:string): GameIdentity{
		if(!this.deps.stateService.getGameConfig().enabled){
			throw new AppError('setGamePointsDefault call wih minigames disabled', 'bug');;
		}

		const gameId = this.gameUsers.get(guid);
		if(!gameId){
			throw new AppError('set game points default: no matching game user found to GUID', 'internal', 'warn');
		}
		const newPoints = Math.round(this.deps.stateService.getGameConfig().pointStartAmt);
		gameId.gamePoints = newPoints;
		this.saveGameUserQueue();
		return gameId;
	}

	public existsGameUser(guid: string): boolean{
		const user = this.gameUsers.get(guid);
		if(user){
			return true;
		}
		return false;
	}

	public getGameUser(guid: string): GameIdentity {
		const user = this.gameUsers.get(guid);
		if(!user){
			throw new AppError('get game user: no matching game user found to GUID', 'internal', 'warn');
		}
		return user;
	}

	public createGameUser(inputGuid: string): GameIdentity{
		if(this.gameUsers.has(inputGuid)){
			throw new AppError('create game user: game user already exists for GUID', 'internal', 'warn');
		}
		const newGameIdentity : GameIdentity = {
			guid: inputGuid,
			...this.buildGameDefault()
		};
		this.gameUsers.set(inputGuid, newGameIdentity);
		this.saveGameUserQueue();
		return newGameIdentity;
	}

	public deleteGameUser(guid: string){
		const user = this.gameUsers.get(guid);
		if(!user){
			throw new AppError('delete game user: no matching game user found to GUID', 'internal', 'error');
		}
		this.gameUsers.delete(guid);
		this.saveGameUserQueue();
	}

	public reloadGameUsers(): number{
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

	private buildGameDefault(): DefaultGameIdentity{
		return{
			gamePoints: Math.round(this.deps.stateService.getGameConfig().pointStartAmt),
			lastGame: new Date(0),
		};
	}

	private loadGameUsers(): number {
		try{
			if(!existsSync(this.deps.gameUsersPath)){
				this.gameUsers = new Map();
				const dir = dirname(this.deps.gameUsersPath);
				mkdirSync(dir, {recursive: true});
				writeFileSync(this.deps.gameUsersPath, '[]');
				return 0;
			}

			const data = readFileSync(this.deps.gameUsersPath, 'utf-8');
			const parseData: [string, unknown][] = JSON.parse(data);
			const defaultGameId = this.buildGameDefault();

			this.gameUsers = new Map();

			for (const [guid, raw] of parseData){
				const gameIdentity = mergeDefaults(raw, defaultGameId, GameIdentitySchema);

				if(!gameIdentity.guid){
					console.warn(`skipping invalid game user ${guid}: missing guid`);
					continue;
				}

				this.gameUsers.set(guid, gameIdentity);
			}
			this.saveGameUserQueue();
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

	private saveGameUserQueue(){
		this.gameUserQ = this.gameUserQ.then(() => this.saveGameUsers());
	}

	private async saveGameUsers(){
		try{
			const dir = dirname(this.deps.gameUsersPath);
			await mkdir(dir, {recursive: true});

			const data = JSON.stringify(Array.from(this.gameUsers.entries()), null, 4);

			await writeFile(this.deps.gameUsersPath, data);
		} 
		catch(error: unknown){
			handleError(error, 'Save Game Users');
		}
	}
}