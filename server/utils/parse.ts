import type { z } from 'zod';

import { IdentitySchema, GameIdentitySchema } from '../defs/def-identity';
import { FishRecordEntrySchema, HorseRecordEntrySchema } from '../defs/def-record';
import { aType } from '../defs/def-parse';
import type { Config, ServerConfig, MarkovConfig, GameConfig, ServerConfigParams, MarkovConfigParams, GameConfigParams, ConfigParams } from '../defs/def-config';
import type { Identity, GameIdentity, DefaultIdentity, DefaultGameIdentity} from '../defs/def-identity';
import type { DefaultFishRecordEntry, DefaultHorseRecordEntry, FishRecordEntry, HorseRecordEntry } from '../defs/def-record';
import type { SchemaType, ParseFailureRecord } from '../defs/def-parse';

export function parseArray<T>(parsed: unknown[], schema: z.ZodType<T>): T[]{
	return parsed.filter((entry): entry is T => schema.safeParse(entry).success);
}

export function isUnknownArray(input: unknown): input is unknown[]{
	return Array.isArray(input);
}

export function mergeIdentityDefaults(input: unknown, label: typeof aType.id, fallback: DefaultIdentity, schema: typeof IdentitySchema): [Identity | null, ParseFailureRecord[]];
export function mergeIdentityDefaults(input: unknown, label: typeof aType.gid, fallback: DefaultGameIdentity, schema: typeof GameIdentitySchema): [GameIdentity | null, ParseFailureRecord[]];
export function mergeIdentityDefaults(input: unknown, label: SchemaType, fallback: DefaultIdentity | DefaultGameIdentity, schema: typeof IdentitySchema | typeof GameIdentitySchema): [Identity | GameIdentity | null, ParseFailureRecord[]] {
	const [merged, failures] = mergeDefaults(input, label, fallback, schema);
	const result = schema.safeParse(merged);

	if(result.success){
		const output = result.data;
		return [output, failures];
	}
	else{
		return [null, failures];
	}
}

export function mergeConfigDefaults(input: unknown, params: ServerConfigParams): [ServerConfig, ParseFailureRecord[]];
export function mergeConfigDefaults(input: unknown, params: MarkovConfigParams): [MarkovConfig, ParseFailureRecord[]];
export function mergeConfigDefaults(input: unknown, params: GameConfigParams): [GameConfig, ParseFailureRecord[]];
export function mergeConfigDefaults(input: unknown, params: ConfigParams): [Config, ParseFailureRecord[]] {
	const [merged, failures] = mergeDefaults(input, params.label, params.fallback, params.schema);
	const output = params.schema.parse(merged);
	return [output, failures];
}

export function mergeRecordDefaults(input: unknown, label: typeof aType.gfish, fallback: DefaultFishRecordEntry, schema: typeof FishRecordEntrySchema): [FishRecordEntry | null, ParseFailureRecord[]];
export function mergeRecordDefaults(input: unknown, label: typeof aType.ghorse, fallback: DefaultHorseRecordEntry, schema: typeof HorseRecordEntrySchema): [HorseRecordEntry | null, ParseFailureRecord[]];
export function mergeRecordDefaults(input: unknown, label: SchemaType, fallback: DefaultFishRecordEntry | DefaultHorseRecordEntry, schema: typeof FishRecordEntrySchema | typeof HorseRecordEntrySchema): [FishRecordEntry | HorseRecordEntry | null, ParseFailureRecord[]] {
	const [merged, failures] = mergeDefaults(input, label, fallback, schema);
	const result = schema.safeParse(merged);
	if(result.success){
		const output = result.data;
		return [output, failures];
	}
	else{
		return [null, failures];
	}
}

function mergeDefaults(input: unknown, label: SchemaType, fallback: Record<string, unknown>, schema: z.ZodObject<z.ZodRawShape>): [unknown, ParseFailureRecord[]] {
	const shape = schema.shape;
	const merged: Record<string, unknown> = {};
	const failures: ParseFailureRecord[] = [];

	for(const key of Object.keys(shape)){
		const fieldSchema = shape[key] as z.ZodTypeAny;
		const val = (input as Record<string, unknown>)?.[key];
		const parsed = fieldSchema.safeParse(val);
		const def = fallback[key];

		if(parsed.success){
			merged[key] = parsed.data;
		}
		else{
			failures.push({
				raw: input,
				label,
				field: key,
				invalidValue: val,
				substitutedValue: def
			});
			merged[key] = def;
		}
	}

	return [merged, failures];
}
