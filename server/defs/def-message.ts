import { z } from 'zod';
import type { Socket, Server } from 'socket.io';

import { IdentitySchema } from './def-identity';
import type { Identity } from './def-identity';

export type GameEvent = {
	content: string;
	timestamp: number;
	event: GameEventType;
}

export type Command = {
	socket: Socket;
	io: Server;
	args: string[];
	fullArgs: string;
	commandUser: Identity | null;
}

export type MessageType = typeof mType[keyof typeof mType];
export const mType = {
	chat: 'toClientChat',
	info: 'toClientInfo',
	error: 'toClientError',
	ann: 'toClientAnnouncement',
	welcome: 'toClientWelcome',
	markov: 'toClientMarkov',
	game: 'toClientGame',
	identity: 'identity',
	ulist: 'userlist',
	elist: 'eventlist',
	emotelist: 'emotelist',
	delmsg: 'deleteMsg',
	clrlocal: 'clearLocalData'
} as const;

export type ServerRequest = typeof sType[keyof typeof sType];
export const sType = {
	schat: 'toServerChat',
	elist: 'requesteventlist'
} as const;

export type GameEventType = typeof eType[keyof typeof eType];
export const eType = {
	duel: 'duel',
	fishing: 'fishing',
	horse: 'horse',
	blackjack: 'blackjack',
	leaderboard: 'leaderboard'
} as const;

export type ChatMessage = z.infer<typeof ChatMessageSchema>;
export const ChatMessageSchema = z.object({
	id: z.number(),
	author: IdentitySchema.shape.fullnick,
	content: z.string(),
	timestamp: z.number(),
	type: z.enum(mType),
	spoiler: z.boolean()
});