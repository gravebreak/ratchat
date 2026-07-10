import type { z } from 'zod';

import { ServerConfigSchema, MarkovConfigSchema, GameConfigSchema } from '../defs/def-config';
import { IdentitySchema, GameIdentitySchema } from '../defs/def-identity';
import { aType } from '../defs/def-parse';
import type { Config, ConfigSchema, ServerConfig, MarkovConfig, GameConfig } from '../defs/def-config';
import type { Identity, GameIdentity, DefaultIdentity, DefaultGameIdentity} from '../defs/def-identity';
import type { SchemaType, ParseFailureRecord } from '../defs/def-parse';

export function parseArray<T>(parsed: unknown[], schema: z.ZodType<T>): T[]{
	return parsed.filter((entry): entry is T => schema.safeParse(entry).success);
}

export function mergeIdentityDefaults(input: unknown, defaults: DefaultIdentity, schemaName: typeof aType.id, schema: typeof IdentitySchema): [Identity | null, ParseFailureRecord[]];
export function mergeIdentityDefaults(input: unknown, defaults: DefaultGameIdentity, schemaName: typeof aType.gid, schema: typeof GameIdentitySchema): [GameIdentity | null, ParseFailureRecord[]];
export function mergeIdentityDefaults(input: unknown, defaults: DefaultIdentity | DefaultGameIdentity, schemaName: SchemaType, schema: typeof IdentitySchema | typeof GameIdentitySchema): [Identity | GameIdentity | null, ParseFailureRecord[]] {
	const [merged, failures] = mergeDefaults(input, defaults, schemaName, schema);
	const result = schema.safeParse(merged);

	if(result.success){
		const output = result.data;
		return [output, failures];
	}
	else{
		return [null, failures];
	}
}

export function mergeConfigDefaults(input: unknown, defaults: ServerConfig, schemsaName: typeof aType.sconfig, schema: typeof ServerConfigSchema): [ServerConfig, ParseFailureRecord[]];
export function mergeConfigDefaults(input: unknown, defaults: MarkovConfig, schemaName: typeof aType.mconfig, schema: typeof MarkovConfigSchema): [MarkovConfig, ParseFailureRecord[]];
export function mergeConfigDefaults(input: unknown, defaults: GameConfig, schemaName: typeof aType.gconfig, schema: typeof GameConfigSchema): [GameConfig, ParseFailureRecord[]];
export function mergeConfigDefaults(input: unknown, defaults: Config, schemaName: SchemaType, schema: ConfigSchema): [Config, ParseFailureRecord[]] {
	const [merged, failures] = mergeDefaults(input, defaults, schemaName, schema);
	const output = schema.parse(merged);
	return [output, failures];
}

function mergeDefaults(input: unknown, defaults: Record<string, unknown>, schemaName: SchemaType, schema: z.ZodObject<z.ZodRawShape>): [unknown, ParseFailureRecord[]] {
	const shape = schema.shape;
	const merged: Record<string, unknown> = {};
	const failures: ParseFailureRecord[] = [];

	for(const key of Object.keys(shape)){
		const fieldSchema = shape[key] as z.ZodTypeAny;
		const val = (input as Record<string, unknown>)?.[key];
		const def = defaults[key];
		const parsed = fieldSchema.safeParse(val);

		if(parsed.success){
			merged[key] = parsed.data;
		}
		else{
			failures.push({
				raw: input,
				schemaName,
				field: key,
				invalidValue: val,
				substitutedValue: def
			});
			merged[key] = def;
		}
	}

	return [merged, failures];
}