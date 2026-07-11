import { aType } from '../../defs/def-parse';
import { HorseRecordEntrySchema, FishRecordEntrySchema } from '../../defs/def-record';
import type { GameIdentity } from '../../defs/def-identity';
import type { LeaderboardEntry, BlackjackEntry, DuelingEntry, FishingEntry, HorseEntry } from '../../defs/def-leaderboard';
import type { PublicLeaderboard, PublicOverallLeaderboard, PublicBlackjackLeaderboard, PublicDuelingLeaderboard, PublicFishingLeaderboard, PublicHorseLeaderboard } from '../../defs/def-leaderboard';
import type { KeyedParseFailureRecord, ParseFailureRecord } from '../../defs/def-parse';
import type { PrivateHorseRecordList, PrivateFishRecordList, DefaultFishRecordEntry, DefaultHorseRecordEntry, FishRecordEntry, HorseRecordEntry } from '../../defs/def-record';

import { CacheService } from "../cache";
import { DispatchService } from "../dispatch";
import { GameIdentityService } from "./game-identity";
import { IdentityService } from "../identity";

import { handleError, AppError } from "../../utils/errors";
import { mergeRecordDefaults } from '../../utils/parse';
import { createSaveQueue } from '../../utils/queue';
import { assertSafeStartup, getRepairPath } from '../../utils/repair';
import { createJsonFile, existsFile, readJsonFile, writeJsonFile } from '../../utils/serialize';

import { defaultFishCatalog } from '../catalogs/catalog-fish';
import { defaultHorseCatalog } from '../catalogs/catalog-horse';

type StageOne = GameIdentity & {fullnick: string };
type StageTwo = StageOne & { fishingTypesCaught: number, fishingRecords: number };
type FullEntry = LeaderboardEntry & BlackjackEntry & DuelingEntry & FishingEntry & HorseEntry;
type FullLeaderboard = FullEntry[];

//const REDIS_BLACKJACK_KEY = 'ratchat:blackjack';

export interface GameStateServiceDependencies{
	cacheService: CacheService;
	dispatchService: DispatchService;
	gameIdentityService: GameIdentityService;
	identityService: IdentityService;

	fishingRecordsPath: string; 
	horseRecordsPath: string
}

export class GameStateService {
	private horseRecords: PrivateHorseRecordList = [];
	private fishRecords: PrivateFishRecordList = [];

	private fishQueue = createSaveQueue(() => this.saveRecords(this.deps.fishingRecordsPath, this.fishRecords));
	private horseQueue = createSaveQueue(() => this.saveRecords(this.deps.horseRecordsPath, this.horseRecords));

	private deps: GameStateServiceDependencies;
	constructor(dependencies: GameStateServiceDependencies){
		this.deps = dependencies;
		this.init();
	}

	private init(){
		assertSafeStartup(this.deps.fishingRecordsPath);
		assertSafeStartup(this.deps.horseRecordsPath);
		this.initializeFishRecords();
		this.initializeHorseRecords();
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
		const recordCounts = new Map<string, number>();

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

	private async saveRecords(path: string, data: unknown){
		try{
			await writeJsonFile(path, data);
		}
		catch(error: unknown){
			handleError(error, `Save Records (${path})`);
		}
	}

	private initializeFishRecords(){
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

	private initializeHorseRecords(){
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
		if(!Array.isArray(input)){
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