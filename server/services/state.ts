import { readFileSync, writeFileSync, existsSync } from "fs";
import { EventEmitter } from "events";
import type { RedisClientType } from "redis";

import type { Socket, Server } from "socket.io";

import { defaultServerConfig, defaultMarkovConfig, mType, defaultGameConfig, ServerConfigSchema, MarkovConfigSchema, GameConfigSchema } from '../../shared/schema';
import type { ServerConfig, Identity, UserSum, MarkovConfig, GameConfig } from "../../shared/schema";

import { DispatchService } from "./dispatch";
import type { SafeString } from "./moderation";

import { mergeDefaults } from "../utils/defaults";
import { hashIP } from "../utils/hash";
import { getDisplayNick } from "../utils/format";
import { isValid7TVID } from "../utils/input";

interface EmoteEntry {
	name: string;
  	data:{
		host:{ 
			url: string;
		};
  };
}

const REDIS_ANNOUNCEMENT_KEY = 'ratchat:announcement';

export interface StateServiceDependencies{
	dispatchService: DispatchService;
	
	serverConfigPath: string;
	markovConfigPath: string;
	gameConfigPath: string;
	redisClient: RedisClientType | null;
	redisTTL: number;
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

	private announcement: string = "";

	private signupBuffer: Map<string, {socket: Socket; nick: SafeString}> = new Map();
	private signupTimer: NodeJS.Timeout | null = null;
	private signupPromise: Map<Socket, (value: boolean)=> void> = new Map();

	private announcementQ = Promise.resolve();

	private deps: StateServiceDependencies;
	constructor(dependencies: StateServiceDependencies){
		this.deps = dependencies;
		this.socketUsers = new Map;
	
		this.loadServerConfig();
		this.loadMarkovConfig();
		this.loadGameConfig();
		this.afkTimer();
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

	public getAnnouncement(): string{
		return this.announcement;
	}

	public setAnnouncement(io: Server, str: SafeString){
		if(this.announcement === str){
			throw Error("that's already the announcement")
		}

		this.announcement = str;
		
		if(str){
		  	this.deps.dispatchService.sendSystemChat(io, mType.ann,`announcement: ${str}`);
		}

		this.saveAnnouncementQueue();
	}

	public getEmotes(): Map<string, string>{
		return this.emotes;
	}

	public async updateEmotes(io: Server, setID?: string): Promise<number>{

		const targetID = setID ?? this.serverConfig.stvurl;
		if(!targetID){
			throw new Error('no emote url in config')
		}
				
		if(!isValid7TVID(targetID)){
			throw new Error("doesn't look like a 7tv emote set ID")
		}
		
		try{
			const response = await fetch(`https://api.7tv.app/v3/emote-sets/${targetID}`);
			if(!response.ok){ 
				throw new Error(`7tv returned HTTP ${response.status}`); 
			} 

			const data = await response.json();
			if(!data.emotes || !Array.isArray(data.emotes)){ 
				throw new Error("invalid 7tv response structure"); 
			}
			
			let size: number = 0
			data.emotes.forEach((emote: EmoteEntry) => {
				const name = emote.name;
				const hostUrl = emote.data.host.url; 
				this.emotes.set(name, `https:${hostUrl}/1x.webp`);
				size++
			});

			const emotePayload = Object.fromEntries(this.emotes);
			this.deps.dispatchService.sendEmoteList(io, emotePayload);
			return size;
		} 
		catch(error: unknown){
			if(error instanceof Error){
				throw new Error(`failed to fetch emotes: ${error.message}`);
			}
			else{
				console.error("Unexpected non-error thrown:", error);
				throw new Error("Unknown error")
			}
		}
	}

	public async removeEmotes(io: Server, setID: string): Promise<number>{
		if(setID.length < 1){
			throw new Error('please provide a target emote setID to remove');
		}

		if(!isValid7TVID(setID)){
			throw new Error("doesn't look like a 7tv emote url")
		}

		try{
			const response = await fetch(`https://api.7tv.app/v3/emote-sets/${setID}`);
			if(!response.ok){ 
				throw new Error(`7tv returned HTTP ${response.status}`); 
			}

			const data = await response.json();
			if(!data.emotes || !Array.isArray(data.emotes)){ 
				throw new Error("invalid 7tv response structure"); 
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
			if(error instanceof Error){
				throw new Error(`failed to fetch emotes: ${error.message}`);
			} 
			else{
				console.error("Unexpected non-error thrown:", error);
				throw new Error("Unknown error")
			}
		}
	}

	public getSocketUsers(): Map<string, Identity>{
		return this.socketUsers;
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
			.map(({ nick, status, isMod, isAfk }) => ({ nick, status, isMod, isAfk }))
			.sort((a,b) =>{
			if(a.isAfk !== b.isAfk){
				return a.isAfk ? 1 : -1;
			}
			if(a.isMod !== b.isMod){
				return a.isMod ? -1 : 1;
			}
				return getDisplayNick(a.nick).localeCompare(getDisplayNick(b.nick), 'en', {sensitivity: 'base'});;
			});
		
		const lurkers = io.sockets.sockets.size - this.socketUsers.size;

		if(this.markovUser){
			if(this.markovSleep){
				userList.push({
				nick: this.markovUser.nick,
				status: this.markovUser.status,
				isMod: false,
				isAfk: true,
				})
			}
			else{
			userList.push({
				nick: this.markovUser.nick,
				status: this.markovUser.status,
				isMod: false,
				isAfk: this.markovUser.isAfk,
				})
			}
		}

		userList.push({
			nick: '#NONVALlurkers',
			status: `${lurkers}`,
			isMod: false,
			isAfk: true
		})

		this.deps.dispatchService.sendUserList(io, userList);
	}

	public toggleMarkov(io: Server){
		if(this.markovUser === null){
			throw new Error('no markov user set up')
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

	public sleepMarkov(io: Server): Boolean{
		if(this.markovSleep){
			this.markovSleep = false;
		}
		else{
			this.markovSleep = true;
		}
		this.broadcastUsers(io);
		return this.markovSleep;
	}

	public async restoreAnnouncement(){
		if(!this.deps.redisClient){
			return;
		}

		try{
			const announcementLoad = await this.deps.redisClient.get(REDIS_ANNOUNCEMENT_KEY);
			if(announcementLoad){
				if(announcementLoad.length <= this.serverConfig.maxMsgLen){
					this.announcement = announcementLoad;
					console.log(`Restored ${this.announcement} from Redis`);
				}
				else{
					this.announcement = '';
					console.warn('Redis annoucement load too long, starting fresh');
				}
			}
			else{
				console.log(`Empty Redis announcement load`);
			}
		}
		catch(error: unknown){
			if(error instanceof Error){
				console.warn('Redis announcement load error:', error.message);
			}
			else{
				console.error('Unexpected non-error thrown:', error);
			}
		}
	}

	public stateRedisFallback(){
		this.deps.redisClient = null;
	}

	public signupQueue(socket: Socket, nick: SafeString): Promise<boolean> {
		return new Promise<boolean>((resolve, reject) => {
			try {
				const hashed = hashIP(socket.handshake.address);
				this.signupBuffer.set(hashed, { socket, nick });
				this.signupPromise.set(socket, resolve);
				if(!this.signupTimer){
					this.signupTimer = setTimeout(() => this.returnQueue(), this.serverConfig.signupTime * 1000);
				}
			}
			catch(error: unknown) {
				if(error instanceof Error){
					reject(error);
				}
				else{
					console.error("Unexpected non-error thrown:", error);
					reject(new Error("Unknown error"));
				}
			}
		});
	}

	private returnQueue(){
		const queue = Array.from(this.signupBuffer.values());

		for (const [socket, resolve] of this.signupPromise.entries()){
			const survived = queue.some(entry => entry.socket === socket);
			resolve(survived);
		}

		this.signupBuffer.clear();
		this.signupPromise.clear();
		this.signupTimer = null;
	}

	private saveAnnouncementQueue(){
		this.announcementQ= this.announcementQ.then(() => this.saveAnnouncement());
	}

	private async saveAnnouncement(){
		if(!this.deps.redisClient){
				return;
		}
		try {
			await this.deps.redisClient.set(REDIS_ANNOUNCEMENT_KEY, this.announcement, { EX: this.deps.redisTTL});
		} 
		catch(error: unknown){
			if(error instanceof Error){
				console.warn('Redis announcement save error:', error.message);
			} 
			else{
				console.error('Unexpected non-error thrown:', error);
			}
		}
	}

	private loadServerConfig(){
		if(!existsSync(this.deps.serverConfigPath)){
			writeFileSync(this.deps.serverConfigPath, JSON.stringify(defaultServerConfig, null, 4))
			Object.assign(this.serverConfig, defaultServerConfig);
			console.log("created default config.json file")
			return;
		}

		let loadedCfg: unknown = {};

		try{
			loadedCfg = JSON.parse(readFileSync(this.deps.serverConfigPath, 'utf-8'));
		}
 		catch(error: unknown){
			if(error instanceof Error){
				console.error(`server config load error: ${error.message}`);
			} 
			else{
				console.error("Unexpected non-error thrown:", error);
			}

		}

		try{
			this.serverConfig = mergeDefaults(loadedCfg, defaultServerConfig, ServerConfigSchema);
			if(this.serverConfig.gdprcontact === 'admin@email.here'){
				console.warn('No GDPR contact info set. If hosting publicly please set gdprcontact in config.json')
			}
		}
		catch(error: unknown){
			if(error instanceof Error){
				console.error(`server config merge error: ${error.message}`);
			} 
			else{
				console.error("Unexpected non-error thrown:", error);
			}
		}

		Object.freeze(this.serverConfig);
		console.log('LOADED SERVER CONFIG:', this.serverConfig)
	}

	private loadMarkovConfig(){
		if(!existsSync(this.deps.markovConfigPath)){
			writeFileSync(this.deps.markovConfigPath, JSON.stringify(defaultMarkovConfig, null, 4))
			Object.assign(this.markovConfig, defaultMarkovConfig);
			console.log("created default markov.json file")
			return;
		}

		let loadedCfg: unknown = {};

		try{
			loadedCfg = JSON.parse(readFileSync(this.deps.markovConfigPath, 'utf-8'));
		}
 		catch(error: unknown){
			if(error instanceof Error){
				console.error(`markov config load error: ${error.message}`);
			} 
			else{
				console.error("Unexpected non-error thrown:", error);
			}
		}

		try{
			this.markovConfig = mergeDefaults(loadedCfg, defaultMarkovConfig, MarkovConfigSchema);
		}
		catch(error: unknown){
			if(error instanceof Error){
				console.error(`markov config merge error: ${error.message}`);
			} 
			else{
				console.error("Unexpected non-error thrown:", error);
			}
		}

		Object.freeze(this.markovConfig);
		console.log('LOADED MARKOV CONFIG:', this.markovConfig)

		if(this.markovConfig.enabled){
			this.markovUser = {
			guid: 'markov',
			nick: this.markovConfig.color + this.markovConfig.nick,
			status: this.markovConfig.status,
			lastMessage: new Date(0),
			lastChanged: new Date(0),
			isMod: false,
			isAfk: false,
			}
		}
		else{
			this.markovUser = null;
		}		
	}

	private loadGameConfig(){
		if(!existsSync(this.deps.gameConfigPath)){
			writeFileSync(this.deps.gameConfigPath, JSON.stringify(defaultGameConfig, null, 4))
			Object.assign(this.gameConfig, defaultGameConfig);
			console.log("created default minigames.json file")
			return;
		}

		let loadedCfg: unknown = {};

		try{
			loadedCfg = JSON.parse(readFileSync(this.deps.gameConfigPath, 'utf-8'));
		}
 		catch(error: unknown){
			if(error instanceof Error){
				console.error(`game config load error: ${error.message}`);
			} 
			else{
				console.error("Unexpected non-error thrown:", error);
			}
		}

		try{
			this.gameConfig = mergeDefaults(loadedCfg, defaultGameConfig, GameConfigSchema);
		}
		catch(error: unknown){
			if(error instanceof Error){
				console.error(`game config merge error: ${error.message}`);
			} 
			else{
				console.error("Unexpected non-error thrown:", error);
			}
		}
		Object.freeze(this.gameConfig);
		console.log('LOADED GAME CONFIG: ', this.gameConfig);
	}

	private afkTimer(){
		setInterval(() =>{
			const now = Date.now();
			const afkTime = this.serverConfig.afkDef * 1000;
			const updates: Array<{ id: string; user: Identity }> = [];

			for(const [id, user] of this.socketUsers.entries()){
				const lastMessage = new Date(user.lastMessage).getTime();
				const lastChanged = new Date(user.lastChanged).getTime();

				if(now - lastMessage > afkTime && now - lastChanged > afkTime){
					if(!user.isAfk){
						this.events.emit("afk-check", user.guid);
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