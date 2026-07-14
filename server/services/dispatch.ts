import { Server, Socket } from 'socket.io';

import { mType, eType, ChatMessageSchema } from '../defs/def-message';
import type { UserSum, Identity } from '../defs/def-identity';
import type { MessageType, ChatMessage, GameEvent, GameEventType } from '../defs/def-message';

import { CacheService } from './cache';
import { ConfigService } from './config';

import { handleError } from '../utils/errors';
import { getBaseNick } from '../utils/format';
import { parseArray, isUnknownArray } from '../utils/parse';
import { createSaveQueue } from '../utils/queue';

type Target = { emit: Server['emit'] };
type TextPayload = typeof mType.chat | typeof mType.ann | typeof mType.error | typeof mType.info | typeof mType.welcome | typeof mType.markov;
type EmotePayload = Record<string, string>;
type EventPayload = GameEventType[];
type ChatHistory = Map<ChatMessage['id'], ChatMessage>;
type MessagePayloadMap = {
	[MType in MessageType]:
		MType extends typeof mType.game ? GameEvent :
		MType extends typeof mType.identity ? Identity :
		MType extends typeof mType.ulist ? UserSum[] :
		MType extends typeof mType.elist ? EventPayload :
		MType extends typeof mType.emotelist ? EmotePayload :
		MType extends typeof mType.delmsg ? ChatMessage['id'][] :
		MType extends typeof mType.clrlocal ? Identity['guid'] :
		ChatMessage;
};

const REDIS_HISTORY_KEY = CacheService.createRedisKey('messageHistory');
const REDIS_COUNTER_KEY = CacheService.createRedisKey('messageCounter');
const MAX_INT = 4294967295;

export interface DispatchServiceDependencies {
	cacheService: CacheService
	configService: ConfigService;
}

export class DispatchService{
	private messageCounter: ChatMessage['id'] = 0; 
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

	public sendChat(to: Target, author: Identity, content:string, spoiler: boolean): void {
		const msg = this.createMessage(false, author, content, mType.chat, spoiler);
		this.sendPayload(to, mType.chat, msg);
		const msgArrayLen = this.deps.configService.getServerConfig().msgArrayLen;
		if(msgArrayLen > 0){
			this.chatHistory.set(msg.id, msg);
			this.trimChatHistory();
		}
	}

	public sendChatHistory(to: Target): void {
		for (const [, msg] of this.chatHistory){
			this.sendPayload(to, mType.chat, msg);
		}
	}

	public sendSystemChat(to: Target, type: TextPayload, text: string): void {
		this.sendPayload(to, type, this.createMessage(true,'system',text, type, false));
	}

	public sendMarkovChat(to: Target, text: string, markov: Identity, user: Identity, seed?: string): void {
		const payload = `${getBaseNick(user.fullnick)}|${seed}|${text}`;
		this.sendPayload(to, mType.markov, this.createMessage(false,markov, payload, mType.markov, false));
	}

	public sendGameEvent(to: Target, content: string, event: GameEventType): void {
		const payload: GameEvent = {
			content: content,
			timestamp: Date.now(),
			event: event
		};
		this.sendPayload(to, mType.game, payload);
	}

	public sendIdentity(to: Target, identity: Identity): void {
		this.sendPayload(to, mType.identity, identity);
	}

	public sendEmoteList(to: Target, emotes: EmotePayload): void {
		this.sendPayload(to, mType.emotelist, emotes);
	}

	public sendUserList(to: Target, users: UserSum[]): void {
		this.sendPayload(to, mType.ulist, users);
	}

	public sendEventList(to: Target): void {
		this.sendPayload(to, mType.elist, Object.values(eType));
	}

	public sendClearLocalData(to: Target, guid: Identity['guid']): void {
		this.sendPayload(to, mType.clrlocal, guid);
	}

	public sendUserError(to: Socket, error: unknown, prefix: string): void {
		const response = handleError(error, prefix);
		if(response){
			this.sendSystemChat(to, mType.error, `system: ${response}`);
		} 
		else{
			this.sendSystemChat(to, mType.error, 'system: unknown error. try again');
		}
	}

	public deleteMessage(io: Server, msgArray: ChatMessage['id'][]): void {
		const deleted: ChatMessage['id'][] = [];

		this.sendPayload(io, mType.delmsg, msgArray);

		msgArray.forEach(id => { 
			if(this.chatHistory.delete(id)){
				deleted.push(id);
			}
		});

		if(deleted.length > 0){
			this.historyQueue.chain();
		}
	}

	public getChatHistory(): ChatHistory {
		return this.chatHistory;
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

			const validMessages = parseArray(historyLoad, ChatMessageSchema);
			const fresh = validMessages.filter(msg => msg.timestamp + expireTime > now);
			const trimmed = fresh.slice(-config.msgArrayLen);
			const trimmedMap = trimmed.map((msg): [ChatMessage['id'], ChatMessage] => [msg.id, msg]);
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

	private sendPayload<MType extends MessageType>(to: Target, metype: MType, msg: MessagePayloadMap[MType]): void {
		to.emit(metype, msg);
	}

	private createMessage(sys: false, author: Identity, content: string, metype: TextPayload, spoiler: boolean): ChatMessage;
	private createMessage(sys: true, author: string, content: string, metype: TextPayload, spoiler: boolean): ChatMessage;
	private createMessage(sys: boolean = false, author: Identity | string = 'system', content: string, metype: TextPayload, spoiler: boolean = false): ChatMessage {
		return {
			id: sys? -1: this.generateMessageId(),
			author: typeof author === 'string' ? author : author.fullnick,
			content: content,
			timestamp: Date.now(),
			type: metype,
			spoiler: spoiler
		};
	}

	private generateMessageId(): ChatMessage['id'] {
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
