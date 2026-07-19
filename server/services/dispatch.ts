import {cType, gType, ChatPayloadSchema} from '../defs/def-events';
import type {RatServer, RatSocket, ClientEventType, GameEventType, GameTextPayload, FormatType} from '../defs/def-events';
import type {ToClient, ChatPayload, GamePayload, IdentityPayload, UserListPayload, EventListPayload, EmoteListPayload, DeleteMessagePayload, DeleteClientLocalDataPayload} from '../defs/def-events';
import type {Identity} from '../defs/def-identity';

import {CacheService} from './cache';
import {ConfigService} from './config';

import {handleError} from '../utils/errors';
import {getBaseNick} from '../utils/format';
import {parseArray, isUnknownArray} from '../utils/parse';
import {createSaveQueue} from '../utils/queue';

type Target = { emit: RatServer['emit'] };
type TextPayload = typeof cType.chat | typeof cType.ann | typeof cType.error | typeof cType.info | typeof cType.welcome | typeof cType.markov;
type ChatHistory = Map<ChatPayload['id'], ChatPayload>;

const REDIS_HISTORY_KEY = CacheService.createRedisKey('messageHistory');
const REDIS_COUNTER_KEY = CacheService.createRedisKey('messageCounter');
const MAX_INT = 4294967295;

export interface DispatchServiceDependencies {
	cacheService: CacheService
	configService: ConfigService;
}

export class DispatchService{
	private messageCounter: ChatPayload['id'] = 0;
	private chatHistory : ChatHistory = new Map();
	private historyQueue = createSaveQueue(() => this.saveChatHistory());
	private counterQueue = createSaveQueue(() => this.saveMessageCounter());

	private deps: DispatchServiceDependencies;
	constructor(dependencies: DispatchServiceDependencies){
		this.deps = dependencies;
		this.init();
	}

	private init(): void {
		this.startExpireMessageTimer();
	}

	public sendChatPayload(to: Target, author: Identity, content:string, format: FormatType[], spoiler: boolean): void {
		const chatMessage = this.createChatPayload(false, author, content, cType.chat, format, spoiler);
		this.sendPayload(to, cType.chat, chatMessage);
		const msgArrayLen = this.deps.configService.getServerConfig().msgArrayLen;
		if(msgArrayLen > 0){
			this.chatHistory.set(chatMessage.id, chatMessage);
			this.trimChatHistory();
		}
	}

	public sendChatHistory(to: Target): void {
		for (const [, chatMessage] of this.chatHistory){
			this.sendPayload(to, cType.chat, chatMessage);
		}
	}

	public sendSystemChatPayload(to: Target, type: TextPayload, text: string, format: FormatType[] = []): void {
		const systemChatMessage = this.createChatPayload(true,'system',text, type, format, false);
		this.sendPayload(to, type, systemChatMessage);
	}

	public sendMarkovChatPayload(to: Target, text: string, markov: Identity, user: Identity, format: FormatType[], spoiler: boolean, seed?: string): void {
		const taggedText = `${getBaseNick(user.fullnick)}|${seed}|${text}`;
		const markovChat = this.createChatPayload(false,markov, taggedText, cType.markov, format, spoiler);
		this.sendPayload(to, cType.markov, markovChat);
	}

	public sendGamePayload(to: Target, content: GameTextPayload, event: GameEventType, msdelay = 0): void {
		const payload: GamePayload = {
			content: content,
			timestamp: Date.now(),
			msdelay: msdelay,
			event: event
		};
		this.sendPayload(to, cType.game, payload);
	}

	public sendIdentityPayload(to: Target, identity: IdentityPayload): void {
		this.sendPayload(to, cType.identity, identity);
	}

	public sendEmoteListPayload(to: Target, emotes: EmoteListPayload): void {
		this.sendPayload(to, cType.emotelist, emotes);
	}

	public sendUserListPayload(to: Target, users: UserListPayload): void {
		this.sendPayload(to, cType.ulist, users);
	}

	public sendEventListPayload(to: Target): void {
		const eventList: EventListPayload = Object.values(gType);
		this.sendPayload(to, cType.elist, eventList);
	}

	public sendDeleteClientLocalDataPayload(to: Target, guid: DeleteClientLocalDataPayload): void {
		this.sendPayload(to, cType.clrlocal, guid);
	}

	public sendUserErrorMessage(to: RatSocket, error: unknown, prefix: string): void {
		const response = handleError(error, prefix);
		if(response){
			this.sendSystemChatPayload(to, cType.error, `system: ${response}`);
		}
		else{
			this.sendSystemChatPayload(to, cType.error, 'system: unknown error. try again');
		}
	}

	public deleteMessages(io: RatServer, msgIdArray: DeleteMessagePayload): void {
		const deleted: ChatPayload['id'][] = [];

		this.sendPayload(io, cType.delmsg, msgIdArray);

		msgIdArray.forEach(id => {
			if(this.chatHistory.delete(id)){
				deleted.push(id);
			}
		});

		if(deleted.length > 0){
			this.historyQueue.chain();
		}
	}

	public getChatHistory(): ChatHistory {
		const copy: ChatHistory = new Map();

		for(const [id, msg] of this.chatHistory){
			copy.set(id, structuredClone(msg));
		}

		return copy;
	}

	public async restoreChatHistory(): Promise<void> {
		const config = this.deps.configService.getServerConfig();
		if(config.msgArrayLen === 0){
			console.log('msgArrayLen is 0, skipping chat history restore');
			return;
		}

		if(!this.deps.cacheService.existsRedisClient()){
			return;
		}

		try{
			const historyLoad = await this.deps.cacheService.getRedisValue(REDIS_HISTORY_KEY);

			if(!historyLoad){
				console.log('Empty Redis chat history load');
				return;
			}

			if(!isUnknownArray(historyLoad)){
				console.warn('Redis chat history value was not an array, starting fresh');
				return;
			}
			const now = Date.now();
			const expireTime = (config.msgArrayTimeout - 60) * 1000;

			const validMessages = parseArray(historyLoad, ChatPayloadSchema);
			const fresh = validMessages.filter(msg => msg.timestamp + expireTime > now);
			const trimmed = fresh.slice(-config.msgArrayLen);
			const trimmedMap = trimmed.map((msg): [ChatPayload['id'], ChatPayload] => [msg.id, msg]);
			this.chatHistory = new Map(trimmedMap);
			console.log(`Restored ${this.chatHistory.size} chat history messages from Redis`);
		}
		catch(error: unknown){
			handleError(error, 'Redis Message History Load');
		}
	}

	public async restoreMessageCounter(): Promise<void> {
		if(!this.deps.cacheService.existsRedisClient()){
			return;
		}

		try{
			const counterLoad = await this.deps.cacheService.getRedisValue(REDIS_COUNTER_KEY);
			if(counterLoad !== null){
				if(typeof counterLoad === 'number' && Number.isInteger(counterLoad) && counterLoad >= 0 && counterLoad <= MAX_INT){
					this.messageCounter = counterLoad;
					console.log(`Restored message id counter to ${counterLoad} from Redis`);
				}
				else{
					this.messageCounter = 0;
					console.warn('Redis message id counter load out of range or invalid, starting fresh');
				}
			}
			else{
				console.log('Empty Redis message id counter load');
			}
		}
		catch(error: unknown){
			handleError(error, 'Redis Message ID Counter Load');
		}
	}

	private sendPayload<Key extends ClientEventType>(to: Target, key: Key, ...args: Parameters<ToClient[Key]>): void {
		to.emit(key, ...args);
	}

	private createChatPayload(sys: false, author: Identity, content: string, eventtype: TextPayload, format: FormatType[], spoiler: boolean): ChatPayload;
	private createChatPayload(sys: true, author: string, content: string, eventtype: TextPayload, format: FormatType[], spoiler: boolean): ChatPayload;
	private createChatPayload(sys: boolean = false, author: Identity | string = 'system', content: string, eventtype: TextPayload, format: FormatType[] = [], spoiler: boolean = false): ChatPayload {
		return {
			id: sys? -1: this.generateMessageId(),
			author: typeof author === 'string' ? author : author.fullnick,
			content: content,
			timestamp: Date.now(),
			type: eventtype,
			format: format,
			spoiler: spoiler
		};
	}

	private generateMessageId(): ChatPayload['id'] {
		if(this.messageCounter >= MAX_INT || this.messageCounter < 0){
			this.messageCounter = 0;
		}
		const id = this.messageCounter++;
		this.counterQueue.chain();
		return id;
	}

	private trimChatHistory(): void {
		const msgArrayLen = this.deps.configService.getServerConfig().msgArrayLen;
		while (this.chatHistory.size > msgArrayLen){
			const oldestMessage = this.chatHistory.keys().next().value;
			if(oldestMessage !== undefined){
				this.chatHistory.delete(oldestMessage);
			}
		}
		this.historyQueue.chain();
	}

	private async saveChatHistory(): Promise<void> {
		if(!this.deps.cacheService.existsRedisClient()){
			return;
		}

		try {
			await this.deps.cacheService.setRedisValue(REDIS_HISTORY_KEY, [...this.chatHistory.values()]);
		}
		catch(error: unknown){
			handleError(error, 'Redis Message History Save');
		}
	}

	private async saveMessageCounter(): Promise<void> {
		if(!this.deps.cacheService.existsRedisClient()){
			return;
		}

		try{
			await this.deps.cacheService.setRedisValue(REDIS_COUNTER_KEY, this.messageCounter);
		}
		catch(error: unknown){
			handleError(error, 'Redis Message ID Counter Save');
		}
	}

	private startExpireMessageTimer(): void {
		const msgArrayTimeout = this.deps.configService.getServerConfig().msgArrayTimeout;
		setInterval(() => {
			const now = Date.now();
			const expireTime = (msgArrayTimeout - 60) * 1000;
			let changed = false;

			for(const [id, msg] of this.chatHistory){
				if(msg.timestamp + expireTime < now){
					this.chatHistory.delete(id);
					changed = true;
				}
			}

			if(changed){
				this.historyQueue.chain();
			}
		}, 60000);

	}
}
