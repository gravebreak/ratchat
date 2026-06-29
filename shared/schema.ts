import{ Server, Socket } from 'socket.io';
import{ z } from 'zod';

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
export type DefaultIdentity = Omit<Identity, "guid" | "nick">
export type UserSum = Pick<Identity, "nick" | "status" | "isMod" | "isAfk"> 

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
} as  const;
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

export interface ChatMessage {
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

export interface Command {
	socket: Socket;
	io: Server;
	args: string[];
	fullArgs: string;
	commandUser: Identity | null;
}

export const ServerConfigSchema = z.object({
	welcomeMsg: z.string(),
	slowMode: z.number(),
	nickSlow: z.number(),
	otherSlow: z.number(),
	timeoutDef: z.number(),
	afkDef: z.number(),
	signupTime: z.number(),
	maxMsgLen: z.number(),
	maxNickLen: z.number(),
	maxStatusLen: z.number(),
	msgArrayLen: z.number(),
	msgArrayTimeout: z.number(),
	stvurl: z.string().optional(),
	nickres: z.array(z.string()),
	gdprcontact: z.string(),
	PORT: z.number()
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
}

export const MarkovConfigSchema = z.object({
	enabled: z.boolean(),
	learning: z.boolean(),
	nick: z.string(),
	color: z.string(),
	status: z.string(),
	cooldown: z.number(),
	timer: z.number()
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
}

export const GameConfigSchema = z.object({
	enabled: z.boolean(),
	pointStartAmt: z.number(),
	pointName: z.string(),
	gameSlow: z.number(),
	horseRacing: z.boolean(),
	raceFrequency: z.number(),
	dueling: z.boolean(),
	duelingChallenge: z.boolean(),
	blackjack: z.boolean(),
	fishing: z.boolean()
});
export type GameConfig = z.infer<typeof GameConfigSchema>;
export const defaultGameConfig: GameConfig ={
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
}

export type ConfigSchema = typeof ServerConfigSchema | typeof MarkovConfigSchema | typeof GameConfigSchema;
export type Config = ServerConfig | MarkovConfig | GameConfig;