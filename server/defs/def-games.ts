import {hType} from './def-events';
import type {GamePayload, GameTextPayload} from './def-events';
import type {GameIdentity} from './def-identity';
import type {FishRecordEntry, HorseRecordEntry} from './def-record';

export type HorseColor = typeof allowedHorseColors[keyof typeof allowedHorseColors];
export const allowedHorseColors = {
	[hType.blue]: hType.blue,
	[hType.brown]: hType.brown,
	[hType.black]: hType.black,
	[hType.gray]: hType.gray,
	[hType.navy]: hType.navy,
	[hType.green]: hType.green,
	[hType.orange]: hType.orange,
	[hType.pink]: hType.pink,
	[hType.purple]: hType.purple,
	[hType.teal]: hType.teal,
	[hType.red]: hType.red,
	[hType.white]: hType.white,
	[hType.yellow]: hType.yellow
} as const;

export type HorseOdds = {
	oddsNum: number;
	oddsDen: number;
};
export type HorseLabel = {
	horsePost: number;
	horseColor: HorseColor;
	horseName: HorseRecordEntry['horseName'];
};
export type HorseStandings = HorseLabel[];
export type HorseFieldEntry = HorseLabel & HorseOdds;
export type HorseField = HorseFieldEntry[]

export type HorseRaceEntry = HorseFieldEntry & {
	weight: number;
	score: number;
}

export type HorseRaceResult = {
	field: HorseField;
	gates: GameTextPayload;
	checkpoint1: GameTextPayload;
	checkpoint2: GameTextPayload;
	checkpoint3: GameTextPayload;
	finalStretch: GameTextPayload;
	end: GameTextPayload;
	standings: HorseStandings;
};

export type HorseBet = {
	playerid: GameIdentity['playerid'];
} & HorseFieldEntry & {
	stake: number;
	prerace: boolean;
};
export type HorseBetResult = HorseBet & {
	place: number;
	payout: number;
};

export type CommentaryLine = {
	commentary: string;
	singular: boolean;
	small: boolean;
	big: boolean;
};

export type BlackjackCardRank = typeof cardRank[keyof typeof cardRank];
export const cardRank = {
	ace: 'A',
	two: '2',
	three: '3',
	four: '4',
	five: '5',
	six: '6',
	seven: '7',
	eight: '8',
	nine: '9',
	ten: 'T',
	jack: 'J',
	queen: 'Q',
	king: 'K'
} as const;

export type BlackjackCardSuit = typeof cardSuit[keyof typeof cardSuit];
export const cardSuit = {
	spades: '♠',
	diamonds: '♦',
	clubs: '♣',
	hearts: '♥',
} as const;

export type BlackjackCard = {
	rank: BlackjackCardRank;
	suit: BlackjackCardSuit;
};

export type BlackjackShoe = BlackjackCard[];

export type BlackjackValue = {
	cards: BlackjackCard[];
	value: number;
	soft: boolean;
}

export type BlackjackHand = BlackjackValue & {
	blackjack: boolean;
	bust: boolean;
	split: boolean;
};

export type BlackjackBet = {
	hand: BlackjackHand;
	stake: number;
	stood: boolean;
};

export type BlackjackTableSeat = {
	playerid: GameIdentity['playerid'];
	hands: BlackjackBet[];
	active: boolean;
};

export type BlackjackTable = {
	tableid: GamePayload['id'];
	seats: BlackjackTableSeat[];
	dealerCards: BlackjackCard[];
};

export type BlackjackBetResult = BlackjackBet & {
	result: 'win' | 'push' | 'loss' ;
};

export type FishCatch = {
	name: FishRecordEntry['fishName'];
	flavor: FishRecordEntry['fishFlavor'];
	color: FishRecordEntry['fishColor'];
	weight: number;
	value: number;
};

export type FishResult = FishCatch & {
	record: boolean;
	pb: boolean;
	newcatch: boolean;
	big: boolean;
	small: boolean;
};

export type FishingResult = 'bite' | 'expired' | 'nothing';
