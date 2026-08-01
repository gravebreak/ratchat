import {clearInput, keepInput} from '../defs/def-input';
import type {RatServer, RatSocket, FormatType} from '../defs/def-events';
import type {Identity} from '../defs/def-identity';
import type {InputStatus} from '../defs/def-input';

import {ConfigService} from './config';
import {DispatchService} from './dispatch';
import {ModerationService} from './moderation';
import {IdentityService} from './identity';
import {StateService} from './state';
import {MarkovService} from './markov';

import {handleError} from '../utils/errors';

export interface MessageServiceDependencies {
	configService: ConfigService;
	dispatchService: DispatchService;
	stateService: StateService;
	moderationService: ModerationService;
	identityService: IdentityService;
	markovService: MarkovService | null;

	io: RatServer;
}

export class MessageService {
	private deps: MessageServiceDependencies;
	constructor(dependencies: MessageServiceDependencies){
		this.deps = dependencies;
	}

	public handleChat(msg: string, user: Identity, socket: RatSocket, format: FormatType[], spoiler: boolean): InputStatus {
		try{
			const safe = this.deps.moderationService.moderateText(msg, user, 'chat');
			this.deps.dispatchService.sendChatPayload(this.deps.io, user, safe, format, spoiler);

			if(this.deps.markovService && this.deps.configService.getMarkovConfig().learning){
				const markov = this.deps.markovService;
				queueMicrotask(async () => {
					try{
						await markov.incrementMarkovText(safe);
					}
					catch(error: unknown){
						handleError(error, 'handleChat Learn Markov');
					}
				});
			}
		}
		catch(error: unknown){
			this.deps.dispatchService.sendUserErrorMessage(socket, error, 'handleChat text check');
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
