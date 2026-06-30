import { Server, Socket } from 'socket.io';

import { mType, Identity } from '../../shared/schema';

import { DispatchService } from './dispatch';
import { StateService } from './state';
import { ModerationService } from './moderation';
import { IdentityService } from './identity';
import { MarkovService } from './markov';
import { handleError } from '../utils/errors';

const clearInput: boolean = true;
const keepInput: boolean = false;

export interface MessageServiceDependencies {
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
		let safe = '';
		try{
			safe = this.deps.moderationService.textCheck(msg, user, 'chat');
			this.deps.dispatchService.sendChat(this.deps.io, user, safe, this.deps.stateService.getServerConfig().msgArrayLen, spoiler);			
		}
		catch(error: unknown){
			const response = handleError(error, 'handleChat text check');
			if(response){
				this.deps.dispatchService.sendSystemChat(socket, mType.error, `system: ${response}`);
			} 
			else{
				this.deps.dispatchService.sendSystemChat(socket, mType.error, `system: unknown error. try again`);
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
		if(this.deps.markovService && this.deps.stateService.getMarkovConfig().learning){
			queueMicrotask(async () => {
				try{
					if(safe){
						await this.deps.markovService!.markovLearn(safe);
					}
				}
				catch(error: unknown){
					handleError(error, 'handleChat Markov Learn');
				}	
			});
		}
		return clearInput;
	}
}