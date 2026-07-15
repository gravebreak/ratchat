import { fType } from '../../defs/def-games';
import { aType } from '../../defs/def-parse';
import { HorseRecordEntrySchema, FishRecordEntrySchema } from '../../defs/def-record';
import type { FishCatch, FishingEventCallback, FishResult } from '../../defs/def-games';
import type { GameIdentity } from '../../defs/def-identity';
import type { LeaderboardEntry, BlackjackEntry, DuelingEntry, FishingEntry, HorseEntry } from '../../defs/def-leaderboard';
import type { PublicLeaderboard, PublicOverallLeaderboard, PublicBlackjackLeaderboard, PublicDuelingLeaderboard, PublicFishingLeaderboard, PublicHorseLeaderboard } from '../../defs/def-leaderboard';
import type { KeyedParseFailureRecord, ParseFailureRecord } from '../../defs/def-parse';
import type { PrivateHorseRecordList, PrivateFishRecordList, DefaultFishRecordEntry, DefaultHorseRecordEntry } from '../../defs/def-record';

import { CacheService } from '../cache';
import { DispatchService } from '../dispatch';
import { GameIdentityService } from './game-identity';
import { IdentityService } from '../identity';

import { handleError, AppError } from '../../utils/errors';
import { mergeRecordDefaults, isUnknownArray } from '../../utils/parse';
import { createSaveQueue } from '../../utils/queue';
import { randomInt } from '../../utils/random';
import { assertSafeStartup, getRepairPath } from '../../utils/repair';
import { createJsonFile, existsFile, readJsonFile, writeJsonFile } from '../../utils/serialize';

import { createCatch } from './game-utils/fishing';

import { defaultFishCatalog } from '../catalogs/catalog-fish';
import { defaultHorseCatalog } from '../catalogs/catalog-horse';

type StageOne = GameIdentity & {fullnick: string };
type StageTwo = StageOne & { fishingTypesCaught: number, fishingRecords: number };
type FullEntry = LeaderboardEntry & BlackjackEntry & DuelingEntry & FishingEntry & HorseEntry;
type FullLeaderboard = FullEntry[];

type FishingSession = {
	playerid: GameIdentity['playerid'];
	fish: FishCatch | null;
	biting: boolean;
	biteTimer: NodeJS.Timeout;
	expireTimer: NodeJS.Timeout | null;
	eventCallback: FishingEventCallback;
};

//const REDIS_BLACKJACK_KEY = 'ratchat:blackjack';
const MIN_FISH_WAIT = 5;
const MAX_FISH_WAIT = 20;
const MIN_FISH_WAIT_TARGET = 10;
const MAX_FISH_WAIT_TARGET = 60;
const MIN_FISH_WAIT_BAD_TARGET = 50;
const MAX_FISH_WAIT_BAD_TARGET = 60;
const MIN_FISH_CATCH_WINDOW = 5;
const MAX_FISH_CATCH_WINDOW = 10;
const BIG_FISH_THRESHOLD = 80;
const SMALL_FISH_THRESHOLD = 5;

export interface GameStateServiceDependencies{
	cacheService: CacheService;
	dispatchService: DispatchService;
	gameIdentityService: GameIdentityService;
	identityService: IdentityService;

	fishingRecordsPath: string;
	horseRecordsPath: string
}

export class GameStateService {
	private activeFishing: Map<GameIdentity['playerid'], FishingSession> = new Map();

	private horseRecords: PrivateHorseRecordList = [];
	private fishRecords: PrivateFishRecordList = [];

	private fishQueue = createSaveQueue(() => this.saveRecords(this.deps.fishingRecordsPath, this.fishRecords));
	private horseQueue = createSaveQueue(() => this.saveRecords(this.deps.horseRecordsPath, this.horseRecords));

	private deps: GameStateServiceDependencies;
	constructor(dependencies: GameStateServiceDependencies){
		this.deps = dependencies;
		this.init();
	}

	private init(): void {
		assertSafeStartup(this.deps.fishingRecordsPath);
		assertSafeStartup(this.deps.horseRecordsPath);
		this.initializeFishRecords();
		this.initializeHorseRecords();
	}

	public existsFishingSession(playerid: GameIdentity['playerid']): boolean {
		const session = this.activeFishing.get(playerid);
		if(session){
			return true;
		}
		return false;
	}

	public createFishingSession(playerid: GameIdentity['playerid'], target: string | null, callback: FishingEventCallback): void {
		const fishCatch = createCatch(target, this.fishRecords);

		let castDuration: number;
		if(!fishCatch){
			castDuration = randomInt(MIN_FISH_WAIT_BAD_TARGET, MAX_FISH_WAIT_BAD_TARGET);
		}
		else if(target){
			castDuration = randomInt(MIN_FISH_WAIT_TARGET, MAX_FISH_WAIT_TARGET);
		}
		else{
			castDuration = randomInt(MIN_FISH_WAIT, MAX_FISH_WAIT);
		}

		const biteTimer = setTimeout(() => {
			this.advanceFishingSession(playerid);
		}, castDuration * 1000);

		const session: FishingSession = {
			playerid: playerid,
			fish: fishCatch,
			biting: false,
			biteTimer: biteTimer,
			expireTimer: null,
			eventCallback: callback
		};

		this.activeFishing.set(playerid, session);
	}

	public catchFishingSession(playerid: GameIdentity['playerid']): FishResult | null {
		const session = this.activeFishing.get(playerid);

		if(!session){
			throw new AppError("you don't have a line in the water", 'user');
		}

		if(!session.biting || !session.fish){
			clearTimeout(session.biteTimer);
			this.activeFishing.delete(playerid);
			return null;
		}
		const fishCatch = session.fish;

		if(session.expireTimer){
			clearTimeout(session.expireTimer);
		}
		this.activeFishing.delete(playerid);
		const currentRecord = this.fishRecords.find(entry => entry.fishName === fishCatch.name);

		if(!currentRecord){
			throw new AppError('no matching fish record found for caught fish', 'bug');
		}

		let record = false;
		if(!currentRecord.weight || fishCatch.weight > currentRecord.weight){
			record = true;
			currentRecord.weight = fishCatch.weight;
			currentRecord.playerid = playerid;
			currentRecord.fullnick = this.deps.identityService.getFullNickByPlayerId(playerid);
			this.fishQueue.chain();
		}

		const gameUser = this.deps.gameIdentityService.getGameUser(playerid);

		let pb = false;
		if(gameUser.fishingBestCatchValue === null || Math.ceil(fishCatch.value) > gameUser.fishingBestCatchValue){
			pb = true;
			const bestCatchDisplay = `${fishCatch.name}, ${fishCatch.weight}oz`;
			this.deps.gameIdentityService.setFishingBestCatch(playerid, bestCatchDisplay, fishCatch.value);
		}
		const newcatch = !gameUser.fishingFishCaught.includes(fishCatch.name);
		if(newcatch){
			this.deps.gameIdentityService.setFishingFishCaught(gameUser.playerid, fishCatch.name);
		}
		const big = fishCatch.value > BIG_FISH_THRESHOLD;
		const small = fishCatch.value < SMALL_FISH_THRESHOLD;
		const fishResult = {
			name: fishCatch.name,
			flavor: fishCatch.flavor,
			weight: fishCatch.weight,
			value: fishCatch.value,
			record: record,
			pb: pb,
			newcatch: newcatch,
			big: big,
			small: small
		};
		this.deps.gameIdentityService.incrementFishingCatches(gameUser.playerid);
		return fishResult;
	}

	private advanceFishingSession(playerid: GameIdentity['playerid']): void {
		const session = this.activeFishing.get(playerid);
		if(!session){
			return;
		}
		if(!session.fish){
			this.activeFishing.delete(playerid);
			session.eventCallback(playerid, fType.nothing);
			return;
		}

		session.biting = true;
		session.eventCallback(playerid, fType.bite);

		const catchWindow = MAX_FISH_CATCH_WINDOW - ((session.fish.value / 100) * (MAX_FISH_CATCH_WINDOW - MIN_FISH_CATCH_WINDOW));

		const expireTimer = setTimeout(() => {
			this.expireFishingSession(playerid);
		}, catchWindow * 1000);

		session.expireTimer = expireTimer;
	}

	private expireFishingSession(playerid: GameIdentity['playerid']): void {
		const session = this.activeFishing.get(playerid);

		if(!session){
			return;
		}

		this.activeFishing.delete(playerid);
		session.eventCallback(playerid, fType.expired);
	}

	public getLeaderboard(): PublicOverallLeaderboard;
	public getLeaderboard(label: 'blackjack'): PublicBlackjackLeaderboard;
	public getLeaderboard(label: 'dueling'): PublicDuelingLeaderboard;
	public getLeaderboard(label: 'fishing'): PublicFishingLeaderboard;
	public getLeaderboard(label: 'horse'): PublicHorseLeaderboard;
	public getLeaderboard(label?: 'blackjack' | 'dueling' | 'fishing' | 'horse'): PublicLeaderboard{
		const usersMap = this.deps.gameIdentityService.getGameUsersMap();
		const entriesArray = Array.from(usersMap.values());

		const withNicks = this.joinNicksToArray(entriesArray);
		const withFishingStats = this.joinFishingStatsToArray(withNicks);

		const fullEntries: FullEntry[] = withFishingStats;

		switch(label){
			case 'blackjack':{
				return this.buildPublicLeaderboard(fullEntries, 'blackjack');
			}

			case 'dueling':{
				return this.buildPublicLeaderboard(fullEntries, 'dueling');
			}

			case 'fishing':{
				return this.buildPublicLeaderboard(fullEntries, 'fishing');
			}

			case 'horse':{
				return this.buildPublicLeaderboard(fullEntries, 'horse');
			}

			default:{
				return this.buildPublicLeaderboard(fullEntries);
			}
		}
	}

	public reconcileRecords(): void {
		let fishChanged = false;
		for(const record of this.fishRecords){
			if(record.playerid !== null && !this.deps.gameIdentityService.existsGameUser(record.playerid)){
				Object.assign(record, this.buildDefaultFishRecordEntry());
				fishChanged = true;
			}
		}
		if(fishChanged){
			this.fishQueue.chain();
		}
	}

	private joinNicksToArray(entries: GameIdentity[]): StageOne[]{
		const results: StageOne[] = [];

		for(const gameidentity of entries){
			try{
				const fullnick = this.deps.identityService.getFullNickByPlayerId(gameidentity.playerid);
				results.push({ ...gameidentity, fullnick });
			}
			catch(error: unknown){
				handleError(error, `Join Nicks To Array (playerid ${gameidentity.playerid})`);
				continue;
			}
		}

		return results;
	}

	private joinFishingStatsToArray(entries: StageOne[]): StageTwo[] {
		const recordCounts = new Map<GameIdentity['playerid'], number>();

		for(const record of this.fishRecords){
			if(record.playerid === null){
				continue;
			}
			const count = recordCounts.get(record.playerid) ?? 0;
			recordCounts.set(record.playerid, count + 1);
		}

		return entries.map((entry) => ({
			...entry,
			fishingTypesCaught: entry.fishingFishCaught.length,
			fishingRecords: recordCounts.get(entry.playerid) ?? 0,
		}));
	}

	private buildPublicLeaderboard(entries: FullLeaderboard): PublicOverallLeaderboard;
	private buildPublicLeaderboard(entries: FullLeaderboard, label: 'blackjack'): PublicBlackjackLeaderboard;
	private buildPublicLeaderboard(entries: FullLeaderboard, label: 'dueling'): PublicDuelingLeaderboard;
	private buildPublicLeaderboard(entries: FullLeaderboard, label: 'fishing'): PublicFishingLeaderboard;
	private buildPublicLeaderboard(entries: FullLeaderboard, label: 'horse'): PublicHorseLeaderboard;
	private buildPublicLeaderboard(entries: FullLeaderboard, label?: 'blackjack' | 'dueling' | 'fishing' | 'horse'): PublicLeaderboard {
		switch(label){
			case 'blackjack':{
				return entries.map((entry) => ({
					fullnick: entry.fullnick,
					blackjackWinnings: entry.blackjackWinnings,
					blackjackBlackjacks: entry.blackjackBlackjacks,
				}));
			}

			case 'dueling':{
				return entries.map((entry) => ({
					fullnick: entry.fullnick,
					duelingWins: entry.duelingWins,
					duelingHonor: entry.duelingHonor,
				}));
			}

			case 'fishing':{
				return entries.map((entry) => ({
					fullnick: entry.fullnick,
					fishingCatches: entry.fishingCatches,
					fishingTypesCaught: entry.fishingTypesCaught,
					fishingWinnings: entry.fishingWinnings,
					fishingBestCatchValue: entry.fishingBestCatchValue,
					fishingRecords: entry.fishingRecords,
				}));
			}

			case 'horse':{
				return entries.map((entry) => ({
					fullnick: entry.fullnick,
					horseWinnings: entry.horseWinnings,
					horseBetWins: entry.horseBetWins,
				}));
			}
			default:{
				return entries.map((entry) => ({
					fullnick: entry.fullnick,
					gamePoints: entry.gamePoints,
				}));
			}
		}
	}

	private buildDefaultFishRecordEntry(): DefaultFishRecordEntry{
		return{
			weight: null,
			playerid: null,
			fullnick: null
		};
	}

	private buildDefaultHorseRecordEntry(): DefaultHorseRecordEntry{
		return{
			wins: 0
		};
	}

	private async saveRecords(path: string, data: unknown): Promise<void> {
		try{
			await writeJsonFile(path, data);
		}
		catch(error: unknown){
			handleError(error, `Save Records (${path})`);
		}
	}

	private initializeFishRecords(): void {
		try{
			const raw = this.fetchRecords(this.deps.fishingRecordsPath, 'fish');
			const [resolvedRecords, failures] = this.resolveRecords(raw, 'fish');

			if(failures.length > 0){
				console.error(`Load Fish Records found ${failures.length} field failure(s) across all records, writing repair file`);
				createJsonFile(getRepairPath(this.deps.fishingRecordsPath), failures);
			}

			this.fishRecords = resolvedRecords;
			this.fishQueue.chain();
		}
		catch(error: unknown){
			handleError(error, 'Fish Records Load (Startup)');
			const defaultRecords = this.buildFishRecords();
			this.fishRecords = defaultRecords;

		}
	}

	private initializeHorseRecords(): void {
		try{
			const raw = this.fetchRecords(this.deps.horseRecordsPath, 'horse');
			const [resolvedRecords, failures] = this.resolveRecords(raw, 'horse');

			if(failures.length > 0){
				console.error(`Load Horse Records found ${failures.length} field failure(s) across all records, writing repair file`);
				createJsonFile(getRepairPath(this.deps.horseRecordsPath), failures);
			}

			this.horseRecords = resolvedRecords;
			this.horseQueue.chain();
		}
		catch(error: unknown){
			handleError(error, 'Horse Records Load (Startup)');
			const defaultRecords = this.buildHorseRecords();
			this.horseRecords = defaultRecords;
		}
	}

	private fetchRecords(path: string, label: 'fish'): unknown;
	private fetchRecords(path: string, label: 'horse'): unknown;
	private fetchRecords(path: string, label: 'fish' | 'horse'): unknown{
		if(!existsFile(path)){
			let defaultRecords: PrivateFishRecordList | PrivateHorseRecordList;

			switch(label){
				case 'fish':{
					defaultRecords = this.buildFishRecords();
					break;
				}
				case 'horse':{
					defaultRecords = this.buildHorseRecords();
					break;
				}
				default:{
					throw new AppError('fetchRecords called without appropriate label', 'bug');
				}
			}

			createJsonFile(path, defaultRecords);
			return defaultRecords;
		}

		const raw = readJsonFile(path);
		return raw;
	}

	private buildFishRecords(): PrivateFishRecordList {
		return defaultFishCatalog.map((catalogEntry) => ({
			...catalogEntry,
			...this.buildDefaultFishRecordEntry()
		}));
	}

	private buildHorseRecords(): PrivateHorseRecordList {
		return defaultHorseCatalog.map((catalogEntry) => ({
			...catalogEntry,
			...this.buildDefaultHorseRecordEntry()
		}));
	}

	private resolveRecords(input: unknown, label: 'fish'): [PrivateFishRecordList, KeyedParseFailureRecord[]];
	private resolveRecords(input: unknown, label: 'horse'): [PrivateHorseRecordList, KeyedParseFailureRecord[]];
	private resolveRecords(input: unknown, label: 'fish' | 'horse'): [PrivateFishRecordList, KeyedParseFailureRecord[]] | [PrivateHorseRecordList, KeyedParseFailureRecord[]]{
		switch(label){
			case 'fish':{
				return this.genericResolveRecords(input, 'fish', (entry) => mergeRecordDefaults(entry, aType.gfish, this.buildDefaultFishRecordEntry(), FishRecordEntrySchema));
			}
			case 'horse':{
				return this.genericResolveRecords(input, 'horse', (entry) => mergeRecordDefaults(entry, aType.ghorse, this.buildDefaultHorseRecordEntry(), HorseRecordEntrySchema));
			}
			default:{
				throw new AppError('resolveRecords called without appropriate label', 'bug');
			}
		}
	}

	private genericResolveRecords<RecordEntry>(input: unknown, label: string, resolveEntry: (entry: unknown) => [RecordEntry | null, ParseFailureRecord[]]): [RecordEntry[], KeyedParseFailureRecord[]]{
		if(!isUnknownArray(input)){
			throw new AppError(`${label} record file did not contain an array`, 'internal', 'warn');
		}

		const failures: KeyedParseFailureRecord[] = [];
		const resolvedRecords: RecordEntry[] = [];

		for(const [index, entry] of input.entries()){
			const [record, mergeFailures] = resolveEntry(entry);

			for(const failure of mergeFailures){
				failures.push({ ...failure, recordKey: `index ${index}` });
			}
			if(record === null){
				continue;
			}
			resolvedRecords.push(record);
		}

		return [resolvedRecords, failures];
	}
}
