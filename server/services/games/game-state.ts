import {v4 as uuidv4} from 'uuid';

import {RatServer, fType, gType, hType, dType, rType} from '../../defs/def-events';
import type {GameLine, GamePayload, GameTextPayload} from '../../defs/def-events';
import type {FishCatch, FishResult, HorseBet, HorseRaceResult, HorseField, HorseBetResult} from '../../defs/def-games';
import type {BlackjackShoe, BlackjackTableSeat, BlackjackTable, BlackjackCard, BlackjackBet} from '../../defs/def-games';
import type {GameIdentity} from '../../defs/def-identity';

import {ConfigService} from '../config';
import {CacheService} from '../cache';
import {DispatchService} from '../dispatch';
import {GameIdentityService} from './game-identity';
import {IdentityService} from '../identity';
import {GameSettlementService} from './game-settlement';
import {GameRecordService} from './game-record';

import {handleError, AppError} from '../../utils/errors';

import {createRandomInt} from '../../utils/random';
import {createHorseAnnouncementCommentary, createHorseReminderCommentary} from './game-utils/commentary';
import {assertFishingEnabled, assertGamesEnabled, assertHorseRacingEnabled, assertBlackjackEnabled} from './game-utils/checks';
import {createHorseRaceResult, createHorseBetResult} from './game-utils/horse';
import {createBlackjackShoe} from './game-utils/blackjack';
import {createCatch} from './game-utils/fishing';

type Live<SessionType> = SessionType & {timer: NodeJS.Timeout};

type HorseSession = {
	racenumber: number;
	id: GamePayload['id'];
	results: HorseRaceResult;
	field: HorseField;
	stage: number;
	betting: boolean;
	bets: HorseBet[];
}
type LiveHorseSession = Live<HorseSession>;

type BlackjackSession = BlackjackTable &{
	shoe: BlackjackShoe;
	betting: boolean;
	private: boolean;
	seatTurn: number | null;
	handTurn: number | null;
};
type LiveBlackjackSession = Live<BlackjackSession>;

type FishingSession = {
	playerid: GameIdentity['playerid'];
	fish: FishCatch | null;
	biting: boolean;
};
type LiveFishingSession = Live<FishingSession>;

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

// const BLACKJACK_PRIVATE_TIMER = 300;
// const BLACKJACK_PUBLIC_BETTING_TIMER = 30;
// const BLACKJACK_PUBLIC_ACTION_TIMER = 5;

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

export interface GameStateServiceDependencies{
	cacheService: CacheService;
	configService: ConfigService
	dispatchService: DispatchService;
	gameIdentityService: GameIdentityService;
	identityService: IdentityService;
	gameRecordService: GameRecordService;
	gameSettlementService: GameSettlementService;

	fishingRecordsPath: string;
	horseRecordsPath: string;
	io: RatServer;
}

export class GameStateService {
	private activeRace: LiveHorseSession | null = null;
	//private activePublicTables: Map<LiveBlackjackSession['tableid'], LiveBlackjackSession> = new Map();
	//private activePrivateTables: Map<GameIdentity['playerid'], LiveBlackjackSession> = new Map();
	private activeFishing: Map<GameIdentity['playerid'], LiveFishingSession> = new Map();
	private raceCounter = 0;

	private deps: GameStateServiceDependencies;
	constructor(dependencies: GameStateServiceDependencies){
		this.deps = dependencies;
		this.init();
	}

	private init(): void {
		this.startHorseTimer();
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

		const stored = structuredClone(bet);

		if(this.activeRace.stage === 0){
			stored.prerace = true;
		}

		this.activeRace.bets.push(stored);
		return structuredClone(stored);
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

	private createHorseSession(): HorseSession {
		assertGamesEnabled(this.deps.configService, 'createHorseSession');
		assertHorseRacingEnabled(this.deps.configService, 'createHorseSession');
		const records = this.deps.gameRecordService.getHorseRecords();
		const results = createHorseRaceResult(records);
		this.raceCounter++;
		const racenumber = this.raceCounter;

		const session: HorseSession = {
			racenumber: racenumber,
			id: uuidv4(),
			results: results,
			field: results.field,
			stage: 0,
			betting: true,
			bets: [],
		};

		const timer: NodeJS.Timeout = this.createTimerHorseSession(HORSE_PRERACE_DURATION - 10);
		const live: LiveHorseSession = {...session, timer: timer};
		this.activeRace = live;
		return structuredClone(session);
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
						this.deps.gameRecordService.incrementHorseRecord(session.results.standings[0].horseName, 'first');
						this.deps.gameRecordService.incrementHorseRecord(session.results.standings[1].horseName, 'second');
						this.deps.gameRecordService.incrementHorseRecord(session.results.standings[2].horseName, 'third');
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

	// public createTableBlackjackSession(playerid: GameIdentity['playerid'], privatetable: boolean): BlackjackTable {
	// 	assertGamesEnabled(this.deps.configService, 'createTableBlackjackSession');
	// 	assertBlackjackEnabled(this.deps.configService, 'createTableBlackjackSession');
	// 	if(privatetable){
	// 		if(this.activePrivateTables.has(playerid)){
	// 			throw new AppError("you're already at a table, try playing", 'user');
	// 		}
	// 		else{
	// 			const shoe: BlackjackShoe = createBlackjackShoe();
	// 			const table: BlackjackTable = this.createNewTableBlackjackSession(playerid);
	// 			const session: BlackjackSession = {
	// 				...table,
	// 				shoe: shoe,
	// 				betting: true,
	// 				private: true,
	// 				seatTurn: null,
	// 				handTurn: null,
	// 			};
	// 			const timer: NodeJS.Timeout = this.createPrivateTimerBlackjackSession(playerid);
	// 			const live: LiveBlackjackSession = {...session, timer: timer};
	// 			this.activePrivateTables.set(playerid, live);

	// 			return structuredClone(table);
	// 		}
	// 	}
	// 	if(this.activePublicTables.size > 0){
	// 		let leastPlayers = 7;
	// 		let target: BlackjackSession | null = null;
	// 		for(const session of this.activePublicTables.values()){
	// 			for(const seat of session.seats){
	// 				if(seat.playerid === playerid){
	// 					throw new AppError("you're already at a table, try playing", 'user');
	// 				}
	// 			}
	// 			if(session.seats.length < 6 && session.seats.length < leastPlayers){
	// 				leastPlayers = session.seats.length;
	// 				target = session;
	// 			}
	// 		}
	// 		if(target){
	// 			const seat: BlackjackTableSeat = {
	// 				playerid: playerid,
	// 				hands: [],
	// 				active: true
	// 			};
	// 			target.seats.push(seat);
	// 			return target;
	// 		}
	// 	}

	// 	const shoe: BlackjackShoe = createBlackjackShoe();
	// 	const table: BlackjackTable = this.createNewTableBlackjackSession(playerid);
	// 	const timer: NodeJS.Timeout = this.createPublicTimerBlackjackSession(table.tableid, BLACKJACK_PUBLIC_BETTING_TIMER);
	// 	const session: BlackjackSession = {
	// 		...table,
	// 		shoe: shoe,
	// 		betting: true,
	// 		private: false,
	// 		seatTurn: null,
	// 		handTurn: null,
	// 		timer: timer
	// 	};
	// 	this.activePublicTables.set(session.tableid, session);

	// 	return table;
	// }

	// private createNewTableBlackjackSession(playerid:GameIdentity['playerid']): BlackjackTable {
	// 	const seat: BlackjackTableSeat = {
	// 		playerid: playerid,
	// 		hands: [],
	// 		active: true,
	// 	};
	// 	const table: BlackjackTable = {
	// 		tableid: uuidv4(),
	// 		seats: [seat],
	// 		dealerCards: []
	// 	};
	// 	return table;
	// }

	// private consumeCardBlackjackSession(shoe: BlackjackShoe): BlackjackCard {
	// 	const card = shoe.pop();
	// 	if(card){
	// 		return card;
	// 	}
	// 	throw new AppError('consumeCardBlackJack called with empty shoe', 'bug');
	// }

	// private createPrivateTimerBlackjackSession(playerid: GameIdentity['playerid']): NodeJS.Timeout {
	// 	const timer = setTimeout(() => {
	// 		this.handlePrivateBlackjackSession(playerid);
	// 	}, BLACKJACK_PRIVATE_TIMER * 1000);
	// 	return timer;
	// }

	// private createPublicTimerBlackjackSession(tableid: BlackjackSession['tableid'], seconds: number): NodeJS.Timeout {
	// 	const timer = setTimeout(() => {
	// 		this.handlePublicBlackjackSession(tableid);
	// 	}, seconds * 1000);
	// 	return timer;
	// }

	// private handlePrivateBlackjackSession(playerid: GameIdentity['playerid']): void {
	// 	const session = this.activePrivateTables.get(playerid);
	// 	if(!session){
	// 		const error = new AppError('session missing handlePrivateBlackjackSession', 'bug');
	// 		handleError(error);
	// 		return;
	// 	}

	// 	if(session.betting){
	// 		const player = session.seats[0].playerid;
	// 		if(!session.seats[0].active){
	// 			this.deleteTableBlackjackSession(session);
	// 			this.deps.gameSettlementService.settleBlackjackTimeout(player);
	// 		}
	// 		else{
	// 			session.seats[0].active = false;
	// 			this.createPrivateTimerBlackjackSession(session.seats[0].playerid);
	// 		}
	// 	}
	// 	else{
	// 		for(const seat of session.seats){
	// 			for(const hand of seat.hands){
	// 				hand.stood = true;
	// 			}
	// 		}
	// 		this.handleEndRoundBlackjackSession(session);
	// 	}
	// }

	// private handlePublicBlackjackSession(tableid: BlackjackSession['tableid']): void {
	// 	const session = this.activePublicTables.get(tableid);
	// 	if(!session){
	// 		const error = new AppError('session missing handlePublicBlackjackSession', 'bug');
	// 		handleError(error);
	// 		return;
	// 	}
	// 	const seats = [...session.seats];
	// 	if(session.betting){
	// 		for(const seat of seats){
	// 			if(seat.hands.length === 0){
	// 				if(!seat.active){
	// 					this.deps.gameSettlementService.settleBlackjackTimeout(seat.playerid);
	// 					session.seats.splice(seats.indexOf(seat), 1);
	// 				}
	// 				else{
	// 					seat.active = false;
	// 				}
	// 			}
	// 		}

	// 		if(session.seats.length === 0){
	// 			this.deleteTableBlackjackSession(session);
	// 			return;
	// 		}

	// 		session.betting = false;
	// 		session.seatTurn = 0;
	// 		session.handTurn = 0;
	// 		this.deps.gameSettlementService.settleBlackjackTurn(session);
	// 		session.timer = this.createPublicTimerBlackjackSession(session.tableid, BLACKJACK_PUBLIC_ACTION_TIMER);
	// 	}
	// 	else{

	// 	}

	// }

	// private setStoodBlackjackSession(bet: BlackjackBet, status: boolean = true): BlackjackBet {
	// }

	// private deleteTableBlackjackSession(session: BlackjackSession): void {
	// 	if(session.private){
	// 		this.activePrivateTables.delete(session.seats[0].playerid);
	// 	}
	// 	else{
	// 		this.activePublicTables.delete(session.tableid);
	// 	}
	// }

	public existsFishingSession(playerid: GameIdentity['playerid']): boolean {
		assertGamesEnabled(this.deps.configService, 'existsFishingSession');
		assertFishingEnabled(this.deps.configService, 'existsFishingSession');

		const session = this.activeFishing.get(playerid);
		if(session){
			return true;
		}
		return false;
	}

	public createFishingSession(playerid: GameIdentity['playerid'], target: string | null): FishingSession {
		assertGamesEnabled(this.deps.configService, 'createFishingSession');
		assertFishingEnabled(this.deps.configService, 'createFishingSession');

		const records = this.deps.gameRecordService.getFishRecords();
		const fishCatch = createCatch(target, records);

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
		};

		const live = {...session, timer: timer};

		this.activeFishing.set(playerid, live);

		return structuredClone(session);
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
		this.activeFishing.delete(playerid);
		const fishCatch = session.fish;
		const currentRecord = this.deps.gameRecordService.getFishRecord(fishCatch.name);

		let record = false;
		if(!currentRecord.weight || fishCatch.weight > currentRecord.weight){
			record = true;
			currentRecord.weight = fishCatch.weight;
			currentRecord.playerid = playerid;
			currentRecord.fullnick = this.deps.identityService.getFullNickByPlayerId(playerid);
			this.deps.gameRecordService.setFishRecord(currentRecord);
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

	private omitTimer(live: LiveHorseSession): HorseSession;
	private omitTimer(live: LiveBlackjackSession): BlackjackSession;
	private omitTimer(live: LiveFishingSession): FishingSession;
	private omitTimer<LiveType extends {timer: NodeJS.Timeout}>(live: LiveType): Omit<LiveType, 'timer'>{
		const {timer, ...session} = live;
		void timer;
		return structuredClone(session);
	}

	private startHorseTimer(): void {
		const config = this.deps.configService.getGameConfig();
		if(config.horseRacing){
			setInterval(() =>{
				if(!this.existsHorseSession()){
					try{
						const session = this.createHorseSession();
						const announcement = createHorseAnnouncementCommentary(session.field, session.racenumber, HORSE_PRERACE_DURATION);
						this.deps.dispatchService.sendGamePayload(this.deps.io, announcement, gType.horse, session.id, rType.static, dType.replace, HORSE_TEXT_DELAY);

						const reminder = createHorseReminderCommentary(session.racenumber, HORSE_BET_REMINDER_AT);
						const staticid = `${session.id}reminder`;

						setTimeout(() => {
							this.deps.dispatchService.sendGamePayload(this.deps.io, reminder, gType.horse, staticid, rType.dynamic, dType.replace);
						}, HORSE_BET_REMINDER_AT * 1000);
					}
					catch(error: unknown){
						handleError(error);
					}
				}
			}, config.raceFrequency * 1000);
		}
	}
}
