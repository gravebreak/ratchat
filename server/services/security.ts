import { Socket } from 'socket.io';

import { handleError, AppError } from '../utils/errors';
import { hashIP } from '../utils/hash';
import { createSaveQueue } from '../utils/queue';
import { existsFile, createJsonFile, readJsonFile, writeJsonFile } from '../utils/serialize';

export interface SecurityServiceDependencies{
	bansPath: string;
}

export class SecurityService{
	private bans: Map<string, Date> = new Map();
	private banQueue = createSaveQueue(() => this.saveBans());
	
	private deps: SecurityServiceDependencies;
	constructor(dependencies: SecurityServiceDependencies){
		this.deps = dependencies;
		this.init();
	}

	private init(): void {
		this.initializeBans();
	}
	
	public existsBan(unhashed: string): boolean {
		try{
			const hash = hashIP(unhashed);
			if(this.bans.has(hash)){
				return true;
			}
			else{
				return false;
			}
		}
		catch(error: unknown){
			if(error instanceof AppError){
				throw error;
			}
			handleError(error, 'Check Ban');
			
			throw new AppError(`failed to check ban: unknown error`, 'user');
		}
	}

	public setBan(socket: Socket): void {
		const banIP = hashIP(socket.handshake.address);
		this.bans.set(banIP, new Date());
		this.banQueue.chain();
	}

	private async saveBans(): Promise<void> {
		try{
			await writeJsonFile(this.deps.bansPath, Array.from(this.bans.entries()));
		}
		catch(error: unknown){
			handleError(error, 'Ban Save');
		}
	}

	private initializeBans(): void {
		const loadedbans = this.fetchBans();
		const validbans = this.resolveBans(loadedbans);
		this.bans = validbans;
	}

	private fetchBans(): unknown{
		const bans: [string, Date][] = [];
		try{
			if(!existsFile(this.deps.bansPath)){
				createJsonFile(this.deps.bansPath, bans);
				return bans;
			}

			return readJsonFile(this.deps.bansPath);
		}
		catch(error: unknown){
			handleError(error);
			return bans;
		}
	}

	private resolveBans(input: unknown): Map<string, Date>{
		if(!Array.isArray(input)){
			console.error('Ban data was not an array, starting fresh');
			return new Map();
		}

		const validEntries: [string, Date][] = [];
		for(const entry of input){
			if(Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string'){
				const date = new Date(entry[1]);
				if(!isNaN(date.getTime())){
					validEntries.push([entry[0], date]);
				}
			}
		}
		console.log(`loaded ${validEntries.length} bans`);
		return new Map(validEntries);
	}
}
