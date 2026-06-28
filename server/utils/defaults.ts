import type { z } from "zod";

import { IdentitySchema, ServerConfigSchema, MarkovConfigSchema, GameConfigSchema } from "../../shared/schema";
import { Config, ConfigSchema, DefaultGameIdentity, DefaultIdentity, GameIdentity, GameIdentitySchema, Identity } from "../../shared/schema";

export function mergeDefaults<T extends Config>(input: unknown, defaults: T, schema: ConfigSchema): T
export function mergeDefaults(input: unknown, defaults: DefaultIdentity, schema: typeof IdentitySchema): Identity
export function mergeDefaults(input: unknown, defaults: DefaultGameIdentity, schema: typeof GameIdentitySchema): GameIdentity
export function mergeDefaults(input: unknown, defaults: Config | DefaultIdentity | DefaultGameIdentity, schema: ConfigSchema | typeof IdentitySchema | typeof GameIdentitySchema): Config | Identity | GameIdentity {
	const shape = (schema as z.ZodObject<z.ZodRawShape>).shape;
	const merged: Record<string, unknown> = {};

	for(const key of Object.keys(shape)){
		const fieldSchema = shape[key] as z.ZodTypeAny;
		const val = (input as Record<string, unknown>)?.[key];
		const def = (defaults as Record<string, unknown>)[key];

		const parsed = fieldSchema.safeParse(val);
		merged[key] = parsed.success ? parsed.data : def;
	}

	try{
		return validateMerge(merged, schema);
	} 
	catch(error: unknown){
		if(error instanceof Error){
			throw new Error(`mergeDefaults validation failed: ${error.message}`);
		} 
		else{
			console.error("Unexpected non-error thrown:", error);
			throw new Error("Unexpected error")
		}
	}
}

function validateMerge(input: Record<string, unknown>, schema: ConfigSchema | typeof IdentitySchema | typeof GameIdentitySchema): Config | Identity | GameIdentity{
	if(schema === IdentitySchema){
		return IdentitySchema.parse(input);
	}
	else if(schema === GameIdentitySchema){
		return GameIdentitySchema.parse(input);
	}
	else if(schema === ServerConfigSchema){
		return ServerConfigSchema.parse(input);
	} 
	else if(schema === MarkovConfigSchema){
		return MarkovConfigSchema.parse(input);
	} 
	else if(schema === GameConfigSchema){
		return GameConfigSchema.parse(input);
	}
	else{
		throw new Error("unknown merge schema");
	}
}