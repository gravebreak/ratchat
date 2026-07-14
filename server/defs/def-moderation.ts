import { z } from 'zod';

export type ProfanityFilterEntry = z.infer<typeof ProfanityFilterEntrySchema>;
export const ProfanityFilterEntrySchema = z.object({
	id: z.string(),
	match: z.string(),
	tags: z.array(z.string()),
	severity: z.number().int(),
	exceptions: z.array(z.string()).optional(),
});

export type TimeType = typeof tType[keyof typeof tType];
export const tType = {
	chat: 'chat',
	nick: 'nick',
	joinleave: 'joinleave',
	game: 'game',
	other:'other'
} as const;

export type TextType = typeof xType[keyof typeof xType];
export const xType = {
	chat: 'chat',
	status: 'status',
	base: 'base',
	color: 'color'
} as const;
