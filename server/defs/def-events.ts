import { z } from 'zod';
import type { Server, Socket } from 'socket.io';

import { IdentitySchema } from './def-identity';
import type { Identity, UserSum } from './def-identity';
import type { InputStatus } from './def-input';

export type RatServer = Server<ToServer, ToClient>;
export type RatSocket = Socket<ToServer, ToClient>;

export type ClientEventType = typeof cType[keyof typeof cType];
export type ToClient = {
	[cType.chat]: (payload: ChatPayload) => void;
	[cType.info]: (payload: ChatPayload) => void;
	[cType.error]: (payload: ChatPayload) => void;
	[cType.ann]: (payload: ChatPayload) => void;
	[cType.welcome]: (payload: ChatPayload) => void;
	[cType.markov]: (payload: ChatPayload) => void;
	[cType.game]: (payload: GamePayload) => void;
	[cType.identity]: (payload: IdentityPayload) => void;
	[cType.ulist]: (payload: UserListPayload) => void;
	[cType.elist]: (payload: EventListPayload) => void;
	[cType.emotelist]: (payload: EmoteListPayload) => void;
	[cType.delmsg]: (payload: DeleteMessagePayload) => void;
	[cType.clrlocal]: (payload: DeleteClientLocalDataPayload) => void;
};
export const cType = {
	chat: 'toClientChat',
	info: 'toClientInfo',
	error: 'toClientError',
	ann: 'toClientAnnouncement',
	welcome: 'toClientWelcome',
	markov: 'toClientMarkov',
	game: 'toClientGame',
	identity: 'toClientIdentity',
	ulist: 'toClientUserList',
	elist: 'toClientEventList',
	emotelist: 'toClientEmoteList',
	delmsg: 'toClientDeleteMessage',
	clrlocal: 'toClientClearLocalData'
} as const;

export type ServerEventType = typeof sType[keyof typeof sType];
export type ToServer = {
	[sType.schat]: (msg: string, callback: (result: InputStatus) => void) => void;
	[sType.elist]: (callback: () => void) => void;
};
export const sType = {
	schat: 'toServerChat',
	elist: 'toServerEventList'
} as const;

export type GameEventType = typeof eType[keyof typeof eType];
export const eType = {
	duel: 'duel',
	fishing: 'fishing',
	horse: 'horse',
	blackjack: 'blackjack',
	leaderboard: 'leaderboard'
} as const;

export type IdentityPayload = Identity;
export type UserListPayload = UserSum[];
export type DeleteMessagePayload = ChatPayload['id'][];
export type DeleteClientLocalDataPayload = Identity['guid'];

export type EmoteListPayload = z.infer<typeof EmoteListPayloadSchema>;
export const EmoteListPayloadSchema = z.record(z.string(), z.string());

export type EventListPayload = z.infer<typeof EventListPayloadSchema>;
export const EventListPayloadSchema = z.array(z.enum(eType));

export type GamePayload = z.infer<typeof GamePayloadSchema>;
export const GamePayloadSchema = z.object({
	content: z.string(),
	timestamp: z.number(),
	event: z.enum(eType)
});

export type ChatPayload = z.infer<typeof ChatPayloadSchema>;
export const ChatPayloadSchema = z.object({
	id: z.number(),
	author: IdentitySchema.shape.fullnick,
	content: z.string(),
	timestamp: z.number(),
	type: z.enum(cType),
	spoiler: z.boolean()
});
