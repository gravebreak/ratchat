import { Server } from 'socket.io';
import type { RedisClientType } from 'redis';

import { mType } from '../../shared/schema';
import type { MessageType, UserSum, Identity, ChatMessage } from '../../shared/schema';

import { getDisplayNick } from '../utils/format';

type Target = { emit: Server['emit'] };
type TextPayload = typeof mType.chat | typeof mType.ann | typeof mType.error | typeof mType.info | typeof mType.welcome | typeof mType.markov;
type EmotePayload = Record<string, string>;
type ChatHistory = Map<number, ChatMessage>;
type MessagePayloadMap = {
	[T in MessageType]: 
		T extends typeof mType.identity ? Identity :
		T extends typeof mType.ulist ? UserSum[] :
		T extends typeof mType.delmsg ? number[] :
		T extends typeof mType.emote ? EmotePayload :
		ChatMessage;
};

const REDIS_HISTORY_KEY = 'ratchat:chatHistory';
const REDIS_COUNTER_KEY = 'ratchat:messageCounter';

export interface MessageServiceDependencies {
	redisClient: RedisClientType | null;
	redisTTL: number;
}

export class MessageService{
	private messageCounter = 0; 
	private chatHistory : ChatHistory = new Map();
	private historyQ = Promise.resolve();
	private counterQ = Promise.resolve();

	private deps: MessageServiceDependencies;
	constructor(dependencies: MessageServiceDependencies){
		  this.deps = dependencies;
	}

	public sendChat(to: Target, author: Identity, content:string, msgArrayLen: number){
		const msg = this.createMessage(false, author, content, mType.chat);
		this.sendPayload(to, mType.chat, msg);
		if(msgArrayLen > 0){
			this.chatHistory.set(msg.id, msg);
			this.trimChatHistory(msgArrayLen);
		}
	}

	public sendSystemChat(to: Target, type: TextPayload, text: string){
		this.sendPayload(to, type, this.createMessage(true,'system',text, type));
	}

	public sendMarkovChat(to: Target, text: string, markov: Identity, user: Identity, seed?: string){
		const payload = `${getDisplayNick(user.nick)}|${seed}|${text}`;
		this.sendPayload(to, mType.markov, this.createMessage(false,markov, payload, mType.markov))
	}

	public sendChatHistory(to: Target){
		for (const [, msg] of this.chatHistory){
			this.sendPayload(to, mType.chat, msg);
		}
	}

	public sendIdentity(to: Target, identity: Identity){
		this.sendPayload(to, mType.identity, identity);
	}

	public sendEmoteList(to: Target, emotes: EmotePayload){
		this.sendPayload(to, mType.emote, emotes);
	}

	public sendUserList(to: Target, users: UserSum[]){
		this.sendPayload(to, mType.ulist, users);
	}
	
	public deleteMessage(io: Server, msgArray: number[]): number[] {
		const deleted: number[] = [];

		this.sendPayload(io, mType.delmsg, msgArray);

		msgArray.forEach(id => { 
			if(this.chatHistory.delete(id)){
				deleted.push(id);
			}
		});
		if(deleted.length > 0){
			this.saveChatHistoryQueue();
		}
		return deleted;
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
			if(error instanceof Error){
				console.warn('Redis chat history load error:', error.message);
			}
			else{
				console.error('Unexpected non-error thrown:', error);
			}
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
				if(!isNaN(parsedLoad) && parsedLoad >= 0 && parsedLoad <= 4294967295){
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
			if(error instanceof Error){
				console.warn('Redis message id counter load error:', error.message);
			}
			else{
				console.error('Unexpected non-error thrown:', error);
			}
		}
	}
	
	public messageRedisFallback(){
		this.deps.redisClient = null;
	}

	public startExpireMessageTimer(msgArrayTimeout: number){
		this.expireMessageTimer(msgArrayTimeout);
	}


	private sendPayload<T extends MessageType>(to: Target, metype: T, msg: MessagePayloadMap[T]){
		to.emit(metype, msg);
	}

	private createMessage(sys: false, author: Identity, content: string, metype: TextPayload): ChatMessage;
	private createMessage(sys: true, author: string, content: string, metype: TextPayload): ChatMessage;
	private createMessage(sys: boolean = false, author: Identity | string = 'system', content: string, metype: TextPayload): ChatMessage {
		return {
			id: sys? -1: this.generateMessageId(),
			author: typeof author === 'string' ? author : author.nick,
			content: content,
			timestamp: Date.now(),
			type: metype
		};
	}

	private generateMessageId(): number {
		if(this.messageCounter >= 4294967295 || this.messageCounter < 0){
			this.messageCounter = 0;
		}
		const id = this.messageCounter++;
		this.saveMessageCounterQueue();
		return id;
	}

	private trimChatHistory(msgArrayLen: number){
		while (this.chatHistory.size > msgArrayLen){
			const oldestMessage = this.chatHistory.keys().next().value;
			if(oldestMessage !== undefined){
				this.chatHistory.delete(oldestMessage);
			}
		}
		this.saveChatHistoryQueue();
	}

	private saveChatHistoryQueue(){
		this.historyQ = this.historyQ.then(() => this.saveChatHistory());
	}

	private saveMessageCounterQueue(){
		this.counterQ = this.counterQ.then(() => this.saveMessageCounter());
	}

	private async saveChatHistory(){
		if(!this.deps.redisClient){
				return;
		}
		try {
			await this.deps.redisClient.set(REDIS_HISTORY_KEY, JSON.stringify([...this.chatHistory.entries()]), { EX: this.deps.redisTTL });
		} 
		catch(error: unknown){
			if(error instanceof Error){
				console.warn('Redis message history save error:', error.message);
			} 
			else{
				console.error('Unexpected non-error thrown:', error);
			}
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
			if(error instanceof Error){
				console.warn('Redis message counter save error:', error.message);
			} 
			else{
				console.error('Unexpected non-error thrown:', error);
			}
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
				this.saveChatHistoryQueue();
			}
		}, 60000);	

	}
}
