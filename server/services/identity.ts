import { readFileSync, existsSync } from 'fs';
import { mkdir, writeFile } from "fs/promises";
import { dirname } from 'path';

import { v4 as uuidv4 } from 'uuid';

import { IdentitySchema} from '../../shared/schema'
import type { DefaultIdentity, Identity } from '../../shared/schema'

import { ModerationService } from './moderation';
import { StateService } from './state';
import type { SafeString } from './moderation';

import { mergeDefaults } from '../utils/defaults';
import { getDisplayNick, getDisplayColor } from '../utils/format';

export interface IdentityServiceDependencies{
	moderationService: ModerationService;
	stateService: StateService;

	usersPath: string;
}

export class IdentityService {
	private users: Map<string, Identity> = new Map();
	private registeredNicks: Map<string, string> = new Map();
	private userQ = Promise.resolve();

	private deps: IdentityServiceDependencies;
	constructor(dependencies: IdentityServiceDependencies){
		this.deps = dependencies;
		
		try{
			const count =this.loadUsers();
			console.log(`loaded ${count} users from disk`);
		}
		catch(error: unknown){
			if(error instanceof Error){
				console.error('WARNING: user error load:', error.message);
			} 
			else{
				console.error("Unexpected non-error thrown:", error);
			}
		}
		
		this.deps.stateService.events.on("afk-check", guid => {
			this.toggleAfk(guid); 
		})
	}

	public setNick(guid: string | null, nick: SafeString): Identity{
		//Returning user flow
		if(guid && this.users.has(guid)){
			const user = this.users.get(guid)!;
			const oldNick = getDisplayNick(user.nick);

			if(nick === oldNick){
				throw new Error("that's already your name silly")
			}

			//allow capitilzation changes
			if(nick.toLowerCase() !== oldNick.toLowerCase() && this.registeredNicks.has(nick.toLowerCase())){
				throw new Error('nickname is already in use');
			}

			this.registeredNicks.delete(oldNick.toLowerCase());
			this.registeredNicks.set(nick.toLowerCase(), guid);

			const color = getDisplayColor(user.nick);
			user.nick = color + nick;
			user.lastChanged = new Date();
			this.saveUserQueue();
			return user;
		}
		//New user flow
		else{
			if(this.registeredNicks.has(nick.toLowerCase())){
				throw new Error('nickname is already in use');
		}

		const newGuid = guid || uuidv4();
		const newIdentity: Identity = {
			guid: newGuid,
			nick: ('#000000') + nick,
			...this.buildDefault()
		}

		this.users.set(newGuid, newIdentity);
		this.registeredNicks.set(nick.toLowerCase(), newGuid);
		this.saveUserQueue();
		return newIdentity;
		}
	}

	public setColor(guid: string, color: SafeString): Identity{
		const user = this.users.get(guid)!;
		user.nick = color.toUpperCase() + getDisplayNick(user.nick)
		user.lastChanged = new Date();
		this.saveUserQueue();
		return user;
	}

	public toggleAfk(guid: string): Identity {
		const user = this.users.get(guid);
		if(!user){
			throw new Error('afk: no matching user found to GUID')
		}
		if(user.isAfk){
			user.isAfk = false;
			this.saveUserQueue();
		}
		else{
			user.isAfk = true;
			this.saveUserQueue();
		}
		return user;
	}

	public setStatus(guid: string, status: SafeString): Identity {
		const user = this.users.get(guid);

		if(!user){
			throw new Error('status: no matching user found to GUID');
		}

		if(user.status === status){
			throw new Error('already your status big dog');
		}

		user.status = status;
		user.lastChanged = new Date();
		this.saveUserQueue();
		return user;
	}

	public setLastMessage(guid: string, msgdate: number, clearAfk = true): Identity {
		const user = this.users.get(guid);
		const newDate = msgdate;
		if(!user){
			throw new Error('set last message: no matching user found to GUID')
		}
		user.lastMessage = new Date(newDate);
		if(clearAfk && user.isAfk){
			user.isAfk = false;
		}
		this.saveUserQueue();
		return user;
	}

	public getUser(guid: string): Identity {
		const user = this.users.get(guid);
		if(!user){
			throw new Error('get user: no matching user found to GUID')
		}
		return user;
	}

	public getUserByNick(cleanNick: string): Identity {
		const guid = this.registeredNicks.get(cleanNick.trim().toLowerCase());
		if(!guid){
			throw new Error(`couldn't find user with nickname ${cleanNick}`);
		}
		const user = this.users.get(guid);
		if(!user){
			throw new Error(`couldn't find user with nickname ${cleanNick}`);
		}
		return user;
	}
	

	public deleteUser(guid: string){
		const user = this.users.get(guid);
		if(!user){
			throw new Error('delete user: no matching user found to GUID')
		}
		const cleanNick = getDisplayNick(user.nick);
		this.registeredNicks.delete(cleanNick.toLowerCase());
		this.users.delete(guid);
		this.saveUserQueue();
	}

	public reloadUsers(): number{
		try{
			const reload = this.loadUsers();
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

	private buildDefault(): DefaultIdentity{
		return{
			status: 'online',
			lastMessage: new Date(0),
			lastChanged: new Date(),
			isMod: false,
			isAfk: false,
			miniMute: false,
			miniPoints: this.deps.stateService.getMiniConfig().pointDefault
		}
	}

	private loadUsers(): number {
		try{
			if(!existsSync(this.deps.usersPath)){
				throw new Error('no users.json file to load')
			}

			const data = readFileSync(this.deps.usersPath, 'utf-8');
			const parseData: [string, unknown][] = JSON.parse(data);
			const defaultId = this.buildDefault();

			this.users = new Map();
			this.registeredNicks.clear();

			for (const [guid, raw] of parseData){
				const identity = mergeDefaults(raw, defaultId, IdentitySchema);

				if(!identity.guid || !identity.nick){
					console.warn(`skipping invalid user ${guid}: missing guid or nick`);
					continue;
				}

				this.users.set(guid, identity);

				const existingNick = getDisplayNick(identity.nick);
				this.registeredNicks.set(existingNick.toLowerCase(), guid);
			}
			this.saveUserQueue();
			return this.users.size;
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

	private saveUserQueue(){
		this.userQ = this.userQ.then(() => this.saveUsers());
	}

	private async saveUsers(){
		try{
			const dir = dirname(this.deps.usersPath);
			await mkdir(dir, {recursive: true});

			const data = JSON.stringify(Array.from(this.users.entries()), null, 4);

			await writeFile(this.deps.usersPath, data);
		} 
		catch(error: unknown){
			if(error instanceof Error){			
				console.error('failed to save user data', `${error.message}`);
			} 
			else{
				console.error("Unexpected non-error thrown:", error);
			}
		}
	}
}