import{ z } from 'zod';

import { aType } from './def-parse';

import { isValid7TVID, isValidHexColor } from '../utils/validate';

export type Config = ServerConfig | MarkovConfig | GameConfig;
export type ConfigSchema = typeof ServerConfigSchema | typeof MarkovConfigSchema | typeof GameConfigSchema;
export type ConfigParams = ServerConfigParams | MarkovConfigParams | GameConfigParams;

export type ServerConfig = z.infer<typeof ServerConfigSchema>;
export type ServerConfigParams = {label: typeof aType.sconfig, fallback: ServerConfig, schema: typeof ServerConfigSchema};
export const ServerConfigSchema = z.object({
	welcomeMsg: z.string().min(0).max(512),
	slowMode: z.number().int().min(0).max(86400),
	nickSlow: z.number().int().min(0).max(86400),
	otherSlow: z.number().int().min(0).max(86400),
	timeoutDef: z.number().int().min(0).max(86400),
	afkDef: z.number().int().min(1).max(86400),
	signupTime: z.number().int().min(1).max(60),
	maxMsgLen: z.number().int().min(1).max(1024),
	maxBaseNickLen: z.number().int().min(2).max(64),
	maxStatusLen: z.number().int().min(1).max(128),
	msgArrayLen: z.number().int().min(0).max(1024),
	msgArrayTimeout: z.number().int().min(60).max(2592000),
	banLength: z.number().int().min(1).max(365), //days
	stvurl: z.string().refine(isValid7TVID, { message: "doesn't look like a 7tv emote set ID" }).optional(),
	baseNickRes: z.array(z.string().min(2).max(64).regex(/^\S+$/)).max(32),
	gdprcontact: z.email().or(z.string().min(1).max(255)),
	PORT: z.number().int().min(1).max(65535)
});
export const defaultServerConfig: ServerConfig = {
	welcomeMsg: 'Welcome!',
	slowMode: 1,
	nickSlow: 30,
	otherSlow: 5,
	timeoutDef: 300,
	afkDef: 1000,
	signupTime: 5,
	maxMsgLen: 255,
	maxBaseNickLen: 16,
	maxStatusLen: 32,
	msgArrayLen: 25,
	msgArrayTimeout: 86400, 
	banLength: 365,
	stvurl: undefined,
	baseNickRes: [],
	gdprcontact: 'admin@email.here',
	PORT: 3666,
};

export type MarkovConfig = z.infer<typeof MarkovConfigSchema>;
export type MarkovConfigParams = {label: typeof aType.mconfig, fallback: MarkovConfig, schema: typeof MarkovConfigSchema};
export const MarkovConfigSchema = z.object({
	enabled: z.boolean(),
	learning: z.boolean(),
	basenick: z.string().min(2).max(64).regex(/^\S+$/),
	color: z.string().refine(isValidHexColor, { message: 'must be a valid hex color, e.g. #A1B2C3' }),
	status: z.string().min(1).max(128),
	cooldown: z.number().int().min(5).max(86400),
	timer: z.number().int().min(60).max(86400)
});
export const defaultMarkovConfig: MarkovConfig = {
	enabled: false,
	learning: false,
	basenick: 'markov',
	color: '#000000',
	status: 'online',
	cooldown: 30,
	timer: 300
};

export type GameType = keyof typeof GameTypeConfigSchema;
export type GameConfig = z.infer<typeof GameConfigSchema>;
export type GameConfigParams = {label: typeof aType.gconfig, fallback: GameConfig, schema: typeof GameConfigSchema};
const GameTypeConfigSchema = {
	horseRacing: z.boolean(),
	duelingChallenge: z.boolean(),
	dueling: z.boolean(),
	blackjack: z.boolean(),
	fishing: z.boolean(),
} as const;
export const GameConfigSchema = z.object({
  enabled: z.boolean(),
  pointStartAmt: z.number().int().min(0).max(65536),
  pointName: z.string().min(1).max(64),
  gameSlow: z.number().int().min(0).max(86400),
  raceFrequency: z.number().int().min(60).max(86400),
  ...GameTypeConfigSchema,
});

export const defaultGameConfig: GameConfig = {
	enabled: false,
	pointStartAmt: 100,
	pointName: 'points',
	gameSlow: 30,
	horseRacing: false,
	raceFrequency: 900,
	dueling: false,
	duelingChallenge: false,
	blackjack: false,
	fishing: false
};
export const allGames = Object.keys(GameTypeConfigSchema) as GameType[];