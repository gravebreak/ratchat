import {z} from 'zod';
import type {Server, Socket} from 'socket.io';

import {IdentitySchema} from './def-identity';
import type {Identity, UserSum} from './def-identity';
import type {InputStatus} from './def-input';

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

export type GameEventType = typeof gType[keyof typeof gType];
export const gType = {
	horse: 'horse',
	duel: 'duel',
	blackjack: 'blackjack',
	fishing: 'fishing',
	info: 'info'
} as const;

export type FormatType = typeof fType[keyof typeof fType];
export const fType = {
	b: 'bold',
	i: 'italics',
	mono: 'mono'
} as const;

export type GameHighlightType = typeof hType[keyof typeof hType];
export const hType = {
	normal: 'normal',
	clear: 'clear',
	gold: 'gold',
	silver: 'silver',
	bronze: 'bronze',
	blue: 'blue',
	brown: 'brown',
	black: 'black',
	gray: 'gray',
	green: 'green',
	navy: 'navy',
	orange: 'orange',
	pink: 'pink',
	purple: 'purple',
	teal: 'teal',
	red: 'red',
	white: 'white',
	yellow: 'yellow'
} as const;

export type IdentityPayload = Identity;
export type UserListPayload = UserSum[];
export type DeleteMessagePayload = ChatPayload['id'][];
export type DeleteClientLocalDataPayload = Identity['guid'];

export type EmoteListPayload = z.infer<typeof EmoteListPayloadSchema>;
export const EmoteListPayloadSchema = z.record(z.string(), z.string());

export type EventListPayload = z.infer<typeof EventListPayloadSchema>;
export const EventListPayloadSchema = z.array(z.enum(gType));

export type GameText = z.infer<typeof GameTextSchema>;
export const GameTextSchema = z.object({
	text: z.string(),
	color: z.enum(hType),
	format: z.array(z.enum(fType))
});
export type GameLine = z.infer<typeof GameLineSchema>
export const GameLineSchema = z.array(GameTextSchema);
export type GameTextPayload = z.infer<typeof GameTextPayloadSchema>
export const GameTextPayloadSchema = z.array(GameLineSchema);

export type GameDeliveryMode = typeof dType[keyof typeof dType];
export const dType = {
	append: 'append',
	replace: 'replace',
	direct: 'direct'
} as const;

export type GameRenderMode = typeof rType[keyof typeof rType];
export const rType = {
	static: 'static',
	dynamic: 'dynamic',
	direct: 'direct'
} as const;

export type GamePayload = z.infer<typeof GamePayloadSchema>;
export const GamePayloadSchema = z.object({
	content: GameTextPayloadSchema,
	event: z.enum(gType),
	id: z.string().min(1).max(64).nullable(),
	rendermode: z.enum(rType),
	deliverymode: z.enum(dType),
	timestamp: z.number(),
	msdelay: z.number().int().min(0).max(32768),
});

export type ChatPayload = z.infer<typeof ChatPayloadSchema>;
export const ChatPayloadSchema = z.object({
	id: z.number(),
	author: IdentitySchema.shape.fullnick,
	content: z.string(),
	timestamp: z.number(),
	type: z.enum(cType),
	format: z.array(z.enum(fType)),
	spoiler: z.boolean()
});
