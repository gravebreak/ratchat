import { Server } from "socket.io";

import { mType } from "../../shared/schema";
import type { Identity } from "../../shared/schema.ts";

import { StateService } from "./state";
import { DispatchService } from "./dispatch";
import { IdentityService } from "./identity";

import { hashIP } from '../utils/hash.js';
import { handleError, AppError } from "../utils/errors";
import { createSaveQueue } from '../utils/queue';
import { existsFile, createJsonFile, readJsonFile, writeJsonFile } from '../utils/serialize';

export interface SecurityServiceDependencies{
	stateService: StateService;
	dispatchService: DispatchService;
	identityService: IdentityService;
	
	bansPath: string;
	io: Server;
}

export class SecurityService{
	private bans: Map<string, Date> = new Map();
	private banQueue = createSaveQueue(() => this.saveBans());
	
	private deps: SecurityServiceDependencies;
	constructor(dependencies: SecurityServiceDependencies){
		this.deps = dependencies;

		try{
			if(!existsFile(this.deps.bansPath)){
				createJsonFile(this.deps.bansPath, []);
			}
			this.loadBans();
		}
		catch(error: unknown){
			handleError(error, 'Load Bans (Startup)');
		}
	}
	
	public checkBan(unhashed: string): boolean {
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

	public banUser(target: Identity){
		const socketUsers = this.deps.stateService.getSocketUsersMap();
		let socketIDs = [] as string[];

		socketUsers.forEach((user, id) => {
			if(user.guid === target.guid){
				socketIDs.push(id);
			}
		});

		if(socketIDs.length === 0){
			throw new AppError ("couldn't find any connections from that user", 'user');
		}

		socketIDs.forEach((sid) => {
			const socket = this.deps.io.sockets.sockets.get(sid);
			if(socket){
				try{
					const banIP = hashIP(socket?.handshake.address);
					this.bans.set(banIP, new Date());

					this.deps.dispatchService.sendClearLocalData(socket, target.guid);
					this.deps.dispatchService.sendSystemChat(socket, mType.error, 'You have been banned.');
					this.deps.stateService.deleteSocketUser(this.deps.io, sid);
					socket.disconnect(true);
				}
				catch(error: unknown){
					handleError(error, 'Ban Loop');
				}
			}
			return;
		});

		this.deps.identityService.deleteUser(target.guid);
		this.banQueue.chain();
	}

	private loadBans(){
		try{
			if(!existsFile(this.deps.bansPath)){
				throw new AppError('loadBans called while file missing', 'bug');
			}
			const parseData = readJsonFile(this.deps.bansPath) as [string, Date][];
			this.bans = new Map(parseData);
			console.log(`loaded ${this.bans.size} bans`);
		} 
		catch(error: unknown){
			handleError(error, 'Ban Load');
		}
	}

	private async saveBans(){
		try{
			await writeJsonFile(this.deps.bansPath, Array.from(this.bans.entries()));
		}
		catch(error: unknown){
			handleError(error, 'Ban Save');
		}
	}
}
