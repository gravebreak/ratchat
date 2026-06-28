import { readFileSync, existsSync } from 'fs';
import { mkdir, writeFile } from "fs/promises";
import { dirname } from 'path';

import { GameIdentitySchema } from '../../../shared/schema'
import type { DefaultGameIdentity, GameIdentity } from '../../../shared/schema'

import { StateService } from '../state';

import { mergeDefaults } from '../../utils/defaults';

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
			if(error instanceof Error){
				console.error('WARNING: game user error load:', error.message);
			} 
			else{
				console.error("Unexpected non-error thrown:", error);
			}
		}
	}

	public setLastGame(guid: string, gamedate: number): GameIdentity {
		if(!this.deps.stateService.getGameConfig().enabled){
			throw new Error('minigames are not enabled');
		}

		const user = this.gameUsers.get(guid);
		const newDate = gamedate;
		if(!user){
			throw new Error('set last game: no matching game user found to GUID')
		}
		user.lastGame = new Date(newDate);

		this.saveGameUserQueue();
		return user;
	}

	public setGamePoints(guid:string, rawnumber: number): GameIdentity{
		if(!this.deps.stateService.getGameConfig().enabled){
			throw new Error('minigames are not enabled');
		}
		
		const gameId = this.gameUsers.get(guid);
		const amount = Math.round(rawnumber);
		if(!gameId){
			throw new Error('set game points: no matching game user found to GUID')
		}
		const newPoints = gameId.gamePoints + amount;
		if(newPoints >= MAX_INT){
			gameId.gamePoints = MAX_INT;
			throw new Error('you broke the game, max points gained.')
		}
		if(newPoints < 0){
			throw new Error("can't pay more than you have.")
		}
		gameId.gamePoints = newPoints;

		this.saveGameUserQueue();
		return gameId;
	}

	public setGamePointsDefault(guid:string): GameIdentity{
		if(!this.deps.stateService.getGameConfig().enabled){
			throw new Error('minigames are not enabled');
		}

		const gameId = this.gameUsers.get(guid);
		if(!gameId){
			throw new Error('set game points to default: no matching game user found to GUID')
		}
		const newPoints = Math.round(this.deps.stateService.getGameConfig().pointStartAmt);
		gameId.gamePoints = newPoints;
		return gameId;
	}

	public getGameUser(guid: string): GameIdentity {
		const user = this.gameUsers.get(guid);
		if(!user){
			throw new Error('get game user: no matching game user found to GUID')
		}
		this.saveGameUserQueue();
		return user;
	}

	public createGameUser(inputGuid: string): GameIdentity{
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
			throw new Error('delete game user: no matching game user found to GUID')
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
			if(error instanceof Error){
				throw error
			} 
			else{
				console.error("Unexpected non-error thrown:", error);
				throw new Error("Unexpected error");
			}
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
				throw new Error('no users.json file to load')
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
			if(error instanceof Error){
				throw error
			} 
			else{
				console.error("Unexpected non-error thrown:", error);
				throw new Error("Unexpected error");
			}
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
			if(error instanceof Error){			
				console.error('failed to save game user data', `${error.message}`);
			} 
			else{
				console.error("Unexpected non-error thrown:", error);
			}
		}
	}
}