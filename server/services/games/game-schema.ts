import { z } from "zod";
import { GameIdentitySchema, IdentitySchema } from "../../../shared/schema";

const LeaderboardIdentityEntrySchema = z.object({}).extend({
	playerid: GameIdentitySchema.shape.playerid,
	fullnick: IdentitySchema.shape.fullnick,
});
type LeaderboardIdentityEntry = z.infer<typeof LeaderboardIdentityEntrySchema>;


export const LeaderboardEntrySchema = LeaderboardIdentityEntrySchema.extend({
	gamePoints: GameIdentitySchema.shape.gamePoints
});
export type LeaderboardEntry = z.infer<typeof LeaderboardEntrySchema>;
export type PublicLeaderboardEntry = Omit<LeaderboardEntry, 'playerid'>;


export const BlackjackEntrySchema = LeaderboardIdentityEntrySchema.extend({
	blackjackWinnings: GameIdentitySchema.shape.blackjackWinnings, 
	blackjackBlackjacks: GameIdentitySchema.shape.blackjackBlackjacks
});
export type BlackjackEntry = z.infer<typeof BlackjackEntrySchema>;
export type PublicBlackjackEntry = Omit<BlackjackEntry, 'playerid'>;


export const DuelingEntrySchema = LeaderboardIdentityEntrySchema.extend({
	duelingWins: GameIdentitySchema.shape.duelingWins, 
	duelingHonor: GameIdentitySchema.shape.duelingHonor
});
export type DuelingEntry = z.infer<typeof DuelingEntrySchema>;
export type PublicDuelingEntry = Omit<DuelingEntry, 'playerid'>;


export const FishingEntrySchema = LeaderboardIdentityEntrySchema.extend({
	fishingCatches: GameIdentitySchema.shape.fishingCatches,
	fishingTypesCaught: z.number().int().min(0),
	fishingWinnings: GameIdentitySchema.shape.fishingWinnings,
	fishingBestCatchValue: GameIdentitySchema.shape.fishingBestCatchValue,
	fishingRecords: z.number().int().min(0)
});
export type FishingEntry = z.infer<typeof FishingEntrySchema>;
export type PublicFishingEntry = Omit<FishingEntry, 'playerid'>;

export const HorseEntrySchema = LeaderboardIdentityEntrySchema.extend({
	horseWinnings: GameIdentitySchema.shape.horseWinnings,
	horseBetWins: GameIdentitySchema.shape.horseBetWins
});
export type HorseEntry = z.infer<typeof HorseEntrySchema>;
export type PublicHorseEntry = Omit<HorseEntry, 'playerid'>;

export type PrivateOverallLeaderboard = LeaderboardEntry[];
export type PrivateBlackjackLeaderboard = BlackjackEntry[];
export type PrivateDuelingLeaderboard = DuelingEntry[];
export type PrivateFishingLeaderboard = FishingEntry[];
export type PrivateHorseLeaderboard = HorseEntry[];
export type PrivateLeaderboard = PrivateOverallLeaderboard | PrivateBlackjackLeaderboard | PrivateDuelingLeaderboard | PrivateFishingLeaderboard | PrivateHorseLeaderboard;

export type PublicOverallLeaderboard = PublicLeaderboardEntry[];
export type PublicBlackjackLeaderboard = PublicBlackjackEntry[];
export type PublicDuelingLeaderboard = PublicDuelingEntry[];
export type PublicFishingLeaderboard = PublicFishingEntry[];
export type PublicHorseLeaderboard = PublicHorseEntry[];
export type PublicLeaderboard = PublicOverallLeaderboard | PublicBlackjackLeaderboard | PublicDuelingLeaderboard | PublicFishingLeaderboard | PublicHorseLeaderboard;

export type Leaderboard = PrivateLeaderboard | PublicLeaderboard;


export const FishCatalogEntrySchema = z.object({
	fishName: z.string().max(128),
	baseline: z.number().min(0)
});
export const FishRecordEntrySchema = FishCatalogEntrySchema.extend({
	weight: z.number().min(0).nullable(),
	playerid: LeaderboardIdentityEntrySchema.shape.playerid.nullable(),
	fullnick: LeaderboardIdentityEntrySchema.shape.fullnick.nullable(),
});
export type FishCatalogEntry = z.infer<typeof FishCatalogEntrySchema>;
export type FishRecordEntry = z.infer<typeof FishRecordEntrySchema>;
export type PublicFishRecord = Omit<FishRecordEntry, 'playerid'>;


export const HorseCatalogEntrySchema = z.object({
	horseName: z.string().max(128)
});
export const HorseRecordEntrySchema = HorseCatalogEntrySchema.extend({
	wins: z.number().int().min(0)
});
export type HorseCatalogEntry = z.infer<typeof HorseCatalogEntrySchema>;
export type HorseRecordEntry = z.infer<typeof HorseRecordEntrySchema>;
export type PublicHorseRecord = Omit<HorseRecordEntry, never>;


export type PrivateFishRecordList = FishRecordEntry[];
export type PrivateHorseRecordList = HorseRecordEntry[];

export type PublicFishRecordList = PublicFishRecord[];
export type PublicHorseRecordList = PublicHorseRecord[];