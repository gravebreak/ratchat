import { EventEmitter } from 'events';
import type { Socket, Server } from 'socket.io';

import { defaultServerConfig, defaultMarkovConfig, defaultGameConfig, ServerConfigSchema, MarkovConfigSchema, GameConfigSchema } from '../defs/def-config';
import { mType } from '../defs/def-message';
import { aType } from '../defs/def-parse';
import type { ServerConfig, MarkovConfig, GameConfig } from '../defs/def-config';
import type { Identity, UserSum } from '../defs/def-identity';

import { CacheService } from './cache';
import { DispatchService } from './dispatch';
import type { SafeString } from './moderation';

import { handleError, AppError } from '../utils/errors';
import { getBaseNick } from '../utils/format';
import { hashIP } from '../utils/hash';
import { mergeConfigDefaults } from '../utils/parse';
import { createSaveQueue } from '../utils/queue';
import { existsRepairFile, getRepairPath } from '../utils/repair';
import { existsFile, createJsonFile, readJsonFile } from '../utils/serialize';
import { isValid7TVID } from '../utils/validate';

type EmoteEntry = {
	name: string;
  	data:{
		host:{ 
			url: string;
		};
  };
}

const REDIS_ANNOUNCEMENT_KEY = 'ratchat:announcement';
const REDIS_MARKOVSLEEP_KEY = 'ratchat:markovsleep';

export interface StateServiceDependencies{
	cacheService: CacheService;
	dispatchService: DispatchService;
	
	serverConfigPath: string;
	markovConfigPath: string;
	gameConfigPath: string;
	io: Server;
}

export class StateService {
	public events = new EventEmitter();
	public markovUser: Identity | null = null;
	public markovSleep: boolean = false;
	
	private socketUsers = new Map<string, Identity>();
	private emotes = new Map<string, string>();

	private serverConfig: ServerConfig = {...defaultServerConfig};
	private markovConfig: MarkovConfig = {...defaultMarkovConfig};
	private gameConfig: GameConfig = {...defaultGameConfig};

	private announcement: string = '';

	private signupBuffer: Map<string, {socket: Socket; basenick: SafeString}> = new Map();
	private signupTimer: NodeJS.Timeout | null = null;
	private signupPromise: Map<Socket, (value: boolean)=> void> = new Map();

	private announcementQueue = createSaveQueue(() => this.saveAnnouncement());
	private markovSleepQueue = createSaveQueue(() => this.saveMarkovSleep());

	private deps: StateServiceDependencies;
	constructor(dependencies: StateServiceDependencies){
		this.deps = dependencies;
		this.socketUsers = new Map;

		const pendingRepairs: string[] = [];
		for(const path of [this.deps.serverConfigPath, this.deps.markovConfigPath, this.deps.gameConfigPath]){
			if(existsRepairFile(path)){
				pendingRepairs.push(path);
			}
		}
		if(pendingRepairs.length > 0){
			throw new AppError(`unresolved repair file(s) found for: ${pendingRepairs.join(', ')} — review and delete before restarting`, 'internal', 'error');
		}

		try{
			this.loadServerConfig();
			this.loadMarkovConfig();
			this.loadGameConfig();
		}
		catch(error: unknown){
			handleError(error, 'State Config Load');
		}

		this.startAfkTimer();
		this.deps.dispatchService.startExpireMessageTimer(this.serverConfig.msgArrayTimeout);
	}

	public getServerConfig(): ServerConfig{
		return this.serverConfig;
	}

	public getMarkovConfig(): MarkovConfig{
		return this.markovConfig;
	}

	public getGameConfig(): GameConfig{
		return this.gameConfig;
	}

	public getEmotes(): Map<string, string>{
		return this.emotes;
	}

	public async updateEmotes(io: Server, setID?: string): Promise<number>{

		const targetID = setID ?? this.serverConfig.stvurl;
		if(!targetID){
			throw new AppError('no emote url in config, please provide one', 'user');
		}
				
		if(!isValid7TVID(targetID)){
			throw new AppError("doesn't look like a 7tv emote set ID", 'user');
		}
		
		try{
			const response = await fetch(`https://api.7tv.app/v3/emote-sets/${targetID}`);
			if(!response.ok){ 
				throw new AppError(`7tv returned HTTP ${response.status}, try again`, 'user'); 
			} 

			const data = await response.json();
			if(!data.emotes || !Array.isArray(data.emotes)){ 
				throw new AppError('invalid 7tv response structure', 'internal', 'warn'); 
			}
			
			let size: number = 0;
			data.emotes.forEach((emote: EmoteEntry) => {
				const name = emote.name;
				const hostUrl = emote.data.host.url; 
				this.emotes.set(name, `https:${hostUrl}/1x.webp`);
				size++;
			});

			const emotePayload = Object.fromEntries(this.emotes);
			this.deps.dispatchService.sendEmoteList(io, emotePayload);
			return size;
		} 
		catch(error: unknown){
			if(error instanceof AppError){
				throw error;
			}
			handleError(error, 'Update Emotes');
			
			throw new AppError(`failed to fetch emotes: unknown error`, 'user');
		}
	}

	public async removeEmotes(io: Server, setID: string): Promise<number>{
		if(setID.length < 1){
			throw new AppError('please provide a target emote setID to remove', 'user');
		}

		if(!isValid7TVID(setID)){
			throw new AppError("doesn't look like a 7tv emote url", 'user');
		}

		try{
			const response = await fetch(`https://api.7tv.app/v3/emote-sets/${setID}`);
			if(!response.ok){ 
				throw new AppError(`7tv returned HTTP ${response.status}, try again`, 'user'); 
			}

			const data = await response.json();
			if(!data.emotes || !Array.isArray(data.emotes)){ 
				throw new AppError('invalid 7tv response structure', 'internal', 'warn'); 
			}

			let deleteCount: number = 0;
			data.emotes.forEach((emote: EmoteEntry) => {
				const name = emote.name;
				const del = this.emotes.delete(name);
				if(del){
					deleteCount++;
				}
			});

			const emotePayload = Object.fromEntries(this.emotes);
			this.deps.dispatchService.sendEmoteList(io, emotePayload);
			return deleteCount;
		} 
		catch(error: unknown){
			if(error instanceof AppError){
				throw error;
			}
			handleError(error, 'Remove Emotes');
			
			throw new AppError(`failed to fetch emotes: unknown error`, 'user');
		}
	}

	public getSocketUsersMap(): Map<string, Identity>{
		return this.socketUsers;
	}

	public getSocketUser(socketID: string): Identity | null {
		return this.socketUsers.get(socketID) ?? null;
	}

	public updateSocketUser(io: Server, socketID: string, identity: Identity){
		this.socketUsers.set(socketID, identity);

		for (const [sId, user] of this.socketUsers.entries()){
			if(user.guid === identity.guid && sId !== socketID){
				this.socketUsers.set(sId, identity); 
			}
		}

		this.broadcastUsers(io);
	}

	public deleteSocketUser(io: Server, socketID: string){
		this.socketUsers.delete(socketID);
		this.broadcastUsers(io);
	}

	public broadcastUsers(io: Server){		
		const userList: UserSum[] = Array.from(this.socketUsers.values())
			.map(({ fullnick, status, isMod, isAfk }) => ({ fullnick, status, isMod, isAfk }))
			.sort((a,b) =>{
				if(a.isAfk !== b.isAfk){
					return a.isAfk ? 1 : -1;
				}
				if(a.isMod !== b.isMod){
					return a.isMod ? -1 : 1;
				}
					return getBaseNick(a.fullnick).localeCompare(getBaseNick(b.fullnick), 'en', {sensitivity: 'base'});;
			});
		
		const lurkers = io.sockets.sockets.size - this.socketUsers.size;

		if(this.markovUser){
			if(this.markovSleep){
				userList.push({
				fullnick: this.markovUser.fullnick,
				status: this.markovUser.status,
				isMod: false,
				isAfk: true,
				});
			}
			else{
			userList.push({
				fullnick: this.markovUser.fullnick,
				status: this.markovUser.status,
				isMod: false,
				isAfk: this.markovUser.isAfk,
				});
			}
		}

		userList.push({
			fullnick: '#NONVALlurkers',
			status: `${lurkers}`,
			isMod: false,
			isAfk: true
		});

		this.deps.dispatchService.sendUserList(io, userList);
	}

	public toggleMarkov(io: Server){
		if(this.markovUser === null){
			throw new AppError('toggleMarkov called while markov bot is disabled', 'bug');
		}
		this.markovUser.isAfk = true;
		this.broadcastUsers(io);

		setTimeout(() => {
			if(this.markovUser){ 
				this.markovUser.isAfk = false;
				this.broadcastUsers(io); 
			}
		}, this.markovConfig.cooldown * 1000);
	}

	public toggleMarkovSleep(io: Server): boolean{
		if(this.markovSleep){
			this.markovSleep = false;
		}
		else{
			this.markovSleep = true;
		}
		this.markovSleepQueue.chain();
		this.broadcastUsers(io);
		return this.markovSleep;
	}

	public async restoreMarkovSleep(){
		if(!this.markovConfig.enabled){
			console.log('markov bot disabled skipping markov toggle restore');
			return;
		}
		
		if(!this.deps.cacheService.existsRedisClient()){
			return;
		}

		try{
			const markovSleepLoad = await this.deps.cacheService.getRedisValue(REDIS_MARKOVSLEEP_KEY);
			if(markovSleepLoad !== null){
				if(typeof markovSleepLoad === 'boolean'){
					this.markovSleep = markovSleepLoad;
					console.log(`Restored markov sleep state to ${markovSleepLoad} from Redis`);
				}
				else{
					this.markovSleep = false;
					console.warn('Redis markov sleep load was not a boolean, starting fresh');
				}
			}
			else{
				console.log('Empty Redis Markov Sleep load');
			}
		}
		catch(error: unknown){
			handleError(error, 'Redis Markov Sleep load');
		}
	}

	public getAnnouncement(): string{
		return this.announcement;
	}

	public setAnnouncement(io: Server, str: SafeString){
		if(this.announcement === str){
			throw new AppError("that's already the announcement", 'user');
		}

		this.announcement = str;
		
		if(str){
		  	this.deps.dispatchService.sendSystemChat(io, mType.ann,`announcement: ${str}`);
		}

		this.announcementQueue.chain();
	}

	public async restoreAnnouncement(){
		if(!this.deps.cacheService.existsRedisClient()){
			return;
		}

		try{
			const announcementLoad = await this.deps.cacheService.getRedisValue(REDIS_ANNOUNCEMENT_KEY);
			if(announcementLoad !== null){
				if(typeof announcementLoad !== 'string'){
					this.announcement = '';
					console.warn('Redis announcement load was not a string, starting fresh');
				}
				else if(announcementLoad.length > this.serverConfig.maxMsgLen){
					this.announcement = '';
					console.warn('Redis announcement load exceeded maxMsgLen, starting fresh');
				}
				else{
					this.announcement = announcementLoad;
					console.log(`Restored ${this.announcement} from Redis`);
				}
			}
			else{
				console.log('Empty Redis announcement load');
			}
		}
		catch(error: unknown){
			handleError(error, 'Redis Announcment Load');
		}
	}

	public queueSignup(socket: Socket, basenick: SafeString): Promise<boolean> {
		return new Promise<boolean>((resolve, reject) => {
			try {
				const hashed = hashIP(socket.handshake.address);
				this.signupBuffer.set(hashed, { socket, basenick });
				this.signupPromise.set(socket, resolve);
				if(!this.signupTimer){
					this.signupTimer = setTimeout(() => this.resolveSignups(), this.serverConfig.signupTime * 1000);
				}
			}
			catch(error: unknown) {
				if(error instanceof AppError){
					reject(error);
					return;
				}
				handleError(error, 'Signup Queue');
				reject(new AppError('failed to queue signup: unknown error', 'user'));
			}
		});
	}

	private resolveSignups(){
		const queue = Array.from(this.signupBuffer.values());

		for (const [socket, resolve] of this.signupPromise.entries()){
			const survived = queue.some(entry => entry.socket === socket);
			resolve(survived);
		}

		this.signupBuffer.clear();
		this.signupPromise.clear();
		this.signupTimer = null;
	}

	private async saveAnnouncement(){
		if(!this.deps.cacheService.existsRedisClient()){
				return;
		}
		try {
			await this.deps.cacheService.setRedisValue(REDIS_ANNOUNCEMENT_KEY, this.announcement);
		} 
		catch(error: unknown){
			handleError(error, 'Redis Announcement Save');
		}
	}

	private async saveMarkovSleep(){
		if(!this.deps.cacheService.existsRedisClient()){
				return;
		}
		try {
			await this.deps.cacheService.setRedisValue(REDIS_MARKOVSLEEP_KEY, this.markovSleep);
		} 
		catch(error: unknown){
			handleError(error, 'Redis Markov Sleep Save');
		}
	}

	private loadServerConfig(){
		const loadedCfg = this.readConfigFile(this.deps.serverConfigPath, defaultServerConfig, 'Server');
		const repairPath = getRepairPath(this.deps.serverConfigPath);

		try{
			const [merged, failures] = mergeConfigDefaults(loadedCfg, defaultServerConfig, aType.sconfig, ServerConfigSchema);
			this.serverConfig = merged;

			if(failures.length > 0){
				console.error(`Server config had ${failures.length} field(s) fall back to default, writing repair file`);
				createJsonFile(repairPath, failures);
			}

			if(this.serverConfig.gdprcontact === 'admin@email.here'){
				console.warn('No GDPR contact info set. If hosting publicly please set gdprcontact in config.json');
			}
		}
		catch(error: unknown){
			handleError(error, 'Server Config Merge');
		}

		Object.freeze(this.serverConfig);
		console.log('LOADED SERVER CONFIG:', this.serverConfig);
	}

	private loadMarkovConfig(){
		const loadedCfg = this.readConfigFile(this.deps.markovConfigPath, defaultMarkovConfig, 'Markov');
		const repairPath = getRepairPath(this.deps.markovConfigPath);

		try{
			const [merged, failures] = mergeConfigDefaults(loadedCfg, defaultMarkovConfig, aType.mconfig, MarkovConfigSchema);
			this.markovConfig = merged;

			if(failures.length > 0){
				console.error(`Markov config had ${failures.length} field(s) fall back to default, writing repair file`);
				createJsonFile(repairPath, failures);
			}

		}
		catch(error: unknown){
			handleError(error, 'Markov Config Merge');
		}

		Object.freeze(this.markovConfig);
		console.log('LOADED MARKOV CONFIG:', this.markovConfig);

		if(this.markovConfig.enabled){
			this.markovUser = {
				guid: 'markov',
				playerid: 'markov',
				fullnick: this.markovConfig.color + this.markovConfig.basenick,
				status: this.markovConfig.status,
				lastMessage: new Date(0),
				lastChanged: new Date(0),
				isMod: false,
				isAfk: false
			};
		}
		else{
			this.markovUser = null;
		}		
	}

	private loadGameConfig(){
		const loadedCfg = this.readConfigFile(this.deps.gameConfigPath, defaultGameConfig, 'Game')
		const repairPath = getRepairPath(this.deps.gameConfigPath);

		try{
			const [merged, failures] = mergeConfigDefaults(loadedCfg, defaultGameConfig, aType.gconfig, GameConfigSchema);
			this.gameConfig = merged;

			if(failures.length > 0){
				console.error(`Game config had ${failures.length} field(s) fall back to default, writing repair file`);
				createJsonFile(repairPath, failures);
			}
		}
		catch(error: unknown){
			handleError(error, 'Game Config Merge');
		}
		Object.freeze(this.gameConfig);
		console.log('LOADED GAME CONFIG: ', this.gameConfig);
	}

	private readConfigFile(path: string, defaultConfig: object, label: string): unknown{
		if(!existsFile(path)){
			try{
				createJsonFile(path, defaultConfig);
				console.log(`created default ${label} config json file`);
			}
			catch(error: unknown){
				handleError(error, `Create ${label} Default Config File`);
			}
			return defaultConfig;
		}

		try{
			return readJsonFile(path);
		}
		catch(error: unknown){
			handleError(error, `${label} Config Load`);
			return defaultConfig;
		}
	}

	private startAfkTimer(){
		setInterval(() =>{
			const now = Date.now();
			const afkTime = this.serverConfig.afkDef * 1000;
			const updates: Array<{ id: string; user: Identity }> = [];

			for(const [id, user] of this.socketUsers.entries()){
				const lastMessage = new Date(user.lastMessage).getTime();
				const lastChanged = new Date(user.lastChanged).getTime();

				if(now - lastMessage > afkTime && now - lastChanged > afkTime){
					if(!user.isAfk){
						this.events.emit('afk-check', user.guid);
						updates.push({id, user});
					}
				}
			}

			if(updates.length > 0){
				updates.forEach(({ id, user }) => {
					user.isAfk = true;
					this.socketUsers.set(id, user);
				});

			this.broadcastUsers(this.deps.io);
			}
		}, 60000);
	}
}