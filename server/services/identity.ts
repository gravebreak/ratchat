import { v4 as uuidv4 } from 'uuid';

import { IdentitySchema } from '../defs/def-identity';
import { aType } from '../defs/def-parse';
import type { DefaultIdentity, Identity } from '../defs/def-identity';
import type { KeyedParseFailureRecord } from '../defs/def-parse';

import { ModerationService } from './moderation';
import { SecurityService } from './security';
import { StateService } from './state';
import { GameIdentityService } from './games/game-identity';
import type { SafeString } from './moderation';

import { handleError, AppError } from '../utils/errors';
import { getBaseNick, getNickColor } from '../utils/format';
import { mergeIdentityDefaults } from '../utils/parse';
import { createSaveQueue } from '../utils/queue';
import { existsRepairFile, getRepairPath } from '../utils/repair';
import { existsFile, createJsonFile, readJsonFile, writeJsonFile } from '../utils/serialize';

export interface IdentityServiceDependencies{
	moderationService: ModerationService;
	stateService: StateService;
	gameIdentityService: GameIdentityService;
	securityService: SecurityService;

	usersPath: string;
}

export class IdentityService {
	private users: Map<string, Identity> = new Map();
	private basenickIndex: Map<string, string> = new Map();
	private playeridIndex: Map<string, string> = new Map();
	private userQueue = createSaveQueue(() => this.saveUsers());

	private deps: IdentityServiceDependencies;
	constructor(dependencies: IdentityServiceDependencies){
		this.deps = dependencies;

		if(existsRepairFile(this.deps.usersPath)){
			throw new AppError(`unresolved repair file found for ${this.deps.usersPath} — review and delete before restarting`, 'internal', 'error');
		}
		
		try{
			if(!existsFile(this.deps.usersPath)){
				createJsonFile(this.deps.usersPath, []);
			}
			const count = this.loadUsers();
			console.log(`loaded ${count} users from disk`);
		}
		catch(error: unknown){
			handleError(error, 'Load Users (Startup)');
		}
			
		this.deps.stateService.events.on("afk-check", guid => {
			this.toggleAfk(guid); 
		});
	}

	public createNewUser(basenick: SafeString): Identity{
		if(this.basenickIndex.has(basenick.toLowerCase())){
			throw new AppError('nickname is already in use', 'user');
		}

		const newGuid = uuidv4();
		const newPlayerid = uuidv4();
		const newIdentity: Identity = {
			guid: newGuid,
			playerid: newPlayerid,
			fullnick: ('#000000') + basenick,
			...this.buildDefaultIdentity()
		};

		this.users.set(newIdentity.guid, newIdentity);
		this.basenickIndex.set(getBaseNick(newIdentity.fullnick).toLowerCase(), newIdentity.guid);
		this.playeridIndex.set(newIdentity.playerid, newIdentity.guid);

		try{
			this.deps.gameIdentityService.createGameUser(newPlayerid);
		}
		catch(error: unknown){
			this.users.delete(newGuid);
			this.basenickIndex.delete(basenick.toLowerCase());
			this.playeridIndex.delete(newPlayerid);

			if(error instanceof AppError){
				throw error;
			}

			handleError(error, 'New User Game User Create');

			throw new AppError('failed to create new user: unknown error', 'user');
		}

		this.userQueue.chain();
		return newIdentity;
	}

	public setBaseNick(guid: string, basenick: SafeString): Identity{
		if(!this.users.has(guid)){
			throw new AppError('set base nick: no matching user found to GUID', 'internal', 'warn');
		}

		const user = this.users.get(guid)!;
		const oldBaseNick = getBaseNick(user.fullnick);

		if(basenick === oldBaseNick){
			throw new AppError("that's already your name silly", 'user');
		}

		//allow capitilzation changes
		if(basenick.toLowerCase() !== oldBaseNick.toLowerCase() && this.basenickIndex.has(basenick.toLowerCase())){
			throw new AppError('nickname is already in use', 'user');
		}

		this.basenickIndex.delete(oldBaseNick.toLowerCase());
		this.basenickIndex.set(basenick.toLowerCase(), guid);

		const color = getNickColor(user.fullnick);
		user.fullnick = color + basenick;
		user.lastChanged = new Date();
		this.userQueue.chain();
		return user;
	}

	public setColor(guid: string, color: SafeString): Identity{
		const user = this.users.get(guid);
		if(!user){
			throw new AppError('set color: no matching user found to GUID', 'internal', 'warn');
		}
		user.fullnick = color.toUpperCase() + getBaseNick(user.fullnick);
		user.lastChanged = new Date();
		this.userQueue.chain();
		return user;
	}

	public toggleAfk(guid: string): Identity {
		const user = this.users.get(guid);
		if(!user){
			throw new AppError('toggle afk: no matching user found to GUID', 'internal', 'warn');
		}
		if(user.isAfk){
			user.isAfk = false;
			this.userQueue.chain();
		}
		else{
			user.isAfk = true;
			this.userQueue.chain();
		}
		return user;
	}

	public setStatus(guid: string, status: SafeString): Identity {
		const user = this.users.get(guid);

		if(!user){
			throw new AppError('set status: no matching user found to GUID', 'internal', 'warn');
		}

		if(user.status === status){
			throw new AppError('already your status big dog', 'user');
		}

		user.status = status;
		user.lastChanged = new Date();
		this.userQueue.chain();
		return user;
	}

	public setLastMessage(guid: string, msgdate: number, clearAfk = true): Identity {
		const user = this.users.get(guid);
		const newDate = msgdate;
		if(!user){
			throw new AppError('set last message: no matching user found to GUID', 'internal', 'warn');
		}
		user.lastMessage = new Date(newDate);
		if(clearAfk && user.isAfk){
			user.isAfk = false;
		}
		this.userQueue.chain();
		return user;
	}

	public existsUser(guid: string): boolean{
		const user = this.users.get(guid);
		if(user){
			return true;
		}
		return false;
	}

	public getUser(guid: string): Identity {
		const user = this.users.get(guid);
		if(!user){
			throw new AppError('get user: no matching user found to GUID', 'internal', 'warn');
		}
		return user;
	}

	public deleteUser(guid: string){
		const user = this.users.get(guid);
		if(!user){
			throw new AppError('delete user: no matching user found to GUID', 'internal', 'error');
		}
		const baseNick = getBaseNick(user.fullnick);

		try{
			this.deps.gameIdentityService.deleteGameUser(user.playerid);
		}
		catch(error: unknown){
			if(error instanceof AppError){
				throw error;
			}

			handleError(error, 'Delete User Game Identity Delete');

			throw new AppError('failed to delete user: unknown error', 'user');
		}

		this.basenickIndex.delete(baseNick.toLowerCase());
		this.playeridIndex.delete(user.playerid);
		this.users.delete(guid);
		this.userQueue.chain();
	}

	public existsUserByBaseNick(basenick: string): boolean{
		const guid = this.basenickIndex.get(basenick.trim().toLowerCase());
		if(!guid){
			return false;
		}
		const user = this.users.get(guid);
		if(!user){
			return false;
		}
		return true;
	}

	public setLastMessageByBaseNick(basenick: string, msgdate: number, clearAfk = true){
		const guid = this.basenickIndex.get(basenick.trim().toLowerCase());
		if(!guid){
			throw new AppError(`couldn't find user with nickname ${basenick}`, 'user');
		}
		this.setLastMessage(guid, msgdate, clearAfk);
	}

	public deleteUserByBaseNick(basenick: string, banned: boolean): void {
		const guid = this.basenickIndex.get(basenick.trim().toLowerCase());
		if(!guid){
			throw new AppError(`couldn't find user with nickname ${basenick}`, 'user');
		}

		this.deleteUser(guid);

		if(banned){
			this.deps.securityService.enforceBan(guid);
		}
	}

	public getFullNickByPlayerId(playerid: string): string{
		const guid = this.playeridIndex.get(playerid);
		if(!guid){
			throw new AppError('get full nick by player id: no matching user found to playerid', 'internal', 'warn');
		}

		const user = this.users.get(guid);
		if(!user){
			throw new AppError('get full nick by player id: playeridIndex entry found but no matching user for guid', 'internal', 'error');
		}

		return user.fullnick;
	}

	public reloadUsers(): number{
		if(!existsFile(this.deps.usersPath)){
			throw new AppError(`users file not found at ${this.deps.usersPath}`, 'user');
		}

		try{
			const reload = this.loadUsers();
			return reload;
		}
		catch(error: unknown){
			if(error instanceof AppError){
				throw error;
			}
			
			handleError(error, 'Reload Users');
			
			throw new AppError(`failed to reload users: unknown error`, 'user');
		}
	}

	private buildDefaultIdentity(): DefaultIdentity{
		return{
			status: 'online',
			lastMessage: new Date(0),
			lastChanged: new Date(),
			isMod: false,
			isAfk: false
		}
	}

	private loadUsers(): number {
		try{
			if(!existsFile(this.deps.usersPath)){
				throw new AppError('loadUsers called while file missing', 'bug');
			}
			const parseData = readJsonFile(this.deps.usersPath) as [string, unknown][];
			const defaultId = this.buildDefaultIdentity();
			const repairPath = getRepairPath(this.deps.usersPath);
			const allFailures: KeyedParseFailureRecord[] = [];

			const loadedUsers = new Map<string, Identity>();
			const loadedBaseNicks = new Map<string, string>();
			const loadedPlayerIds = new Map<string, string>();

			for (const [guid, raw] of parseData){
				try{
					const [identity, failures] = mergeIdentityDefaults(raw, defaultId, aType.id, IdentitySchema);

					if(failures.length > 0){
						for(const failure of failures){
							allFailures.push({
								...failure,
								recordKey: guid
							});
						}
					}

					if(identity === null){
						//unrecoverable field, returned as failure from merge
						continue;
					}

					if(identity.guid !== guid){
						allFailures.push({
							raw: raw,
							schemaName: aType.id,
							field: 'guid',
							invalidValue: identity.guid,
							substitutedValue: guid,
							recordKey: guid
						});
						continue;
					}

					loadedUsers.set(identity.guid, identity);

					const existingBaseNick = getBaseNick(identity.fullnick);
					loadedBaseNicks.set(existingBaseNick.toLowerCase(), identity.guid);
					loadedPlayerIds.set(identity.playerid, identity.guid);
				}
				catch(error: unknown){
					handleError(error, `Load Users (Record ${guid})`);
					continue;
				}
			}

			const auditFailures = this.auditUsers(loadedUsers);
			if(auditFailures.length > 0){
				allFailures.push(...auditFailures);
			}

			if(allFailures.length > 0){
				console.error(`Load Users found ${allFailures.length} field failure(s) across all records, writing repair file`);
				createJsonFile(repairPath, allFailures);
			}

			this.users = loadedUsers;
			this.basenickIndex = loadedBaseNicks;
			this.playeridIndex = loadedPlayerIds;
			this.userQueue.chain();
			return this.users.size;
		} 
		catch(error: unknown){
			if(error instanceof AppError){
				throw error;
			}
			handleError(error, 'Load Users');
			
			throw new AppError(`failed to load users: unknown error`, 'user');
		}
	}

	private auditUsers(users: Map<string, Identity>): KeyedParseFailureRecord[] {
		const failures: KeyedParseFailureRecord[] = [];
		const gameUsers = this.deps.gameIdentityService.getGameUsersMap();

		for(const [guid, identity] of users){
			if(!gameUsers.has(identity.playerid)){
				failures.push({
					raw: undefined,
					schemaName: aType.id,
					field: 'identity.playerid: missing matching game identity',
					invalidValue: identity.playerid,
					substitutedValue: undefined,
					recordKey: guid,
				});
			}
		}

		const validPlayerids = new Set<string>();
		for(const [, identity] of users){
			validPlayerids.add(identity.playerid);
		}
		for(const [playerid] of gameUsers){
			if(!validPlayerids.has(playerid)){
				failures.push({
					raw: undefined,
					schemaName: aType.gid,
					field: 'gameidentity.playerid: missing matching identity',
					invalidValue: playerid,
					substitutedValue: undefined,
					recordKey: playerid,
				});
			}
		}

		const playeridToGuids = new Map<string, string[]>();
		for(const [guid, identity] of users){
			const existing = playeridToGuids.get(identity.playerid);
			if(existing){
				existing.push(guid);
			}
			else{
				playeridToGuids.set(identity.playerid, [guid]);
			}
		}
		for(const [playerid, guids] of playeridToGuids){
			if(guids.length > 1){
				failures.push({
					raw: undefined,
					schemaName: aType.id,
					field: 'identity.playerid: duplicated across multiple identities',
					invalidValue: playerid,
					substitutedValue: undefined,
					recordKey: guids.join(', ')
				});
			}
		}

		const baseNickToGuids = new Map<string, string[]>();
		for(const [guid, identity] of users){
			const baseNick = getBaseNick(identity.fullnick).toLowerCase();
			const existing = baseNickToGuids.get(baseNick);
			if(existing){
				existing.push(guid);
			}
			else{
				baseNickToGuids.set(baseNick, [guid]);
			}
		}
		for(const [basenick, guids] of baseNickToGuids){
			if(guids.length > 1){
				failures.push({
					raw: undefined,
					schemaName: aType.id,
					field: 'identity base nick: duplicated across multiple identities',
					invalidValue: basenick,
					substitutedValue: undefined,
					recordKey: guids.join(', ')
				});
			}
		}

		return failures;
	}
	
	private async saveUsers(){
		try{
			await writeJsonFile(this.deps.usersPath, Array.from(this.users.entries()));
		} 
		catch(error: unknown){
			handleError(error, 'Save Users');
		}
	}
}