import { z } from "zod";

import { GameIdentitySchema, IdentitySchema } from "./def-identity";

export type Leaderboard = PrivateLeaderboard | PublicLeaderboard;

export type PrivateLeaderboard = PrivateOverallLeaderboard | PrivateBlackjackLeaderboard | PrivateDuelingLeaderboard | PrivateFishingLeaderboard | PrivateHorseLeaderboard;
export type PrivateOverallLeaderboard = LeaderboardEntry[];
export type PrivateBlackjackLeaderboard = BlackjackEntry[];
export type PrivateDuelingLeaderboard = DuelingEntry[];
export type PrivateFishingLeaderboard = FishingEntry[];
export type PrivateHorseLeaderboard = HorseEntry[];

export type PublicLeaderboard = PublicOverallLeaderboard | PublicBlackjackLeaderboard | PublicDuelingLeaderboard | PublicFishingLeaderboard | PublicHorseLeaderboard;
export type PublicOverallLeaderboard = PublicLeaderboardEntry[];
export type PublicBlackjackLeaderboard = PublicBlackjackEntry[];
export type PublicDuelingLeaderboard = PublicDuelingEntry[];
export type PublicFishingLeaderboard = PublicFishingEntry[];
export type PublicHorseLeaderboard = PublicHorseEntry[];

const LeaderboardIdentityEntrySchema = z.object({}).extend({
	playerid: GameIdentitySchema.shape.playerid,
	fullnick: IdentitySchema.shape.fullnick,
});

export type LeaderboardEntry = z.infer<typeof LeaderboardEntrySchema>;
export type PublicLeaderboardEntry = Omit<LeaderboardEntry, 'playerid'>;
export const LeaderboardEntrySchema = LeaderboardIdentityEntrySchema.extend({
	gamePoints: GameIdentitySchema.shape.gamePoints
});

export type BlackjackEntry = z.infer<typeof BlackjackEntrySchema>;
export type PublicBlackjackEntry = Omit<BlackjackEntry, 'playerid'>;
export const BlackjackEntrySchema = LeaderboardIdentityEntrySchema.extend({
	blackjackWinnings: GameIdentitySchema.shape.blackjackWinnings, 
	blackjackBlackjacks: GameIdentitySchema.shape.blackjackBlackjacks
});

export type DuelingEntry = z.infer<typeof DuelingEntrySchema>;
export type PublicDuelingEntry = Omit<DuelingEntry, 'playerid'>;
export const DuelingEntrySchema = LeaderboardIdentityEntrySchema.extend({
	duelingWins: GameIdentitySchema.shape.duelingWins, 
	duelingHonor: GameIdentitySchema.shape.duelingHonor
});

export type FishingEntry = z.infer<typeof FishingEntrySchema>;
export type PublicFishingEntry = Omit<FishingEntry, 'playerid'>;
export const FishingEntrySchema = LeaderboardIdentityEntrySchema.extend({
	fishingCatches: GameIdentitySchema.shape.fishingCatches,
	fishingTypesCaught: z.number().int().min(0),
	fishingWinnings: GameIdentitySchema.shape.fishingWinnings,
	fishingBestCatchValue: GameIdentitySchema.shape.fishingBestCatchValue,
	fishingRecords: z.number().int().min(0)
});

export type HorseEntry = z.infer<typeof HorseEntrySchema>;
export type PublicHorseEntry = Omit<HorseEntry, 'playerid'>;
export const HorseEntrySchema = LeaderboardIdentityEntrySchema.extend({
	horseWinnings: GameIdentitySchema.shape.horseWinnings,
	horseBetWins: GameIdentitySchema.shape.horseBetWins
});