import {RatServer, fType, gType, hType} from '../../defs/def-events';
import {aType} from '../../defs/def-parse';
import {HorseRecordEntrySchema, FishRecordEntrySchema} from '../../defs/def-record';
import type {GameLine, GameTextPayload} from '../../defs/def-events';
import type {FishCatch, FishingEventCallback, FishResult, HorseFieldEntry, HorseBet, HorseRaceResult} from '../../defs/def-games';
import type {GameIdentity} from '../../defs/def-identity';
import type {LeaderboardEntry, BlackjackEntry, DuelingEntry, FishingEntry, HorseEntry} from '../../defs/def-leaderboard';
import type {PublicLeaderboard, PublicOverallLeaderboard, PublicBlackjackLeaderboard, PublicDuelingLeaderboard, PublicFishingLeaderboard, PublicHorseLeaderboard} from '../../defs/def-leaderboard';
import type {KeyedParseFailureRecord, ParseFailureRecord} from '../../defs/def-parse';
import type {PrivateHorseRecordList, PrivateFishRecordList, DefaultFishRecordEntry, DefaultHorseRecordEntry} from '../../defs/def-record';

import {ConfigService} from '../config';
import {CacheService} from '../cache';
import {DispatchService} from '../dispatch';
import {GameIdentityService} from './game-identity';
import {IdentityService} from '../identity';

import {handleError, AppError} from '../../utils/errors';
import {getOrdinalSuffix} from '../../utils/format';
import {mergeRecordDefaults, isUnknownArray} from '../../utils/parse';
import {createSaveQueue, wait} from '../../utils/queue';
import {randomInt} from '../../utils/random';
import {assertSafeStartup, getRepairPath} from '../../utils/repair';
import {createJsonFile, existsFile, readJsonFile, writeJsonFile} from '../../utils/serialize';

import {createCatch} from './game-utils/fishing';
import {createHorseRaceResult, createHorseBetResult} from './game-utils/horse';
import {assertFishingEnabled, assertGamesEnabled, assertHorseRacingEnabled} from './game-utils/checks';

import {defaultFishCatalog} from '../catalogs/catalog-fish';
import {defaultHorseCatalog} from '../catalogs/catalog-horse';

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

type HorseSession = {
	raceid: number;
	results: HorseRaceResult;
	field: HorseFieldEntry[];
	phase: number;
	betting: boolean;
	bets: HorseBet[];
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
const HORSE_TEXT_DELAY = 250;

export interface GameStateServiceDependencies{
	cacheService: CacheService;
	configService: ConfigService
	dispatchService: DispatchService;
	gameIdentityService: GameIdentityService;
	identityService: IdentityService;

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

	private async createHorseSession(): Promise<void>{
		assertGamesEnabled(this.deps.configService, 'createHorseSession');
		assertHorseRacingEnabled(this.deps.configService, 'createHorseSession');
		let session: HorseSession | null = null;
		try{
			const blankLine: GameLine = [{text: '', color: hType.clear, format: []}];

			const raceResult = createHorseRaceResult(this.horseRecords);
			this.raceCounter++;
			const raceid = this.raceCounter;

			session = {
				raceid: raceid,
				results: raceResult,
				field: raceResult.field,
				phase: 0,
				betting: true,
				bets: []
			};
			this.activeRace = session;

			const announcement = this.createHorseSessionAnnouncement(raceResult.field, raceid);
			this.deps.dispatchService.sendGamePayload(this.deps.io, announcement, gType.horse, HORSE_TEXT_DELAY);

			setTimeout(() => {
				const reminder: GameTextPayload = [
					blankLine,
					[
						{text: 'the ', color: hType.normal, format: []},
						{text: `${raceid}${getOrdinalSuffix(raceid)} `, color: hType.normal, format: [fType.b]},
						{text: 'semi annual race starts in ', color: hType.normal, format: []},
						{text: `${HORSE_BET_REMINDER_AT / 60} `, color: hType.normal, format: []},
						{text: 'minute!', color: hType.normal, format: []}
					],
					[{text: 'make sure to get your bets in for a 2x multiplier on your payout!', color: hType.normal, format: []}],
					blankLine
				];
				this.deps.dispatchService.sendGamePayload(this.deps.io, reminder, gType.horse, HORSE_TEXT_DELAY);
			}, HORSE_BET_REMINDER_AT * 1000);

			await wait((HORSE_PRERACE_DURATION -10)* 1000);
			const tenSecondWarning: GameLine = [{text: 'the race begins in 10 seconds!', color: hType.normal, format: []}];
			this.deps.dispatchService.sendGamePayload(this.deps.io, [tenSecondWarning], gType.horse);

			await wait(10 * 1000);
			session.phase = 1;
			this.deps.dispatchService.sendGamePayload(this.deps.io, raceResult.gates, gType.horse, HORSE_TEXT_DELAY);

			await wait(HORSE_CHECKPOINT_1_WAIT * 1000);
			session.phase = 2;
			this.deps.dispatchService.sendGamePayload(this.deps.io, raceResult.checkpoint1, gType.horse, HORSE_TEXT_DELAY);

			await wait(HORSE_CHECKPOINT_2_WAIT * 1000);
			session.phase = 3;
			this.deps.dispatchService.sendGamePayload(this.deps.io, raceResult.checkpoint2, gType.horse, HORSE_TEXT_DELAY);

			await wait(HORSE_CHECKPOINT_3_WAIT * 1000);
			session.phase = 4;
			session.betting = false;
			const betsClosed: GameTextPayload= [
				blankLine,
				[{text: 'bets are closed!', color: hType.normal, format: [fType.i]}],
				blankLine
			];
			this.deps.dispatchService.sendGamePayload(this.deps.io, betsClosed, gType.horse);
			this.deps.dispatchService.sendGamePayload(this.deps.io, raceResult.checkpoint3, gType.horse, HORSE_TEXT_DELAY);

			await wait(HORSE_FINAL_STRETCH_WAIT * 1000);
			session.phase = 5;
			this.deps.dispatchService.sendGamePayload(this.deps.io, raceResult.finalStretch, gType.horse, HORSE_TEXT_DELAY);

			const raceOverWait = randomInt(HORSE_MIN_RACEOVER_WAIT, HORSE_MAX_RACEOVER_WAIT);
			await wait(raceOverWait * 1000);
			session.phase = 6;
			this.deps.dispatchService.sendGamePayload(this.deps.io, raceResult.end, gType.horse, 100);

			const resolvingBets = [...session.bets];
			for(const bet of resolvingBets){
				const result = createHorseBetResult(bet, raceResult.standings);
				bet.callback(result);

				const betIndex = session.bets.indexOf(bet);
				session.bets.splice(betIndex, 1);
			}

			try{
				this.incrementHorseRecord(raceResult.standings[0].horseName, 0);
				this.incrementHorseRecord(raceResult.standings[1].horseName, 1);
				this.incrementHorseRecord(raceResult.standings[2].horseName, 2);
			}
			catch(error: unknown){
				handleError(error);
			}

			this.activeRace = null;
		}
		catch(error: unknown){
			handleError(error, 'Create Horse Session');
			const line: GameLine = [{text: 'the race has been cancelled due to an unexpected error.', color: hType.normal, format: []}];
			this.deps.dispatchService.sendGamePayload(this.deps.io, [line], gType.horse);

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
					const refundLine: GameLine = [{text: `${refundCount} bets have been successfully returned.`, color: hType.normal, format: []}];
					this.deps.dispatchService.sendGamePayload(this.deps.io, [refundLine], gType.horse);
				}
			}
			this.activeRace = null;
		}
	}

	private createHorseSessionAnnouncement(field: HorseFieldEntry[], raceid: number): GameTextPayload {
		const blankLine: GameLine = [{text: '', color: hType.clear, format: []}];

		const commentary: GameTextPayload = [];
		const welcome: GameLine =[
			{text: 'the ', color: hType.normal, format: []},
			{text: `${raceid}${getOrdinalSuffix(raceid)} `, color: hType.normal, format: [fType.b]},
			{text: 'semi-annual horse race begins in ', color: hType.normal, format: []},
			{text: `${HORSE_PRERACE_DURATION/60} `, color: hType.normal, format: []},
			{text: 'minutes!', color: hType.normal, format: []},
		];
		commentary.push(welcome);

		commentary.push(blankLine);
		const oddsIntro: GameLine = [{text: 'the betting line is as follows:', color: hType.normal, format: []}];
		commentary.push(oddsIntro);

		const sortedField = [...field].sort((a, b) => {
			const probA = a.oddsDen / (a.oddsNum + a.oddsDen);
			const probB = b.oddsDen / (b.oddsNum + b.oddsDen);
			return probB - probA;
		});

		for(let index = 0; index < sortedField.length; index++){
			const horse = sortedField[index];
			const line: GameLine = [
				{text: '[', color: hType.normal, format: []},
				{text: `No.${String(horse.horsePost).padStart(2, '0')}`, color: horse.horseColor, format: [fType.b, fType.mono]},
				{text: '][', color: hType.normal, format: []},
				{text: horse.horseName, color: horse.horseColor, format: []},
				{text: '] at ', color: hType.normal, format: []},
				{text: `${horse.oddsNum} : ${horse.oddsDen}`, color: hType.normal, format: []},
			];

			if(index === 0){
				line.push({text: ', the favorite!', color: hType.normal, format: []});
			}
			else if(index === sortedField.length - 1){
				line.push({text: ', the longshot!', color: hType.normal, format: []});
			}

			commentary.push(line);
		}
		commentary.push(blankLine);

		const outro1: GameLine = [{text: 'what a beautiful day for a horse race!', color: hType.normal, format: []}];
		const outro2: GameLine = [{text: 'get your bets in now for a 2x multiplier on your payout!', color: hType.normal, format: []}];
		const outro3: GameLine = [
			{text: 'reminder, the race starts in ', color: hType.normal, format: []},
			{text: `${HORSE_PRERACE_DURATION/60} `, color: hType.normal, format: []},
			{text: 'minutes! see you there!', color: hType.normal, format: []}
		];
		commentary.push(outro1,outro2,outro3);

		commentary.push(blankLine);
		return commentary;
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

	public createFishingSession(playerid: GameIdentity['playerid'], target: string | null, callback: FishingEventCallback): void {
		assertGamesEnabled(this.deps.configService, 'createFishingSession');
		assertFishingEnabled(this.deps.configService, 'createFishingSession');

		const fishCatch = createCatch(target, this.fishRecords);

		let castDuration: number;
		if(!fishCatch){
			castDuration = randomInt(FISH_MIN_WAIT_BAD_TARGET, FISH_MAX_WAIT_BAD_TARGET);
		}
		else if(target){
			castDuration = randomInt(FISH_MIN_WAIT_TARGET, FISH_MAX_WAIT_TARGET);
		}
		else{
			castDuration = randomInt(FISH_MIN_WAIT, FISH_MAX_WAIT);
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
		assertGamesEnabled(this.deps.configService, 'catchFishingSession');
		assertFishingEnabled(this.deps.configService, 'catchFishingSession');
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
			this.deps.gameIdentityService.addFishingFishCaught(gameUser.playerid, fishCatch.name);
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

	private advanceFishingSession(playerid: GameIdentity['playerid']): void {
		const session = this.activeFishing.get(playerid);
		if(!session){
			return;
		}
		if(!session.fish){
			this.activeFishing.delete(playerid);
			session.eventCallback(playerid, 'nothing');
			return;
		}

		session.biting = true;
		session.eventCallback(playerid, 'bite');

		const catchWindow = FISH_MAX_CATCH_WINDOW - ((session.fish.value / 100) * (FISH_MAX_CATCH_WINDOW - FISH_MIN_CATCH_WINDOW));

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
		session.eventCallback(playerid, 'expired');
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
			fullnick: null,
			fishColor: hType.navy
		};
	}

	private buildDefaultHorseRecordEntry(): DefaultHorseRecordEntry{
		return{
			results: [0, 0, 0]
		};
	}

	private incrementHorseRecord(horseName: string, place: number): void {
		const record = this.horseRecords.find(entry => entry.horseName === horseName);
		if(!record){
			throw new AppError('no matching horse record found to increment', 'bug');
		}

		record.results[place]++;
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
				failures.push({...failure, recordKey: `index ${index}`});
			}
			if(record === null){
				continue;
			}
			resolvedRecords.push(record);
		}

		return [resolvedRecords, failures];
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
