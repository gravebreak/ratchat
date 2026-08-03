import {hType} from '../../defs/def-events';
import {aType} from '../../defs/def-parse';
import {HorseRecordEntrySchema, FishRecordEntrySchema} from '../../defs/def-record';
import type {GameIdentity} from '../../defs/def-identity';
import type {LeaderboardEntry, BlackjackEntry, DuelingEntry, FishingEntry, HorseEntry} from '../../defs/def-leaderboard';
import type {PublicLeaderboard, PublicOverallLeaderboard, PublicBlackjackLeaderboard, PublicDuelingLeaderboard, PublicFishingLeaderboard, PublicHorseLeaderboard} from '../../defs/def-leaderboard';
import type {KeyedParseFailureRecord, ParseFailureRecord} from '../../defs/def-parse';
import type {PrivateHorseRecordList, PrivateFishRecordList, DefaultFishRecordEntry, DefaultHorseRecordEntry, HorseRecordEntry, FishRecordEntry} from '../../defs/def-record';

import {ConfigService} from '../config';
import {GameIdentityService} from './game-identity';
import {IdentityService} from '../identity';

import {handleError, AppError} from '../../utils/errors';
import {mergeRecordDefaults, isUnknownArray} from '../../utils/parse';
import {createSaveQueue} from '../../utils/queue';
import {assertSafeStartup, getRepairPath} from '../../utils/repair';
import {createJsonFile, existsFile, readJsonFile, writeJsonFile} from '../../utils/serialize';
import {assertGamesEnabled} from './game-utils/checks';

import {defaultFishCatalog} from '../catalogs/catalog-fish';
import {defaultHorseCatalog} from '../catalogs/catalog-horse';

type StageOne = GameIdentity & {fullnick: string};
type StageTwo = StageOne & {fishingTypesCaught: number, fishingRecords: number};
type FullEntry = LeaderboardEntry & BlackjackEntry & DuelingEntry & FishingEntry & HorseEntry;
type FullLeaderboard = FullEntry[];

export interface GameRecordServiceDependencies{
	configService: ConfigService
	gameIdentityService: GameIdentityService;
	identityService: IdentityService;

	fishingRecordsPath: string;
	horseRecordsPath: string;
}

export class GameRecordService {
	private horseRecords: PrivateHorseRecordList = [];
	private fishRecords: PrivateFishRecordList = [];

	private fishQueue = createSaveQueue(() => this.saveRecords(this.deps.fishingRecordsPath, this.fishRecords));
	private horseQueue = createSaveQueue(() => this.saveRecords(this.deps.horseRecordsPath, this.horseRecords));

	private deps: GameRecordServiceDependencies;
	constructor(dependencies: GameRecordServiceDependencies){
		this.deps = dependencies;
		this.init();
	}

	private init(): void {
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
		assertGamesEnabled(this.deps.configService, 'getLeaderboard');

		const usersMap = this.deps.gameIdentityService.getGameUsersMap();
		const entriesArray = Array.from(usersMap.values());

		const withNicks = this.joinNicksToArray(entriesArray);
		const withFishingStats = this.joinFishingStatsToArray(withNicks);

		const fullEntries: FullEntry[] = withFishingStats;

		switch(label){
			case 'blackjack':{
				return this.createPublicLeaderboard(fullEntries, 'blackjack');
			}

			case 'dueling':{
				return this.createPublicLeaderboard(fullEntries, 'dueling');
			}

			case 'fishing':{
				return this.createPublicLeaderboard(fullEntries, 'fishing');
			}

			case 'horse':{
				return this.createPublicLeaderboard(fullEntries, 'horse');
			}

			default:{
				return this.createPublicLeaderboard(fullEntries);
			}
		}
	}

	public getFishRecords(): FishRecordEntry[]{
		const fishRecords: FishRecordEntry[] = [];
		for(const record of this.fishRecords){
			const copy = structuredClone(record);
			fishRecords.push(copy);
		}

		return fishRecords;
	}

	public setFishRecord(record: FishRecordEntry): void {
		const copy = structuredClone(record);
		const target = this.fishRecords.find(entry => entry.fishName === copy.fishName);
		if(!target){
			throw new AppError('no matching fish record found for set fish record', 'bug');
		}

		Object.assign(target, copy);
		this.fishQueue.chain();
	}

	public getHorseRecords(): HorseRecordEntry[]{
		const horseRecords: HorseRecordEntry[] = [];
		for(const record of this.horseRecords){
			const copy = structuredClone(record);
			horseRecords.push(copy);
		}

		return horseRecords;
	}

	public incrementHorseRecord(horseName: HorseRecordEntry['horseName'], place: keyof HorseRecordEntry['finishes']): void {
		const record = this.horseRecords.find(entry => entry.horseName === horseName);
		if(!record){
			throw new AppError('no matching horse record found to increment', 'bug');
		}

		record.finishes[place]++;
		this.horseQueue.chain();
	}

	public deleteOrphanedRecords(): void {
		let fishChanged = false;
		for(const record of this.fishRecords){
			if(record.playerid !== null && !this.deps.gameIdentityService.existsGameUser(record.playerid)){
				Object.assign(record, this.createDefaultFishRecordEntry());
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
				results.push({...gameidentity, fullnick});
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

	private createPublicLeaderboard(entries: FullLeaderboard): PublicOverallLeaderboard;
	private createPublicLeaderboard(entries: FullLeaderboard, label: 'blackjack'): PublicBlackjackLeaderboard;
	private createPublicLeaderboard(entries: FullLeaderboard, label: 'dueling'): PublicDuelingLeaderboard;
	private createPublicLeaderboard(entries: FullLeaderboard, label: 'fishing'): PublicFishingLeaderboard;
	private createPublicLeaderboard(entries: FullLeaderboard, label: 'horse'): PublicHorseLeaderboard;
	private createPublicLeaderboard(entries: FullLeaderboard, label?: 'blackjack' | 'dueling' | 'fishing' | 'horse'): PublicLeaderboard {
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

	private createDefaultFishRecordEntry(): DefaultFishRecordEntry{
		return{
			weight: null,
			playerid: null,
			fullnick: null,
			fishColor: hType.navy
		};
	}

	private createDefaultHorseRecordEntry(): DefaultHorseRecordEntry{
		return{
			finishes: {first: 0, second: 0, third: 0}
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
			const [mergedRecords, failures] = this.mergeRecords(raw, 'fish');

			if(failures.length > 0){
				console.error(`Load Fish Records found ${failures.length} field failure(s) across all records, writing repair file`);
				createJsonFile(getRepairPath(this.deps.fishingRecordsPath), failures);
			}

			this.fishRecords = mergedRecords;
			this.fishQueue.chain();
		}
		catch(error: unknown){
			handleError(error, 'Fish Records Load (Startup)');
			const defaultRecords = this.createFishRecords();
			this.fishRecords = defaultRecords;

		}
	}

	private initializeHorseRecords(): void {
		try{
			const raw = this.fetchRecords(this.deps.horseRecordsPath, 'horse');
			const [mergedRecords, failures] = this.mergeRecords(raw, 'horse');

			if(failures.length > 0){
				console.error(`Load Horse Records found ${failures.length} field failure(s) across all records, writing repair file`);
				createJsonFile(getRepairPath(this.deps.horseRecordsPath), failures);
			}

			this.horseRecords = mergedRecords;
			this.horseQueue.chain();
		}
		catch(error: unknown){
			handleError(error, 'Horse Records Load (Startup)');
			const defaultRecords = this.createHorseRecords();
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
					defaultRecords = this.createFishRecords();
					break;
				}
				case 'horse':{
					defaultRecords = this.createHorseRecords();
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

	private createFishRecords(): PrivateFishRecordList {
		return defaultFishCatalog.map((catalogEntry) => ({
			...catalogEntry,
			...this.createDefaultFishRecordEntry()
		}));
	}

	private createHorseRecords(): PrivateHorseRecordList {
		return defaultHorseCatalog.map((catalogEntry) => ({
			...catalogEntry,
			...this.createDefaultHorseRecordEntry()
		}));
	}

	private mergeRecords(input: unknown, label: 'fish'): [PrivateFishRecordList, KeyedParseFailureRecord[]];
	private mergeRecords(input: unknown, label: 'horse'): [PrivateHorseRecordList, KeyedParseFailureRecord[]];
	private mergeRecords(input: unknown, label: 'fish' | 'horse'): [PrivateFishRecordList, KeyedParseFailureRecord[]] | [PrivateHorseRecordList, KeyedParseFailureRecord[]]{
		switch(label){
			case 'fish':{
				return this.mergeRecordEntries(input, 'fish', (entry) => mergeRecordDefaults(entry, aType.gfish, this.createDefaultFishRecordEntry(), FishRecordEntrySchema));
			}
			case 'horse':{
				return this.mergeRecordEntries(input, 'horse', (entry) => mergeRecordDefaults(entry, aType.ghorse, this.createDefaultHorseRecordEntry(), HorseRecordEntrySchema));
			}
			default:{
				throw new AppError('mergeRecords called without appropriate label', 'bug');
			}
		}
	}

	private mergeRecordEntries<RecordEntry>(input: unknown, label: string, mergeEntry: (entry: unknown) => [RecordEntry | null, ParseFailureRecord[]]): [RecordEntry[], KeyedParseFailureRecord[]]{
		if(!isUnknownArray(input)){
			throw new AppError(`${label} record file did not contain an array`, 'internal', 'warn');
		}

		const failures: KeyedParseFailureRecord[] = [];
		const mergedRecords: RecordEntry[] = [];

		for(const [index, entry] of input.entries()){
			const [record, mergeFailures] = mergeEntry(entry);

			for(const failure of mergeFailures){
				failures.push({...failure, recordKey: `index ${index}`});
			}
			if(record === null){
				continue;
			}
			mergedRecords.push(record);
		}

		return [mergedRecords, failures];
	}
}
