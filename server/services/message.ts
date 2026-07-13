import { Server, Socket } from 'socket.io';

import { clearInput, keepInput } from '../defs/def-input';
import { mType } from '../defs/def-message';
import type { Identity } from '../defs/def-identity';

import { ConfigService } from './config';
import { DispatchService } from './dispatch';
import { ModerationService } from './moderation';
import { IdentityService } from './identity';
import { StateService } from './state';
import { MarkovService } from './markov';

import { handleError } from '../utils/errors';

export interface MessageServiceDependencies {
	configService: ConfigService;
	dispatchService: DispatchService;
	stateService: StateService;
	moderationService: ModerationService;
	identityService: IdentityService;
	markovService: MarkovService | null;

	io: Server;
}

export class MessageService {
	private deps: MessageServiceDependencies;
	constructor(dependencies: MessageServiceDependencies){
		this.deps = dependencies;
	}

	public handleChat(msg: string, user: Identity, socket: Socket, spoiler: boolean): boolean{
		try{
			const safe = this.deps.moderationService.moderateText(msg, user, 'chat');
			this.deps.dispatchService.sendChat(this.deps.io, user, safe, spoiler);

			if(this.deps.markovService && this.deps.configService.getMarkovConfig().learning){
				const markov = this.deps.markovService;
				queueMicrotask(async () => {
					try{
						await markov.learnMarkovText(safe);
					}
					catch(error: unknown){
						handleError(error, 'handleChat Learn Markov');
					}	
				});
			}		
		}
		catch(error: unknown){
			const response = handleError(error, 'handleChat text check');
			if(response){
				this.deps.dispatchService.sendSystemChat(socket, mType.error, `system: ${response}`);
			} 
			else{
				this.deps.dispatchService.sendSystemChat(socket, mType.error, 'system: unknown error. try again');
			}
			return keepInput;
		}
		try{
			const wasAfk = user.isAfk;
			this.deps.identityService.setLastMessage(user.guid, Date.now());
			if(wasAfk){
				this.deps.stateService.broadcastUsers(this.deps.io);
			}
		} 
		catch(error: unknown){
			handleError(error, 'handleChat Last Message');
		}
		return clearInput;
	}
}