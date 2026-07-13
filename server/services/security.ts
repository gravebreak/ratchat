import { Socket } from 'socket.io';

import { ConfigService } from './config';

import { handleError, AppError } from '../utils/errors';
import { hashIP } from '../utils/hash';
import { createSaveQueue } from '../utils/queue';
import { existsFile, createJsonFile, readJsonFile, writeJsonFile } from '../utils/serialize';

type BanEntry = {
	hash: string;
	date: Date;
}

type BanTimerEntry = {
	timer: NodeJS.Timeout;
	armedForDate: Date;
}

export interface SecurityServiceDependencies{
	configService: ConfigService;

	bansPath: string;
}

export class SecurityService{
	private bans: Map<BanEntry['hash'], BanEntry> = new Map();
	private bansTimers: Map<BanEntry['hash'], BanTimerEntry> = new Map();
	private banQueue = createSaveQueue(() => this.saveBans());
	
	private deps: SecurityServiceDependencies;
	constructor(dependencies: SecurityServiceDependencies){
		this.deps = dependencies;
		this.init();
	}

	private init(): void {
		this.initializeBans();
		this.startBanSweepTimer();
	}
	
	public existsBan(address: Socket['handshake']['address']): boolean {
		try{
			const hash = hashIP(address);
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
			
			throw new AppError('failed to check ban: unknown error', 'user');
		}
	}

	public setBan(socket: Socket): void {
		const banIP = hashIP(socket.handshake.address);
		const now = new Date();
		const ban: BanEntry = {hash: banIP, date: now};
		this.bans.set(ban.hash, ban);
		this.scheduleBanExpiration(ban);
		this.banQueue.chain();
	}

	private deleteBan(ban: BanEntry): void {
		this.bans.delete(ban.hash);
		this.bansTimers.delete(ban.hash);
		this.banQueue.chain();
	}

	private scheduleBanExpiration(ban: BanEntry): void {
		const existing = this.bansTimers.get(ban.hash);
		if(existing && existing.armedForDate.getTime() === ban.date.getTime()){
			return;
		}

		if(existing){
			clearTimeout(existing.timer);
			this.bansTimers.delete(ban.hash);
		}


		const banLengthMs = this.deps.configService.getServerConfig().banLength * 24 * 60 * 60 * 1000;
		const armThresholdMs = 14 * 24 * 60 * 60 * 1000;
		const expires = ban.date.getTime() + banLengthMs;
		const remaining = expires - Date.now();

		if(remaining <= armThresholdMs){
			const timer = setTimeout(() => this.deleteBan(ban), remaining);
			const bte : BanTimerEntry = {timer: timer, armedForDate: ban.date};
			this.bansTimers.set(ban.hash, bte);
		}
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
		this.assignBans(validbans);
	}

	private fetchBans(): unknown {
		const bans: unknown[] = [];
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

	private resolveBans(input: unknown): BanEntry[]{
		if(!Array.isArray(input)){
			console.error('Ban data was not an array, starting fresh');
			return [];
		}
		const banLengthMS = this.deps.configService.getServerConfig().banLength * 24 * 60 * 60 * 1000;
		const validEntries: BanEntry[] = [];
		let invalidEntries = 0;
		let expiredEntries = 0;
		for(const entry of input){
			if(!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string'){
				invalidEntries++;
				continue;
			}

			if(typeof entry[1] !== 'object' || entry[1] === null || !('date' in entry[1])){
				invalidEntries++;
				continue;
			}

			const date = new Date((entry[1]).date);
			if(isNaN(date.getTime())){
				invalidEntries++;
				continue;
			}

			const expire = date.getTime() + banLengthMS;
			if(expire < Date.now()){
				expiredEntries++;
				continue;
			}

			validEntries.push({hash: entry[0], date: date});
		}
		console.log(`loaded ${validEntries.length} bans, ${invalidEntries} invalid entries dropped, ${expiredEntries} expired.`);
		return validEntries;
	}

	private assignBans(entries: BanEntry[]): void {
		const bans = new Map<BanEntry['hash'], BanEntry>();

		for(const entry of entries){
			bans.set(entry.hash, entry);
			this.scheduleBanExpiration(entry);
		}

		this.bans = bans;
		this.banQueue.chain();
	}

	private startBanSweepTimer(): void {
		const sweepIntervalMs = 7 * 24 * 60 * 60 * 1000;
		setInterval(() => {
			for(const ban of this.bans.values()){
				this.scheduleBanExpiration(ban);
			}
		}, sweepIntervalMs);
	}
}