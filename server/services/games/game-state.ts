

import { HorseRecordEntrySchema, FishRecordEntrySchema } from '../../defs/def-record'
import type { GameIdentity } from '../../defs/def-identity'
import type { LeaderboardEntry, BlackjackEntry, DuelingEntry, FishingEntry, HorseEntry } from '../../defs/def-leaderboard';
import type { PublicLeaderboard, PublicOverallLeaderboard, PublicBlackjackLeaderboard, PublicDuelingLeaderboard, PublicFishingLeaderboard, PublicHorseLeaderboard } from '../../defs/def-leaderboard';
import type { PrivateHorseRecordList, PrivateFishRecordList } from '../../defs/def-record';

import { CacheService } from "../cache";
import { DispatchService } from "../dispatch";
import { GameIdentityService } from "./game-identity";
import { IdentityService } from "../identity";
import { StateService } from "../state";

import { handleError, AppError } from "../../utils/errors";
import { parseArray } from '../../utils/parse';
import { createJsonFile, existsFile, readJsonFile } from '../../utils/serialize';

import { defaultFishCatalog } from '../catalogs/catalog-fish';
import { defaultHorseCatalog } from '../catalogs/catalog-horse';

type StageOne = GameIdentity & {fullnick: string };
type StageTwo = StageOne & { fishingTypesCaught: number, fishingRecords: number };
type FullEntry = LeaderboardEntry & BlackjackEntry & DuelingEntry & FishingEntry & HorseEntry;
type FullLeaderboard = FullEntry[];

//const REDIS_BLACKJACK_KEY = 'ratchat:blackjack';

export interface StateServiceDependencies{
	cacheService: CacheService;
	dispatchService: DispatchService;
	stateService: StateService;
	gameIdentityService: GameIdentityService;
	identityService: IdentityService;

	fishingRecordsPath: string; 
	horseRecordsPath: string
}

export class GameStateService {
	private horseRecords: PrivateHorseRecordList = [];
	private fishRecords: PrivateFishRecordList = [];

	private deps: StateServiceDependencies;
	constructor(dependencies: StateServiceDependencies){
		this.deps = dependencies;

		try{
			if(!existsFile(this.deps.fishingRecordsPath)){
				createJsonFile(this.deps.fishingRecordsPath, this.buildFishRecords());
			}

			if(!existsFile(this.deps.horseRecordsPath)){
				createJsonFile(this.deps.horseRecordsPath, this.buildHorseRecords());
			}

			this.loadRecords();
		}
		catch(error: unknown){
			handleError(error, 'Records Load (Startup)');
		}
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
			case 'blackjack':
				return this.buildPublicLeaderboard(fullEntries, 'blackjack');
			case 'dueling':
				return this.buildPublicLeaderboard(fullEntries, 'dueling');
			case 'fishing':
				return this.buildPublicLeaderboard(fullEntries, 'fishing');
			case 'horse':
				return this.buildPublicLeaderboard(fullEntries, 'horse');
			default:
				return this.buildPublicLeaderboard(fullEntries);
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
			case 'blackjack':
				return entries.map((entry) => ({
					fullnick: entry.fullnick,
					blackjackWinnings: entry.blackjackWinnings,
					blackjackBlackjacks: entry.blackjackBlackjacks,
				}));
			case 'dueling':
				return entries.map((entry) => ({
					fullnick: entry.fullnick,
					duelingWins: entry.duelingWins,
					duelingHonor: entry.duelingHonor,
				}));
			case 'fishing':
				return entries.map((entry) => ({
					fullnick: entry.fullnick,
					fishingCatches: entry.fishingCatches,
					fishingTypesCaught: entry.fishingTypesCaught,
					fishingWinnings: entry.fishingWinnings,
					fishingBestCatchValue: entry.fishingBestCatchValue,
					fishingRecords: entry.fishingRecords,
				}));
			case 'horse':
				return entries.map((entry) => ({
					fullnick: entry.fullnick,
					horseWinnings: entry.horseWinnings,
					horseBetWins: entry.horseBetWins,
				}));
			default:
				return entries.map((entry) => ({
					fullnick: entry.fullnick,
					gamePoints: entry.gamePoints,
				}));
		}
	}
	private buildFishRecords(): PrivateFishRecordList {
		return defaultFishCatalog.map((catalogEntry) => ({
			...catalogEntry,
			weight: null,
			playerid: null,
			fullnick: null,
		}));
	}

	private buildHorseRecords(): PrivateHorseRecordList {
		return defaultHorseCatalog.map((catalogEntry) => ({
			...catalogEntry,
			wins: 0,
		}));
	}
	private loadRecords(){
		this.fishRecords = this.loadRecordList(this.deps.fishingRecordsPath, 'fish');
		this.horseRecords = this.loadRecordList(this.deps.horseRecordsPath, 'horse');
	}

	private loadRecordList(path: string, schemalabel: 'fish'): PrivateFishRecordList;
	private loadRecordList(path: string, schemalabel: 'horse'): PrivateHorseRecordList;
	private loadRecordList(path: string, schemalabel: 'fish' | 'horse'): PrivateFishRecordList | PrivateHorseRecordList {
		const raw: unknown = readJsonFile(path);
		if(!Array.isArray(raw)){
			throw new AppError(`${schemalabel} record file did not contain an array`, 'internal', 'warn');
		}

		switch(schemalabel){
			case 'fish':
				return parseArray(raw, FishRecordEntrySchema);
			case 'horse':
				return parseArray(raw, HorseRecordEntrySchema);
			default:
				throw new AppError('LoadRecordList called without label', 'bug');
		}
	}
}