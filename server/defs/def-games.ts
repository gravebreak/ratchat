import {hType} from './def-events';
import type {GameTextPayload} from './def-events';
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

export type HorseRaceEntry = HorseFieldEntry & {
	weight: number;
	score: number;
}

export type HorseRaceResult = {
	field: HorseFieldEntry[];
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
	horseName: HorseRecordEntry['horseName'];
	postNumber: HorseFieldEntry['horsePost'];
	stake: number;
	oddsNum: number;
	oddsDen: number;
	prerace: boolean;
	callback: HorseBetCallback;
};
export type HorseBetResult = Omit<HorseBet, 'callback'> & {
	place: number;
	payout: number;
};

export type HorseBetCallback = (result: HorseBetResult) => void;

export type CommentaryLine = {
	commentary: string;
	singular: boolean;
	small: boolean;
	big: boolean;
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

export type FishingCallback = 'bite' | 'expired' | 'nothing';
export type FishingEventCallback = (playerid: GameIdentity['playerid'], event: FishingCallback) => void;
