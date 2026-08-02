import {v4 as uuidv4} from 'uuid';

import {RatServer, fType, gType, hType, dType, rType} from '../../defs/def-events';
import {aType} from '../../defs/def-parse';
import {HorseRecordEntrySchema, FishRecordEntrySchema} from '../../defs/def-record';
import type {GameLine, GamePayload, GameTextPayload} from '../../defs/def-events';
import type {FishCatch, FishResult, HorseBet, HorseRaceResult, HorseField, HorseBetResult} from '../../defs/def-games';
import type {GameIdentity} from '../../defs/def-identity';
import type {LeaderboardEntry, BlackjackEntry, DuelingEntry, FishingEntry, HorseEntry} from '../../defs/def-leaderboard';
import type {PublicLeaderboard, PublicOverallLeaderboard, PublicBlackjackLeaderboard, PublicDuelingLeaderboard, PublicFishingLeaderboard, PublicHorseLeaderboard} from '../../defs/def-leaderboard';
import type {KeyedParseFailureRecord, ParseFailureRecord} from '../../defs/def-parse';
import type {PrivateHorseRecordList, PrivateFishRecordList, DefaultFishRecordEntry, DefaultHorseRecordEntry, HorseRecordEntry} from '../../defs/def-record';

import {ConfigService} from '../config';
import {CacheService} from '../cache';
import {DispatchService} from '../dispatch';
import {GameIdentityService} from './game-identity';
import {IdentityService} from '../identity';
import {GameSettlementService} from './game-settlement';

import {handleError, AppError} from '../../utils/errors';

import {mergeRecordDefaults, isUnknownArray} from '../../utils/parse';
import {createSaveQueue} from '../../utils/queue';
import {createRandomInt} from '../../utils/random';
import {assertSafeStartup, getRepairPath} from '../../utils/repair';
import {createJsonFile, existsFile, readJsonFile, writeJsonFile} from '../../utils/serialize';

import {assertFishingEnabled, assertGamesEnabled, assertHorseRacingEnabled} from './game-utils/checks';
import {createHorseAnnouncementCommentary, createHorseReminderCommentary} from './game-utils/commentary';
import {createCatch} from './game-utils/fishing';
import {createHorseRaceResult, createHorseBetResult} from './game-utils/horse';

import {defaultFishCatalog} from '../catalogs/catalog-fish';
import {defaultHorseCatalog} from '../catalogs/catalog-horse';

type StageOne = GameIdentity & {fullnick: string};
type StageTwo = StageOne & {fishingTypesCaught: number, fishingRecords: number};
type FullEntry = LeaderboardEntry & BlackjackEntry & DuelingEntry & FishingEntry & HorseEntry;
type FullLeaderboard = FullEntry[];

type FishingSession = {
	playerid: GameIdentity['playerid'];
	fish: FishCatch | null;
	biting: boolean;
	timer: NodeJS.Timeout;
};

type HorseSession = {
	racenumber: number;
	id: GamePayload['id'];
	results: HorseRaceResult;
	field: HorseField;
	stage: number;
	betting: boolean;
	bets: HorseBet[];
	timer: NodeJS.Timeout
}

const FISH_MIN_WAIT = 5;
const FISH_MAX_WAIT = 20;
const FISH_MIN_WAIT_TARGET = 10;
const FISH_MAX_WAIT_TARGET = 60;
const FISH_MIN_WAIT_BAD_TARGET = 50;
const FISH_MAX_WAIT_BAD_TARGET = 60;
const FISH_MIN_CATCH_WINDOW = 5;
const FISH_MAX_CATCH_WINDOW = 10;
const FISH_BIG_THRESHOLD = 80;
const FISH_SMALL_THRESHOLD = 5;

const HORSE_PRERACE_DURATION = 120;
const HORSE_BET_REMINDER_AT = 60;
const HORSE_CHECKPOINT_1_WAIT = 30;
const HORSE_CHECKPOINT_2_WAIT = 30;
const HORSE_CHECKPOINT_3_WAIT = 30;
const HORSE_FINAL_STRETCH_WAIT = 20;
const HORSE_MIN_RACEOVER_WAIT = 5;
const HORSE_MAX_RACEOVER_WAIT = 15;
const HORSE_TEXT_DELAY = 500;
const HORSE_TEXT_END_DELAY = 250;

export interface GameStateServiceDependencies{
	cacheService: CacheService;
	configService: ConfigService
	dispatchService: DispatchService;
	gameIdentityService: GameIdentityService;
	identityService: IdentityService;
	gameSettlementService: GameSettlementService;

	fishingRecordsPath: string;
	horseRecordsPath: string;
	io: RatServer;
}

export class GameStateService {
	private activeFishing: Map<GameIdentity['playerid'], FishingSession> = new Map();
	private activeRace: HorseSession | null = null;
	private raceCounter = 0;

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
		this.startHorseTimer();
		this.createHorseSession().catch((error: unknown) => handleError(error, 'Create Horse Session (Startup/Test)'));
	}

	public existsHorseSession(): boolean {
		assertGamesEnabled(this.deps.configService, 'existsHorseSession');
		assertHorseRacingEnabled(this.deps.configService, 'existsHorseSession');
		if(this.activeRace){
			return true;
		}
		return false;
	}

	public getFieldHorseSession(): HorseField {
		assertGamesEnabled(this.deps.configService, 'getFieldHorseSession');
		assertHorseRacingEnabled(this.deps.configService, 'getFieldHorseSession');
		if(!this.activeRace){
			throw new AppError('get horse field: called without an active session', 'bug');
		}
		return structuredClone(this.activeRace.field);
	}

	public getIdHorseSession(): GamePayload['id']{
		assertGamesEnabled(this.deps.configService, 'getIdHorseSession');
		assertHorseRacingEnabled(this.deps.configService, 'getIdHorseSession');
		if(!this.activeRace){
			throw new AppError('get id horse: called without an active session', 'bug');
		}
		const id = this.activeRace.id;
		return id;
	}

	public pushBetHorseSession(bet: HorseBet): HorseBet {
		assertGamesEnabled(this.deps.configService, 'pushBetHorseSession');
		assertHorseRacingEnabled(this.deps.configService, 'pushBetHorseSession');
		if(!this.activeRace){
			throw new AppError('add bet horse session: called without an active session', 'bug');
		}
		if(!this.activeRace.betting){
			throw new AppError('betting is closed for this race', 'user');
		}

		if(this.activeRace.stage === 0){
			bet.prerace = true;
		}

		this.activeRace.bets.push(bet);
		return bet;
	}

	public getBetsHorseSession(playerid: GameIdentity['playerid']): HorseBet[] {
		assertGamesEnabled(this.deps.configService, 'getBetsHorseSession');
		assertHorseRacingEnabled(this.deps.configService, 'getBetsHorseSession');
		if(!this.activeRace){
			throw new AppError('get bets horse session: called without an active session', 'bug');
		}

		const playerBets: HorseBet[] = [];
		for(const bet of this.activeRace.bets){
			if(bet.playerid !== playerid){
				continue;
			}

			const copy = structuredClone(bet);
			playerBets.push(copy);
		}

		return playerBets;
	}

	private async createHorseSession(): Promise<void> {
		assertGamesEnabled(this.deps.configService, 'createHorseSession');
		assertHorseRacingEnabled(this.deps.configService, 'createHorseSession');
		const results = createHorseRaceResult(this.horseRecords);
		this.raceCounter++;
		const racenumber = this.raceCounter;
		const timer = this.createTimerHorseSession(HORSE_PRERACE_DURATION - 10);

		const session = {
			racenumber: racenumber,
			id: uuidv4(),
			results: results,
			field: results.field,
			stage: 0,
			betting: true,
			bets: [],
			timer: timer
		};
		this.activeRace = session;

		const announcement = createHorseAnnouncementCommentary(session.field, racenumber, HORSE_PRERACE_DURATION);
		this.deps.dispatchService.sendGamePayload(this.deps.io, announcement, gType.horse, session.id, rType.static, dType.replace, HORSE_TEXT_DELAY);
		const reminder = createHorseReminderCommentary(racenumber, HORSE_BET_REMINDER_AT);
		const staticid = `${session.id}reminder`;
		setTimeout(() => {
			this.deps.dispatchService.sendGamePayload(this.deps.io, reminder, gType.horse, staticid, rType.dynamic, dType.replace);
		}, HORSE_BET_REMINDER_AT * 1000);
	}

	private createTimerHorseSession(seconds: number): NodeJS.Timeout {
		const timer = setTimeout(() => {
			this.handleHorseSession();
		}, seconds * 1000);
		return timer;
	}

	private handleHorseSession(): void {
		const session = this.activeRace;
		try{
			if(!session){
				throw new AppError('handleHorseSession called with no active session', 'bug');
			}
			switch(session.stage){
				case 0: {
					const tenSecondWarning: GameLine = [{text: 'the race begins in 10 seconds!', color: hType.normal, format: []}];
					this.deps.dispatchService.sendGamePayload(this.deps.io, [tenSecondWarning], gType.horse, session.id, rType.static, dType.append);
					const timer = this.createTimerHorseSession(10);
					session.timer = timer;
					session.stage++;
					return;
				}
				case 1: {
					this.deps.dispatchService.sendGamePayload(this.deps.io, session.results.gates, gType.horse, session.id, rType.static, dType.append, HORSE_TEXT_DELAY);
					const timer = this.createTimerHorseSession(HORSE_CHECKPOINT_1_WAIT);
					session.timer = timer;
					session.stage++;
					return;
				}
				case 2: {
					this.deps.dispatchService.sendGamePayload(this.deps.io, session.results.checkpoint1, gType.horse, session.id, rType.static, dType.append, HORSE_TEXT_DELAY);
					const timer = this.createTimerHorseSession(HORSE_CHECKPOINT_2_WAIT);
					session.timer = timer;
					session.stage++;
					return;
				}
				case 3: {
					this.deps.dispatchService.sendGamePayload(this.deps.io, session.results.checkpoint2, gType.horse, session.id, rType.static, dType.append, HORSE_TEXT_DELAY);
					const timer = this.createTimerHorseSession(HORSE_CHECKPOINT_3_WAIT);
					session.timer = timer;
					session.stage++;
					return;
				}
				case 4: {
					this.deps.dispatchService.sendGamePayload(this.deps.io, session.results.checkpoint3, gType.horse, session.id, rType.static, dType.append, HORSE_TEXT_DELAY);
					const betsClosed: GameTextPayload= [[{text: 'bets are closed!', color: hType.normal, format: [fType.i]}]];
					const closedId = `${session.id}closed`;
					this.deps.dispatchService.sendGamePayload(this.deps.io, betsClosed, gType.horse, closedId, rType.dynamic, dType.replace);
					session.betting = false;
					const timer = this.createTimerHorseSession(HORSE_FINAL_STRETCH_WAIT);
					session.timer = timer;
					session.stage++;
					return;
				}
				case 5: {
					this.deps.dispatchService.sendGamePayload(this.deps.io, session.results.finalStretch, gType.horse, session.id, rType.static, dType.append, HORSE_TEXT_DELAY);
					const raceOverWait = createRandomInt(HORSE_MIN_RACEOVER_WAIT, HORSE_MAX_RACEOVER_WAIT);
					const timer = this.createTimerHorseSession(raceOverWait);
					session.timer = timer;
					session.stage++;
					return;
				}
				case 6: {
					this.deps.dispatchService.sendGamePayload(this.deps.io, session.results.end, gType.horse, session.id, rType.static, dType.append, HORSE_TEXT_END_DELAY);
					const betsWait = ((session.results.end.length * HORSE_TEXT_END_DELAY) + HORSE_TEXT_DELAY) / 1000;
					const timer = this.createTimerHorseSession(betsWait);
					session.timer = timer;
					session.stage++;
					return;
				}
				case 7: {
					const resolvingBets = [...session.bets];
					const betsGrouped = new Map<GameIdentity['playerid'], HorseBet[]>();

					for(const bet of resolvingBets){
						const existing = betsGrouped.get(bet.playerid);
						if(existing){
							existing.push(bet);
						}
						else{
							betsGrouped.set(bet.playerid, [bet]);
						}
					}

					for(const playerbets of betsGrouped.values()){
						const results: HorseBetResult[] = [];
						for(const bet of playerbets){
							results.push(createHorseBetResult(bet, session.results.standings));
						}
						this.deps.gameSettlementService.settleHorseBet(playerbets[0].playerid, results, session.id);

						for(const bet of playerbets){
							const betIndex = session.bets.indexOf(bet);
							session.bets.splice(betIndex, 1);
						}
					}

					try{
						this.incrementHorseRecord(session.results.standings[0].horseName, 'first');
						this.incrementHorseRecord(session.results.standings[1].horseName, 'second');
						this.incrementHorseRecord(session.results.standings[2].horseName, 'third');
					}
					catch(error: unknown){
						handleError(error);
					}

					this.activeRace = null;
				}
			}
		}
		catch(error: unknown){
			handleError(error, 'Handle Horse Session');
			const line: GameLine = [{text: 'the race has been cancelled due to an unexpected error.', color: hType.normal, format: []}];
			this.deps.dispatchService.sendGamePayload(this.deps.io, [line], gType.info, null, rType.direct, dType.direct);

			let refundCount = 0;
			if(session){
				for(const bet of session.bets){
					try{
						this.deps.gameIdentityService.addGamePoints(bet.playerid, bet.stake);
						refundCount++;
					}
					catch(error: unknown){
						handleError(error, 'Refund Horse Bet (Race Cancelled)');
					}
				}

				if(refundCount > 0){
					try{
						const refundLine: GameLine = [{text: `${refundCount} bets have been successfully returned.`, color: hType.normal, format: []}];
						this.deps.dispatchService.sendGamePayload(this.deps.io, [refundLine], gType.info, null, rType.direct, dType.direct);
					}
					catch(error: unknown){
						handleError(error, 'Announce Refund Count');
					}
				}

				this.activeRace = null;
			}
		}
	}

	public existsFishingSession(playerid: GameIdentity['playerid']): boolean {
		assertGamesEnabled(this.deps.configService, 'existsFishingSession');
		assertFishingEnabled(this.deps.configService, 'existsFishingSession');

		const session = this.activeFishing.get(playerid);
		if(session){
			return true;
		}
		return false;
	}

	public createFishingSession(playerid: GameIdentity['playerid'], target: string | null): void {
		assertGamesEnabled(this.deps.configService, 'createFishingSession');
		assertFishingEnabled(this.deps.configService, 'createFishingSession');

		const fishCatch = createCatch(target, this.fishRecords);

		let castDuration: number;
		if(!fishCatch){
			castDuration = createRandomInt(FISH_MIN_WAIT_BAD_TARGET, FISH_MAX_WAIT_BAD_TARGET);
		}
		else if(target){
			castDuration = createRandomInt(FISH_MIN_WAIT_TARGET, FISH_MAX_WAIT_TARGET);
		}
		else{
			castDuration = createRandomInt(FISH_MIN_WAIT, FISH_MAX_WAIT);
		}

		const timer = this.createTimerFishingSession(playerid, castDuration);

		const session: FishingSession = {
			playerid: playerid,
			fish: fishCatch,
			biting: false,
			timer: timer
		};

		this.activeFishing.set(playerid, session);
	}

	public consumeFishingSession(playerid: GameIdentity['playerid']): FishResult | null {
		assertGamesEnabled(this.deps.configService, 'consumeFishingSession');
		assertFishingEnabled(this.deps.configService, 'consumeFishingSession');
		const session = this.activeFishing.get(playerid);

		if(!session){
			throw new AppError("you don't have a line in the water", 'user');
		}

		if(!session.biting || !session.fish){
			clearTimeout(session.timer);
			this.activeFishing.delete(playerid);
			return null;
		}
		clearTimeout(session.timer);
		const fishCatch = session.fish;
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
			this.deps.gameIdentityService.pushFishingFishCaught(gameUser.playerid, fishCatch.name);
		}

		const big = fishCatch.value > FISH_BIG_THRESHOLD;
		const small = fishCatch.value < FISH_SMALL_THRESHOLD;

		const fishResult = {
			name: fishCatch.name,
			flavor: fishCatch.flavor,
			color: fishCatch.color,
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

	private createTimerFishingSession(playerid: GameIdentity['playerid'], seconds: number): NodeJS.Timeout{
		const timer = setTimeout(() => {
			this.handleFishingSession(playerid);
		}, seconds * 1000);
		return timer;
	}

	private handleFishingSession(playerid: GameIdentity['playerid']): void {
		const session = this.activeFishing.get(playerid);
		if(!session){
			return;
		}
		if(!session.fish){
			this.activeFishing.delete(playerid);
			this.deps.gameSettlementService.settleFishingCatch(playerid, 'nothing');
			return;
		}

		if(!session.biting){
			session.biting = true;
			this.deps.gameSettlementService.settleFishingCatch(playerid, 'bite');

			const catchWindow = FISH_MAX_CATCH_WINDOW - ((session.fish.value / 100) * (FISH_MAX_CATCH_WINDOW - FISH_MIN_CATCH_WINDOW));
			const timer = this.createTimerFishingSession(playerid, catchWindow);

			session.timer = timer;
		}
		else{
			this.activeFishing.delete(playerid);
			this.deps.gameSettlementService.settleFishingCatch(playerid, 'expired');
		}
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

	public reconcileRecords(): void {
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

	private incrementHorseRecord(horseName: HorseRecordEntry['horseName'], place: keyof HorseRecordEntry['finishes']): void {
		const record = this.horseRecords.find(entry => entry.horseName === horseName);
		if(!record){
			throw new AppError('no matching horse record found to increment', 'bug');
		}

		record.finishes[place]++;
		this.horseQueue.chain();
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

	private startHorseTimer(): void {
		const config = this.deps.configService.getGameConfig();
		if(config.horseRacing){
			setInterval(() =>{
				if(!this.existsHorseSession()){
					try{
						this.createHorseSession();
					}
					catch(error: unknown){
						handleError(error);
					}
				}
			}, config.raceFrequency * 1000);
		}
	}
}
