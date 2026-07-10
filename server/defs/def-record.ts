import { z } from 'zod';

import { IdentitySchema, GameIdentitySchema } from './def-identity';

export type PrivateFishRecordList = FishRecordEntry[];
export type PrivateHorseRecordList = HorseRecordEntry[];

export type PublicFishRecordList = PublicFishRecord[];
export type PublicHorseRecordList = PublicHorseRecord[];

const RecordIdentityEntrySchema = z.object({}).extend({
	playerid: GameIdentitySchema.shape.playerid.nullable(),
	fullnick: IdentitySchema.shape.fullnick.nullable(),
});

export type FishCatalogEntry = z.infer<typeof FishCatalogEntrySchema>;
export type FishRecordEntry = z.infer<typeof FishRecordEntrySchema>;
export type PublicFishRecord = Omit<FishRecordEntry, 'playerid'>;
export const FishCatalogEntrySchema = z.object({
	fishName: z.string().max(128),
	baseline: z.number().min(0)
});
export const FishRecordEntrySchema = FishCatalogEntrySchema.extend({
	weight: z.number().min(0).nullable(),
	...RecordIdentityEntrySchema.shape
});

export type HorseCatalogEntry = z.infer<typeof HorseCatalogEntrySchema>;
export type HorseRecordEntry = z.infer<typeof HorseRecordEntrySchema>;
export type PublicHorseRecord = Omit<HorseRecordEntry, never>;
export const HorseCatalogEntrySchema = z.object({
	horseName: z.string().max(128)
});
export const HorseRecordEntrySchema = HorseCatalogEntrySchema.extend({
	wins: z.number().int().min(0)
});

