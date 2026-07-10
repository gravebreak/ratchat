import { z } from 'zod';

export type Identity = z.infer<typeof IdentitySchema>;
export type DefaultIdentity = Omit<Identity, "guid" | "playerid" | "fullnick">;
export type UserSum = Pick<Identity, "fullnick" | "status" | "isMod" | "isAfk">;
export const IdentitySchema = z.object({
	guid: z.string(),
	playerid: z.string(),
	fullnick: z.string(),
	status: z.string(),
	lastMessage: z.coerce.date(),
	lastChanged: z.coerce.date(),
	isMod: z.boolean(),
	isAfk: z.boolean(),
});

export type GameIdentity = z.infer<typeof GameIdentitySchema>;
export type DefaultGameIdentity = Omit<GameIdentity, "playerid">;
export const GameIdentitySchema = z.object({
	playerid: z.string(),
	gamePoints: z.number().int().min(0),
	lastGame: z.coerce.date(),
	blackjackWinnings: z.number().int(),
	blackjackBlackjacks: z.number().int().min(0),
	duelingWins: z.number().int().min(0),
	duelingHonor: z.number().int(),
	fishingFishCaught: z.array(z.string()),
	fishingCatches: z.number().int().min(0),
	fishingWinnings: z.number().int().min(0),
	fishingBestCatch: z.string().nullable(),
	fishingBestCatchValue: z.number().int().min(0).nullable(),
	horseWinnings: z.number().int(),
	horseBetWins: z.number().int().min(0)
});
