import {z} from 'zod';

import {hType} from './def-events';
import {IdentitySchema, GameIdentitySchema} from './def-identity';

export type PrivateHorseRecordList = HorseRecordEntry[];
export type PrivateFishRecordList = FishRecordEntry[];

export type PublicHorseRecordList = PublicHorseRecordEntry[];
export type PublicFishRecordList = PublicFishRecordEntry[];

const RecordIdentityEntrySchema = z.object({}).extend({
	playerid: GameIdentitySchema.shape.playerid.nullable(),
	fullnick: IdentitySchema.shape.fullnick.nullable(),
});

export type HorseCatalogEntry = z.infer<typeof HorseCatalogEntrySchema>;
export type HorseRecordEntry = z.infer<typeof HorseRecordEntrySchema>;
export type PublicHorseRecordEntry = Omit<HorseRecordEntry, never>;
export type DefaultHorseRecordEntry = Omit<HorseRecordEntry, 'horseName'>;
export const HorseCatalogEntrySchema = z.object({
	horseName: z.string().max(128)
});
export const HorseRecordEntrySchema = HorseCatalogEntrySchema.extend({
	finishes: z.object({first: z.number().int().min(0), second: z.number().int().min(0), third: z.number().int().min(0)}),
});

export type FishCatalogEntry = z.infer<typeof FishCatalogEntrySchema>;
export type FishRecordEntry = z.infer<typeof FishRecordEntrySchema>;
export type PublicFishRecordEntry = Omit<FishRecordEntry, 'playerid'>;
export type DefaultFishRecordEntry = Omit<FishRecordEntry, 'fishName' | 'fishFlavor' | 'baseline'>;
export const FishCatalogEntrySchema = z.object({
	fishName: z.string().min(2).max(128),
	baseline: z.number().min(0),
	fishFlavor: z.string().min(2).max(128),
	fishColor: z.enum(hType)
});
export const FishRecordEntrySchema = FishCatalogEntrySchema.extend({
	weight: z.number().min(0).nullable(),
	...RecordIdentityEntrySchema.shape
});
