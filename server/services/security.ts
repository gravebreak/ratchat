import { readFileSync, existsSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import { dirname } from 'path';

import { Server } from "socket.io";

import { mType } from "../../shared/schema";
import type { Identity } from "../../shared/schema.ts";

import { StateService } from "./state";
import { DispatchService } from "./dispatch";
import { IdentityService } from "./identity";

import { hashIP } from '../utils/hash.js'

export interface SecurityServiceDependencies{
	stateService: StateService;
	dispatchService: DispatchService;
	identityService: IdentityService;
	
	bansPath: string;
	io: Server;
}

export class SecurityService{
	private bans: Map<string, Date> = new Map();
	private banQ = Promise.resolve()
	
	private deps: SecurityServiceDependencies;
	constructor(dependencies: SecurityServiceDependencies){
		this.deps = dependencies;
		
		this.loadBans();
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
			if(error instanceof Error){
				throw error
			} 
			else{
				console.error("Unexpected non-error thrown:", error);
				throw new Error("Unknown error")
			}
		}
	}

	public banUser(banUser: Identity){
		const socketUsers = this.deps.stateService.getSocketUsers();
		let socketIDs = [] as string[]

		socketUsers.forEach((user, id) => {
			if(user.guid === banUser.guid){
				socketIDs.push(id)
			}
		})

		if(socketIDs.length === 0){
			throw new Error ("couldn't find any connections from that user")
		}

		socketIDs.forEach((sid) => {
			const socket = this.deps.io.sockets.sockets.get(sid);
			if(socket){
				try{
					const banIP = hashIP(socket?.handshake.address);
					this.bans.set(banIP, new Date());

					this.deps.dispatchService.sendClearLocalData(socket, banUser.guid);
					this.deps.dispatchService.sendSystemChat(socket, mType.error, 'You have been banned.');
					this.deps.stateService.deleteSocketUser(this.deps.io, sid);
					socket.disconnect(true);
				}
				catch(error: unknown){
					if(error instanceof Error){
						console.error('HASH ERROR:', error.message)
						throw error;
					} 
					else{
						console.error("Unexpected non-error thrown:", error);
						throw new Error("Unknown error")
					}
				}
			}
			else{
				throw new Error("couldn't get sockets for user");
			}
		});

		this.deps.identityService.deleteUser(banUser.guid);
		this.saveQueue();
	}

	private loadBans(){
		try{
			if(!existsSync(this.deps.bansPath)){
				return;
			}

			const data = readFileSync(this.deps.bansPath, 'utf-8');
			const parseData: [string, Date][] = JSON.parse(data);

			this.bans = new Map(parseData);

			console.log(`loaded ${this.bans.size} bans`);
		} 
		catch(error: unknown){
			if(error instanceof Error){
				console.error('WARNING: Failed to load ban data: ', `${error.message}`);
			} 
			else{
				console.error("Unexpected non-error thrown:", error);
			}

		}
	}

	private saveQueue(){
		this.banQ = this.banQ.then(() => this.saveBans());
	}

	private async saveBans(){
		try{
			const dir = dirname(this.deps.bansPath);
			await mkdir(dir, {recursive: true});

			const data = JSON.stringify(Array.from(this.bans.entries()), null, 4);

			await writeFile(this.deps.bansPath, data);
		}
		catch(error: unknown){
			if(error instanceof Error){
				console.error("WARNING: failed to save ban user data: ", error.message);
			} 
			else{
				console.error("Unexpected non-error thrown:", error);
			}
		}
	}
}
