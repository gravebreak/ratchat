import { cType } from '../defs/def-events';
import type { RatServer, RatSocket } from '../defs/def-events';
import type { Identity, UserSum } from '../defs/def-identity';

import { CacheService } from './cache';
import { ConfigService } from './config';
import { DispatchService } from './dispatch';
import { IdentityService } from './identity';
import type { SafeString } from './moderation';

import { handleError, AppError } from '../utils/errors';
import { getBaseNick } from '../utils/format';
import { hashIP } from '../utils/hash';
import { isUnknownArray } from '../utils/parse';
import { createSaveQueue } from '../utils/queue';
import { isValid7TVID } from '../utils/validate';

type EmoteEntry = {
	name: string;
	data:{
		host:{
			url: string;
		};
	};
};

const REDIS_ANNOUNCEMENT_KEY = CacheService.createRedisKey('announcement');
const REDIS_MARKOVSLEEP_KEY = CacheService.createRedisKey('markovsleep');

export interface StateServiceDependencies{
	cacheService: CacheService;
	configService: ConfigService;
	dispatchService: DispatchService;
	identityService: IdentityService;

	io: RatServer;
}

export class StateService {
	public markovUser: Identity | null = null;
	public markovSleep: boolean = false;

	private socketUsers = new Map<RatSocket['id'], Identity>();
	private emotes = new Map<string, string>();

	private announcement: string = '';

	private signupBuffer: Map<string, {socket: RatSocket; basenick: SafeString}> = new Map();
	private signupTimer: NodeJS.Timeout | null = null;
	private signupPromise: Map<RatSocket, (value: boolean)=> void> = new Map();

	private announcementQueue = createSaveQueue(() => this.saveAnnouncement());
	private markovSleepQueue = createSaveQueue(() => this.saveMarkovSleep());

	private deps: StateServiceDependencies;
	constructor(dependencies: StateServiceDependencies){
		this.deps = dependencies;
		this.init();
	}

	private init(): void {
		this.initializeMarkovUser();
		this.startAfkTimer();
	}

	public getEmotes(): Map<string, string>{
		return new Map(this.emotes);
	}

	public async updateEmotes(io: RatServer, setID?: string): Promise<number>{

		const targetID = setID ?? this.deps.configService.getServerConfig().stvurl;
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

			const data: unknown = await response.json();
			if(typeof data !== 'object' || data === null || !('emotes' in data)){
				throw new AppError('invalid 7tv response structure', 'internal', 'warn');
			}

			if(!isUnknownArray(data.emotes)){
				throw new AppError('invalid 7tv response structure', 'internal', 'warn');
			}

			let size: number = 0;
			let drops: number = 0;
			data.emotes.forEach(emote => {
				if(!this.isValidEmoteEntry(emote)){
					drops++;
					return;
				}
				this.emotes.set(emote.name, `https:${emote.data.host.url}/1x.webp`);
				size++;
			});

			if(drops > 0){
				console.warn(`${drops} dropped emote entry(s) on updateEmotes, check 7TV API response structure`);
			}

			const emotePayload = Object.fromEntries(this.emotes);
			this.deps.dispatchService.sendEmoteListPayload(io, emotePayload);
			return size;
		}
		catch(error: unknown){
			if(error instanceof AppError){
				throw error;
			}
			handleError(error, 'Update Emotes');

			throw new AppError('failed to fetch emotes: unknown error', 'user');
		}
	}

	public async deleteEmotes(io: RatServer, setID: string): Promise<number>{
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

			const data: unknown = await response.json();
			if(typeof data !== 'object' || data === null || !('emotes' in data)){
				throw new AppError('invalid 7tv response structure', 'internal', 'warn');
			}

			if(!isUnknownArray(data.emotes)){
				throw new AppError('invalid 7tv response structure', 'internal', 'warn');
			}

			let deleteCount: number = 0;
			let drops : number = 0;
			data.emotes.forEach((emote) => {
				if(!this.isValidEmoteEntry(emote)){
					drops++;
					return;
				}
				const del = this.emotes.delete(emote.name);
				if(del){
					deleteCount++;
				}
			});

			if(drops > 0){
				console.warn(`${drops} dropped emote entry(s) on deleteEmotes, check 7TV API response structure`);
			}

			const emotePayload = Object.fromEntries(this.emotes);
			this.deps.dispatchService.sendEmoteListPayload(io, emotePayload);
			return deleteCount;
		}
		catch(error: unknown){
			if(error instanceof AppError){
				throw error;
			}
			handleError(error, 'Delete Emotes');

			throw new AppError('failed to fetch emotes: unknown error', 'user');
		}
	}

	public getSocketUsersMap(): Map<RatSocket['id'], Identity>{
		const copy = new Map<RatSocket['id'], Identity>();

		for(const [socketID, identity] of this.socketUsers){
			copy.set(socketID, structuredClone(identity));
		}

		return copy;
	}

	public getSocketUser(socketID: RatSocket['id']): Identity | null {
		const user = this.socketUsers.get(socketID);
		if(!user){
			return null;
		}
		return structuredClone(user);
	}

	public updateSocketUser(io: RatServer, socketID: RatSocket['id'], identity: Identity): void {
		this.socketUsers.set(socketID, identity);

		for (const [sId, user] of this.socketUsers.entries()){
			if(user.guid === identity.guid && sId !== socketID){
				this.socketUsers.set(sId, identity);
			}
		}

		this.broadcastUsers(io);
	}

	public deleteSocketUser(io: RatServer, socketID: RatSocket['id']): void {
		this.socketUsers.delete(socketID);
		this.broadcastUsers(io);
	}

	public broadcastUsers(io: RatServer): void {
		const userList: UserSum[] = Array.from(this.socketUsers.values())
			.map(({ fullnick, status, isMod, isAfk }) => ({ fullnick, status, isMod, isAfk }))
			.sort((a,b) =>{
				if(a.isAfk !== b.isAfk){
					return a.isAfk ? 1 : -1;
				}
				if(a.isMod !== b.isMod){
					return a.isMod ? -1 : 1;
				}
				return getBaseNick(a.fullnick).localeCompare(getBaseNick(b.fullnick), 'en', {sensitivity: 'base'});
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

		this.deps.dispatchService.sendUserListPayload(io, userList);
	}

	public toggleMarkov(io: RatServer): Identity {
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
		}, this.deps.configService.getMarkovConfig().cooldown * 1000);

		return this.markovUser;
	}

	public toggleMarkovSleep(io: RatServer): boolean {
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

	public async restoreMarkovSleep(): Promise<void> {
		if(!this.deps.configService.getMarkovConfig().enabled){
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

	public setAnnouncement(io: RatServer, str: SafeString): void {
		if(this.announcement === str){
			throw new AppError("that's already the announcement", 'user');
		}

		this.announcement = str;

		if(str){
			this.deps.dispatchService.sendSystemChatPayload(io, cType.ann,`announcement: ${str}`);
		}

		this.announcementQueue.chain();
	}

	public async restoreAnnouncement(): Promise<void> {
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
				else if(announcementLoad.length > this.deps.configService.getServerConfig().maxMsgLen){
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

	public queueSignup(socket: RatSocket, basenick: SafeString): Promise<boolean> {
		return new Promise<boolean>((resolve, reject) => {
			try {
				const hashed = hashIP(socket.handshake.address);
				this.signupBuffer.set(hashed, { socket, basenick });
				this.signupPromise.set(socket, resolve);
				if(!this.signupTimer){
					this.signupTimer = setTimeout(() => this.resolveSignups(), this.deps.configService.getServerConfig().signupTime * 1000);
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

	private resolveSignups(): void {
		const queue = Array.from(this.signupBuffer.values());

		for (const [socket, resolve] of this.signupPromise.entries()){
			const survived = queue.some(entry => entry.socket === socket);
			resolve(survived);
		}

		this.signupBuffer.clear();
		this.signupPromise.clear();
		this.signupTimer = null;
	}
	private isValidEmoteEntry(input: unknown): input is EmoteEntry {
		if(typeof input !== 'object' || input === null){
			return false;
		}
		if(!('name' in input) || typeof input.name !== 'string'){
			return false;
		}
		if(!('data' in input) || typeof input.data !== 'object' || input.data === null){
			return false;
		}
		if(!('host' in input.data) || typeof input.data.host !== 'object' || input.data.host === null){
			return false;
		}
		if(!('url' in input.data.host) || typeof input.data.host.url !== 'string'){
			return false;
		}
		return true;
	}

	private async saveAnnouncement(): Promise<void> {
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

	private async saveMarkovSleep(): Promise<void> {
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

	private initializeMarkovUser(): void {
		const markovConfig = this.deps.configService.getMarkovConfig();
		if(markovConfig.enabled){
			this.markovUser = {
				guid: 'markov',
				playerid: 'markov',
				fullnick: markovConfig.color + markovConfig.basenick,
				status: markovConfig.status,
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

	private startAfkTimer(): void {
		setInterval(() =>{
			const now = Date.now();
			const afkTime = this.deps.configService.getServerConfig().afkDef * 1000;
			const updates: Array<{ id: RatSocket['id']; user: Identity }> = [];

			for(const [id, user] of this.socketUsers.entries()){
				const lastMessage = new Date(user.lastMessage).getTime();
				const lastChanged = new Date(user.lastChanged).getTime();

				if(now - lastMessage > afkTime && now - lastChanged > afkTime){
					if(!user.isAfk){
						const update = this.deps.identityService.setAfk(user.guid);
						updates.push({id: id, user: update});
					}
				}
			}

			if(updates.length > 0){
				updates.forEach(({ id, user }) => {
					this.socketUsers.set(id, user);
				});

				this.broadcastUsers(this.deps.io);
			}
		}, 60000);
	}
}
