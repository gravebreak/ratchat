import { readFileSync, writeFileSync, existsSync } from "fs";
import type { Socket, Server } from "socket.io";
import { EventEmitter } from "events";
import crypto from 'crypto';

import type { ServerConfig, Identity, UserSum, MarkovConfig } from "../../shared/schema.ts";
import { defaultServerConfig, defaultMarkovConfig, mType } from '../../shared/schema';

import { MessageService } from "./message";
import type { SafeString } from "./moderation.ts";

export interface StateServiceDependencies{
	messageService: MessageService;
	
	configPath: string;
	markovConfigPath: string;
	io: Server;
}

export class StateService {
	public events = new EventEmitter();
	public markovUser: Identity | null = null;
	public markovSleep: boolean = false;
	
	private socketUsers = new Map<string, Identity>();
	private emotes = new Map<string, string>();
	private config: ServerConfig = {} as ServerConfig;
	private markovConfig: MarkovConfig = {} as MarkovConfig;
	private announcement: string = "";

	private signupBuffer: Map<string, {socket: Socket; nick: SafeString}> = new Map();
	private signupTimer: NodeJS.Timeout | null = null;
	private signupPromise: Map<Socket, (value: boolean)=> void> = new Map();

	private deps: StateServiceDependencies;

	constructor(dependencies: StateServiceDependencies) {
		this.deps = dependencies;
		this.socketUsers = new Map;
	
		this.loadConfig();
		this.loadMarkovConfig();
		this.afkTimer();
	}

	public getConfig(): ServerConfig{
		return this.config;
	}

	public getMarkovConfig(): MarkovConfig{
		return this.markovConfig;
	}

	public getAnnouncement(): string{
		return this.announcement;
	}

	public setAnnouncement(io: Server, str: SafeString){
		if (this.announcement === str){
			throw Error("that's already the announcement")
		}

		this.announcement = str;
		
		if(str){
		  	this.deps.messageService.sendSys(io, mType.ann,`announcement: ${str}`);
		}
	}

	public getEmotes(): Map<string, string>{
		return this.emotes;
	}

	public async updateEmotes(io: Server, setID?: string): Promise<number>{

		const targetID = setID ?? this.config.stvurl;
		if(!targetID){
			throw new Error('no emote url in config')
		}
		
		const isValidId = /^[a-z0-9_-]{17,31}$/i.test(targetID);
		
		if (!isValidId) {
			throw new Error("doesn't look like a 7tv emote set ID")
		}
		
		try {
			const response = await fetch(`https://api.7tv.app/v3/emote-sets/${targetID}`);
			if (!response.ok){ 
				throw new Error(`7tv returned HTTP ${response.status}`); 
			} 

			const data = await response.json();
			if (!data.emotes || !Array.isArray(data.emotes)){ 
				throw new Error("invalid 7tv response structure"); 
			}
			
			let size: number = 0
			data.emotes.forEach((emote: any) => {
				const name = emote.name;
				const hostUrl = emote.data.host.url; 
				this.emotes.set(name, `https:${hostUrl}/1x.webp`);
				size++
			});

			const emotePayload = Object.fromEntries(this.emotes);
			this.deps.messageService.send(io, mType.emote, emotePayload);
			return size;
			} 
			catch (e: any) {
				throw new Error(`failed to fetch emotes: ${e.message}`);
			}
	}

	public async removeEmotes(io: Server, setID: string): Promise<number>{
		if (setID.length < 1){
			throw new Error('please provide a target emote setID to remove');
		}

		const isValidId = /^[a-z0-9_-]{17,31}$/i.test(setID);		
		if (!isValidId) {
			throw new Error("doesn't look like a 7tv emote url")
		}

		try{
			const response = await fetch(`https://api.7tv.app/v3/emote-sets/${setID}`);
			if (!response.ok){ 
				throw new Error(`7tv returned HTTP ${response.status}`); 
			}

			const data = await response.json();
			if (!data.emotes || !Array.isArray(data.emotes)){ 
				throw new Error("invalid 7tv response structure"); 
			}

			let deleteCount: number = 0;
			data.emotes.forEach((emote: any) => {
				const name = emote.name;
				const del = this.emotes.delete(name);
				if(del){
					deleteCount++;
				}
			});

			const emotePayload = Object.fromEntries(this.emotes);
			this.deps.messageService.send(io, mType.emote, emotePayload);
			return deleteCount;
		} 
		catch (e: any) {
			throw new Error(`failed to fetch emotes: ${e.message}`);
		}
	}

	public getSocketUsers(): Map<string, Identity>{
		return this.socketUsers;
	}

	public updateSocketUser(io: Server, socketID: string, identity: Identity) {
		this.socketUsers.set(socketID, identity);

		for (const [sId, user] of this.socketUsers.entries()) {
			if (user.guid === identity.guid && sId !== socketID) {
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
			if (a.isAfk !== b.isAfk) {
				return a.isAfk ? 1 : -1;
			}
			if (a.isMod !== b.isMod) {
				return a.isMod ? -1 : 1;
			}
				return a.nick.substring(7).localeCompare(b.nick.substring(7), 'en', {sensitivity: 'base'});
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

		this.deps.messageService.send(io, mType.list, userList);
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

	public hashIP(ip: string): string{
		if(!process.env.IP_PEPPER){
			throw new Error ('no pepper set')
		}
		const pepper = process.env.IP_PEPPER
		const hash = crypto.createHash('sha256')
		hash.update(ip + pepper);
		return hash.digest('hex');
	}

	public signupQueue(socket: Socket, nick: SafeString): Promise<boolean> {
		const hashed = this.hashIP(socket.handshake.address);
   		this.signupBuffer.set(hashed, { socket, nick });

		return new Promise<boolean>(resolve => {
			this.signupPromise.set(socket, resolve);
			if (!this.signupTimer) {
				this.signupTimer = setTimeout(() => this.returnQueue(), this.config.signupTime * 1000);
			}
		});
	}

	private returnQueue(){
		const queue = Array.from(this.signupBuffer.values());

		for (const [socket, resolve] of this.signupPromise.entries()) {
			const survived = queue.some(entry => entry.socket === socket);
			resolve(survived);
		}

		this.signupBuffer.clear();
		this.signupPromise.clear();
		this.signupTimer = null;
	}

	private loadConfig(){
		if(!existsSync(this.deps.configPath)){
			writeFileSync(this.deps.configPath, JSON.stringify(defaultServerConfig, null, 4))
			Object.assign(this.config, defaultServerConfig);
			console.log("created default config.json file")
			return;
		}

		let loadedCfg: any;
		try{
			loadedCfg = JSON.parse(readFileSync(this.deps.configPath, 'utf-8'));
		}
 		catch(e: any){
			console.warn(`config load error: ${e.message}`);
			loadedCfg = {};
		}
		for (const key of Object.keys(defaultServerConfig) as Array<keyof ServerConfig>){
			const def = defaultServerConfig[key];
			const cfg = loadedCfg[key];
			if(cfg === undefined || cfg === null){
				(this.config as any)[key] = def;
				console.log(`${key} = ${JSON.stringify(def)} [DEFAULT]`);
				continue;
			} 
			if(typeof def === "number" && typeof cfg !== "number"){
				(this.config as any)[key] = def;
				console.log(`${key} = ${JSON.stringify(def)} [DEFAULT]`)
				continue; 
			} 
			if(typeof def === "string" && typeof cfg !== "string"){
				(this.config as any)[key] = def;
				console.log(`${key} = ${JSON.stringify(def)} [DEFAULT]`)
				continue; 
			} 
			if(Array.isArray(def)){
				if(!Array.isArray(cfg) || !cfg.every(v => typeof v === "string")){
					(this.config as any)[key] = def;
					console.log(`${key} = ${JSON.stringify(def)} [DEFAULT]`)
					continue; 
				} 
			} 
			(this.config as any)[key] = cfg;
			console.log(`${key} = ${JSON.stringify(cfg)}`);
		}
		Object.freeze(this.config);
	}

	private loadMarkovConfig(){
		if(!existsSync(this.deps.markovConfigPath)){
			writeFileSync(this.deps.markovConfigPath, JSON.stringify(defaultMarkovConfig, null, 4))
			Object.assign(this.markovConfig, defaultMarkovConfig);
			console.log("created default markov.json file")
			return;
		}

		let loadedCfg: any;
		try{
			loadedCfg = JSON.parse(readFileSync(this.deps.markovConfigPath, 'utf-8'));
		}
 		catch(e: any){
			console.warn(`config load error: ${e.message}`);
			loadedCfg = {};
		}
		for (const key of Object.keys(defaultMarkovConfig) as Array<keyof MarkovConfig>){
			const def = defaultMarkovConfig[key];
			const cfg = loadedCfg[key];
			if(cfg === undefined || cfg === null){
				(this.markovConfig as any)[key] = def;
				console.log(`${key} = ${JSON.stringify(def)} [DEFAULT]`);
				continue;
			} 
			if(typeof def === "number" && typeof cfg !== "number"){
				(this.markovConfig as any)[key] = def;
				console.log(`${key} = ${JSON.stringify(def)} [DEFAULT]`)
				continue; 
			} 
			if(typeof def === "string" && typeof cfg !== "string"){
				(this.markovConfig as any)[key] = def;
				console.log(`${key} = ${JSON.stringify(def)} [DEFAULT]`)
				continue; 
			} 
			if (typeof def === "boolean" && typeof cfg !== "boolean") {
				(this.markovConfig as any)[key] = def;
				console.log(`${key} = ${JSON.stringify(def)} [DEFAULT]`);
				continue;
			}
			(this.markovConfig as any)[key] = cfg;
			console.log(`markov ${key} = ${JSON.stringify(cfg)}`);
		}
		Object.freeze(this.markovConfig);
		if (this.markovConfig.enabled){
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

	private afkTimer(){
		setInterval(() =>{
			const now = Date.now();
			const afkTime = this.config.afkDef * 1000;
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