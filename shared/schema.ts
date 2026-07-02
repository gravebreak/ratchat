import{ Server, Socket } from 'socket.io';
import{ z } from 'zod';

import { isValid7TVID, isValidHexColor } from "../server/utils/input";

export const IdentitySchema = z.object({
	guid: z.string(),
	nick: z.string(),
	status: z.string(),
	lastMessage: z.coerce.date(),
	lastChanged: z.coerce.date(),
	isMod: z.boolean(),
	isAfk: z.boolean(),
});
export type Identity = z.infer<typeof IdentitySchema>;
export type DefaultIdentity = Omit<Identity, "guid" | "nick">;
export type UserSum = Pick<Identity, "nick" | "status" | "isMod" | "isAfk">;

export const GameIdentitySchema = z.object({
	guid: z.string(),
	gamePoints: z.number(),
	lastGame: z.coerce.date()
});
export type GameIdentity = z.infer<typeof GameIdentitySchema>;
export type DefaultGameIdentity = Omit<GameIdentity, "guid">;

export const mType = {
	chat: "toClientChat",
	info: "toClientInfo",
	error: "toClientError",
	ann: "toClientAnnouncement",
	welcome: "toClientWelcome",
	markov: "toClientMarkov",
	game: "toClientGame",
	identity: "identity",
	ulist: "userlist",
	elist: "eventlist",
	emotelist: "emotelist",
	delmsg: "deleteMsg",
	clrlocal: "clearLocalData"
} as const;
export type MessageType = typeof mType[keyof typeof mType];

export const sType = {
	schat: "toServerChat",
	elist: "requesteventlist"
} as const;
export type ServerRequest = typeof sType[keyof typeof sType];

export const tType = {
	chat: "chat",
	nick: "nick",
	joinleave: "joinleave",
	game: "game",
	other:"other"
} as const;
export type TimeType = typeof tType[keyof typeof tType];

export const xType = {
	chat: "chat",
	status: "status",
	nick: "nick",
	color: "color"
} as const;
export type TextType = typeof xType[keyof typeof xType];

export const eType = {
	duel: "duel",
	fishing: "fishing",
	horse: "horse",
	blackjack: "blackjack",
	leaderboard: "leaderboard"
} as const;
export type GameEventType = typeof eType[keyof typeof eType];

export interface ChatMessage{
	id: number;
	author: Identity['nick'];
	content: string;
	timestamp: number;
	type: MessageType;
	spoiler: boolean;
}

export interface GameEvent{
	content: string;
	timestamp: number;
	event: GameEventType;
}

export interface Command{
	socket: Socket;
	io: Server;
	args: string[];
	fullArgs: string;
	commandUser: Identity | null;
}

export const ServerConfigSchema = z.object({
	welcomeMsg: z.string().min(0).max(512),
	slowMode: z.number().int().min(0).max(86400),
	nickSlow: z.number().int().min(0).max(86400),
	otherSlow: z.number().int().min(0).max(86400),
	timeoutDef: z.number().int().min(0).max(86400),
	afkDef: z.number().int().min(1).max(86400),
	signupTime: z.number().int().min(1).max(60),
	maxMsgLen: z.number().int().min(1).max(1024),
	maxNickLen: z.number().int().min(2).max(64),
	maxStatusLen: z.number().int().min(1).max(128),
	msgArrayLen: z.number().int().min(0).max(1024),
	msgArrayTimeout: z.number().int().min(60).max(2592000),
	stvurl: z.string().refine(isValid7TVID, { message: "doesn't look like a 7tv emote set ID" }).optional(),
	nickres: z.array(z.string().min(2).max(64).regex(/^\S+$/)).max(32),
	gdprcontact: z.email().or(z.string().min(1).max(255)),
	PORT: z.number().int().min(1).max(65535)
});
export type ServerConfig = z.infer<typeof ServerConfigSchema>;
export const defaultServerConfig: ServerConfig = {
	welcomeMsg: 'Welcome!',
	slowMode: 1,
	nickSlow: 30,
	otherSlow: 5,
	timeoutDef: 300,
	afkDef: 1000,
	signupTime: 5,
	maxMsgLen: 255,
	maxNickLen: 16,
	maxStatusLen: 32,
	msgArrayLen: 25,
	msgArrayTimeout: 86400, 
	stvurl: undefined,
	nickres: [],
	gdprcontact: 'admin@email.here',
	PORT: 3666,
};

export const MarkovConfigSchema = z.object({
	enabled: z.boolean(),
	learning: z.boolean(),
	nick: z.string().min(2).max(64).regex(/^\S+$/),
	color: z.string().refine(isValidHexColor, { message: "must be a valid hex color, e.g. #A1B2C3" }),
	status: z.string().min(1).max(128),
	cooldown: z.number().int().min(5).max(86400),
	timer: z.number().int().min(60).max(86400)
});
export type MarkovConfig = z.infer<typeof MarkovConfigSchema>;
export const defaultMarkovConfig: MarkovConfig = {
	enabled: false,
	learning: false,
	nick: 'markov',
	color: '#000000',
	status: 'online',
	cooldown: 30,
	timer: 300
};

const GameTypeConfigSchema = {
	horseRacing: z.boolean(),
	duelingChallenge: z.boolean(),
	dueling: z.boolean(),
	blackjack: z.boolean(),
	fishing: z.boolean(),
} as const;
export type GameType = keyof typeof GameTypeConfigSchema;
export const allGames = Object.keys(GameTypeConfigSchema) as GameType[];
export const GameConfigSchema = z.object({
  enabled: z.boolean(),
  pointStartAmt: z.number().int().min(0).max(65536),
  pointName: z.string().min(1).max(64),
  gameSlow: z.number().int().min(0).max(86400),
  raceFrequency: z.number().int().min(60).max(86400),
  ...GameTypeConfigSchema,
});
export type GameConfig = z.infer<typeof GameConfigSchema>;
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

export type ConfigSchema = typeof ServerConfigSchema | typeof MarkovConfigSchema | typeof GameConfigSchema;
export type Config = ServerConfig | MarkovConfig | GameConfig;