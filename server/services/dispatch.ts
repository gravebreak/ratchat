import { Server, Socket } from 'socket.io';
import type { RedisClientType } from 'redis';

import { mType, eType } from '../../shared/schema';
import type { MessageType, UserSum, Identity, ChatMessage, GameEvent, GameEventType } from '../../shared/schema';

import { getDisplayNick } from '../utils/format';
import { createSaveQueue } from '../utils/queue';
import { handleError } from '../utils/errors';

type Target = { emit: Server['emit'] };
type TextPayload = typeof mType.chat | typeof mType.ann | typeof mType.error | typeof mType.info | typeof mType.welcome | typeof mType.markov;
type EmotePayload = Record<string, string>;
type EventPayload = GameEventType[];
type ChatHistory = Map<number, ChatMessage>;
type MessagePayloadMap = {
	[T in MessageType]:
		T extends typeof mType.game ? GameEvent :
		T extends typeof mType.identity ? Identity :
		T extends typeof mType.ulist ? UserSum[] :
		T extends typeof mType.elist ? EventPayload :
		T extends typeof mType.emotelist ? EmotePayload :
		T extends typeof mType.delmsg ? number[] :
		T extends typeof mType.clrlocal ? string :
		ChatMessage;
};

const REDIS_HISTORY_KEY = 'ratchat:chatHistory';
const REDIS_COUNTER_KEY = 'ratchat:messageCounter';
const MAX_INT = 4294967295;

export interface DispatchServiceDependencies {
	redisClient: RedisClientType | null;
	redisTTL: number;
}

export class DispatchService{
	private messageCounter = 0; 
	private chatHistory : ChatHistory = new Map();
	private historyQueue = createSaveQueue(() => this.saveChatHistory());
	private counterQueue = createSaveQueue(() => this.saveMessageCounter());

	private deps: DispatchServiceDependencies;
	constructor(dependencies: DispatchServiceDependencies){
		  this.deps = dependencies;
	}

	public sendChat(to: Target, author: Identity, content:string, msgArrayLen: number, spoiler: boolean){
		const msg = this.createMessage(false, author, content, mType.chat, spoiler);
		this.sendPayload(to, mType.chat, msg);
		if(msgArrayLen > 0){
			this.chatHistory.set(msg.id, msg);
			this.trimChatHistory(msgArrayLen);
		}
	}

	public sendChatHistory(to: Target){
		for (const [, msg] of this.chatHistory){
			this.sendPayload(to, mType.chat, msg);
		}
	}

	public sendSystemChat(to: Target, type: TextPayload, text: string){
		this.sendPayload(to, type, this.createMessage(true,'system',text, type, false));
	}

	public sendMarkovChat(to: Target, text: string, markov: Identity, user: Identity, seed?: string){
		const payload = `${getDisplayNick(user.nick)}|${seed}|${text}`;
		this.sendPayload(to, mType.markov, this.createMessage(false,markov, payload, mType.markov, false));
	}

	public sendGameEvent(to: Target, content: string, event: GameEventType){
		const payload: GameEvent = {
			content: content,
			timestamp: Date.now(),
			event: event
		};
		this.sendPayload(to, mType.game, payload);
	}

	public sendIdentity(to: Target, identity: Identity){
		this.sendPayload(to, mType.identity, identity);
	}

	public sendEmoteList(to: Target, emotes: EmotePayload){
		this.sendPayload(to, mType.emotelist, emotes);
	}

	public sendUserList(to: Target, users: UserSum[]){
		this.sendPayload(to, mType.ulist, users);
	}

	public sendEventList(to: Target){
		this.sendPayload(to, mType.elist, Object.values(eType));
	}

	public sendClearLocalData(to: Target, guid: string){
		this.sendPayload(to, mType.clrlocal, guid);
	}

	public sendUserError(to: Socket, error: unknown, prefix: string){
		const response = handleError(error, prefix);
		if(response){
			this.sendSystemChat(to, mType.error, `system: ${response}`);
		} 
		else{
			this.sendSystemChat(to, mType.error, `system: unknown error. try again`);
		}
	}

	public deleteMessage(io: Server, msgArray: number[]){
		const deleted: number[] = [];

		this.sendPayload(io, mType.delmsg, msgArray);

		msgArray.forEach(id => { 
			if(this.chatHistory.delete(id)){
				deleted.push(id);
			}
		});
		if(deleted.length > 0){
			this.historyQueue.chain();
		}
		return;
	}

	public getChatHistory(): ChatHistory{
		return this.chatHistory;
	}

	public async restoreChatHistory(msgArrayLen: number, msgArrayTimeout: number){
		if(!this.deps.redisClient){
			return;
		}

		try{
			const historyLoad = await this.deps.redisClient.get(REDIS_HISTORY_KEY);
			if(historyLoad){
				const now = Date.now();
				const expireTime = (msgArrayTimeout - 60) * 1000;
				const entries: [number, ChatMessage][] = JSON.parse(historyLoad);
				const fresh = entries.filter(([, msg]) => msg.timestamp + expireTime > now);
				const trimmed = fresh.slice(-msgArrayLen);
				this.chatHistory = new Map(trimmed);
				console.log(`Restored ${this.chatHistory.size} messages from Redis`);
			}
			else{
				console.log('Empty Redis chat history load');
			}
		}
		catch(error: unknown){
			handleError(error, 'Redis Message History Load');
		}
	}
	
	public async restoreMessageCounter(){
		if(!this.deps.redisClient){
			return;
		}

		try{
			const counterLoad = await this.deps.redisClient.get(REDIS_COUNTER_KEY);
			if(counterLoad){
				const parsedLoad = parseInt(counterLoad, 10);
				if(!isNaN(parsedLoad) && parsedLoad >= 0 && parsedLoad <= MAX_INT){
					this.messageCounter = parsedLoad;
					console.log(`Restored message id counter to ${parsedLoad} from Redis`);
				}
				else{
					this.messageCounter = 0;
					console.warn(`Redis message id counter ${parsedLoad} out of range, starting fresh`);
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
	
	public disableRedis(){
		this.deps.redisClient = null;
	}

	public startExpireMessageTimer(msgArrayTimeout: number){
		this.expireMessageTimer(msgArrayTimeout);
	}

	private sendPayload<T extends MessageType>(to: Target, metype: T, msg: MessagePayloadMap[T]){
		to.emit(metype, msg);
	}

	private createMessage(sys: false, author: Identity, content: string, metype: TextPayload, spoiler: boolean): ChatMessage;
	private createMessage(sys: true, author: string, content: string, metype: TextPayload, spoiler: boolean): ChatMessage;
	private createMessage(sys: boolean = false, author: Identity | string = 'system', content: string, metype: TextPayload, spoiler: boolean = false): ChatMessage {
		return {
			id: sys? -1: this.generateMessageId(),
			author: typeof author === 'string' ? author : author.nick,
			content: content,
			timestamp: Date.now(),
			type: metype,
			spoiler: spoiler
		};
	}

	private generateMessageId(): number {
		if(this.messageCounter >= MAX_INT || this.messageCounter < 0){
			this.messageCounter = 0;
		}
		const id = this.messageCounter++;
		this.counterQueue.chain();
		return id;
	}

	private trimChatHistory(msgArrayLen: number){
		while (this.chatHistory.size > msgArrayLen){
			const oldestMessage = this.chatHistory.keys().next().value;
			if(oldestMessage !== undefined){
				this.chatHistory.delete(oldestMessage);
			}
		}
		this.historyQueue.chain();
	}

	private async saveChatHistory(){
		if(!this.deps.redisClient){
				return;
		}
		try {
			await this.deps.redisClient.set(REDIS_HISTORY_KEY, JSON.stringify([...this.chatHistory.entries()]), { EX: this.deps.redisTTL });
		} 
		catch(error: unknown){
			handleError(error, 'Redis Message History Save');
		}
	}

	private async saveMessageCounter(){
		if(!this.deps.redisClient){
				return;
		}
		try {
			await this.deps.redisClient.set(REDIS_COUNTER_KEY, this.messageCounter.toString(), { EX: this.deps.redisTTL });
		} 
		catch(error: unknown){
			handleError(error, 'Redis Message ID Counter Save');
		}
	}

	private expireMessageTimer(msgArrayTimeout: number){
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
