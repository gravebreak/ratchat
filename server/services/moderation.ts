import { readFileSync } from "fs";

import type { Identity, TimeType, TextType } from "../../shared/schema.ts";

import { StateService } from "./state";
import { textSanitize, isValidHexColor } from "../utils/input.js";
import { handleError, AppError } from "../utils/errors.js";

export type SafeString = string & {__brand: 'SafeString'};

export interface ModerationServiceDependencies{
	stateService: StateService;

	nickFilterPath: string;
	profFilterPath: string;
	clientCommands: string[];
	clientSubCommands: string[];
}

export class ModerationService {
	private profFilter: RegExp[] = [];
	private nickFilter: RegExp[] = [];
	private startup: boolean = true;

	private deps: ModerationServiceDependencies;
	constructor(dependencies: ModerationServiceDependencies){
		this.deps = dependencies;
		this.loadFilters(); 
	}

	public textCheck(raw: string, user: Identity, type: TextType): SafeString{
		const clean = textSanitize(raw).trim();
		let safe = this.toSafeString('');
		switch(type){
			case 'chat':
				if(clean.length > this.deps.stateService.getServerConfig().maxMsgLen){
					throw new AppError('sorry your message is too long lmao', 'user');
				}
				if(clean.length < 1){
					throw new AppError('no content in message, try resending with ASCII only', 'user');
				}
				try{
					this.profCheck(clean);
					this.timeCheck(user, 'chat');
				}
				catch(error: unknown){
					if(error instanceof AppError){
						throw error;
					}
					handleError(error, 'Text Check - Chat');
					
					throw new AppError(`failed validate your message: unknown error`, 'user');
				}
				safe = this.toSafeString(clean);
				return safe;
			case 'status':
				if(clean.length > this.deps.stateService.getServerConfig().maxStatusLen){
					throw new AppError('tl;dr - set something shorter', 'user');
				}
				try{
					this.profCheck(clean);
					this.timeCheck(user, 'other');
				}
				catch(error: unknown){
					if(error instanceof AppError){
						throw error;
					}
					handleError(error, 'Text Check - Status');
					
					throw new AppError(`failed validate your message: unknown error`, 'user');
				}
				safe = this.toSafeString(clean);
				return safe;

			case'nick':
				if(clean.length > this.deps.stateService.getServerConfig().maxNickLen || clean.length < 2){
					throw new AppError(`nickname must be between 2 and ${this.deps.stateService.getServerConfig().maxNickLen} characters`, 'user');
				}
				if(/\s/.test(clean)){
					throw new AppError('no spaces in usernames', 'user');
				}
				try{
					this.nickCheck(clean);
					this.timeCheck(user, 'nick');
				}
				catch(error: unknown){
					if(error instanceof AppError){
						throw error;
					}
					handleError(error, 'Text Check - Nick');
					
					throw new AppError(`failed validate your message: unknown error`, 'user');
				}
				safe = this.toSafeString(clean);
				return safe;
			
			case 'color':
				if(!isValidHexColor(clean)){
					throw new AppError('invalid hex code. please use format #RRGGBB', 'user');
				}

				try{
					this.timeCheck(user, 'other');
				}
				catch(error: unknown){
					if(error instanceof AppError){
						throw error;
					}
					handleError(error, 'Text Check - Color');
					
					throw new AppError(`failed validate your message: unknown error`, 'user');
				}
				safe = this.toSafeString(clean);
				return safe;
			
			default:
				throw new AppError('textcheck text type missing', 'bug');
		}
	}

	public textCheckNewUser(raw: string, type: TextType): SafeString{
		const clean = textSanitize(raw).trim();
		if(type === 'nick'){
			if(clean.length > this.deps.stateService.getServerConfig().maxNickLen || clean.length < 2){
				throw new AppError(`nickname must be between 2 and ${this.deps.stateService.getServerConfig().maxNickLen} characters`, 'user');
			}
			if(/\s/.test(clean)){
				throw new AppError('no spaces in usernames', 'user');
			}
			try{
				this.nickCheck(clean);
			}
				catch(error: unknown){
					if(error instanceof AppError){
						throw error;
					}
					handleError(error, 'Text Check New User');
					
					throw new AppError(`failed validate your nickname: unknown error`, 'user');
				}
			const safe = this.toSafeString(clean);
			return safe;
		}
		else{
			throw new AppError('textchecknewuser text type missing', 'bug');
		}		
	}
		
	public timeCheck(user: Identity, type: TimeType){
		const now = Date.now();
		const lastMessage = new Date(user.lastMessage).getTime();
		const lastChanged = new Date(user.lastChanged).getTime();

		if(lastMessage > now){
			throw new AppError ('ur in timeout rn', 'user');
		}
		
		const serverConfig = this.deps.stateService.getServerConfig();
		const gameConfig = this.deps.stateService.getGameConfig();
		const limits: Record<TimeType, number> = {
			chat: serverConfig.slowMode * 1000,
			nick: serverConfig.nickSlow * 1000,
			joinleave: serverConfig.otherSlow * 1000,
			game: gameConfig.gameSlow * 1000,
			other: serverConfig.otherSlow * 1000,
		};

		const last = type === "chat" || type === "joinleave" ? lastMessage : lastChanged;
		const waitTime = ((last + limits[type]) - now) /1000;

		if(waitTime > 0){
			throw new AppError(`you're doing that too fast, wait ${Math.ceil(waitTime)} seconds.`, 'user');
		}

		return;

	}

	public addToNickFilter(commands: string[]){
		if(!this.startup){
			throw new AppError('No longer starting up, illegal addToNickFilter call', 'bug');
		}
		const added = commands.map(cmd => new RegExp(`^${cmd}$`, 'i')); //exact commands only
		this.nickFilter.push(...added);
		this.startup = false;
	}
	
	
	private toSafeString(str: string): SafeString{
		return str as SafeString;
	}

	private nickCheck(nick: string){
		
		const matched = this.nickFilter.find(regex => regex.test(nick));
		if(matched){
			console.log(`nick filter "${nick}" because it matched pattern: ${matched}`);
			throw new AppError(`can't be named that`, 'user');
		}

		return;
	}

	private profCheck(str: string){
		
		const matched = this.profFilter.find(regex => regex.test(str));
		if(matched){
			console.log(`prof filter "${str}" because it matched pattern: ${matched}`);
			throw new AppError('watch your profamity', 'user');
		}
		
		return;
	}

	private loadFilters(){
		try{
			const nickLoad = JSON.parse(readFileSync(this.deps.nickFilterPath, 'utf-8')).usernames || [];
			const profLoad = JSON.parse(readFileSync(this.deps.profFilterPath, 'utf-8'));
			this.profFilter = Array.isArray(profLoad)
				? profLoad
						.filter(item => item.tags?.includes('racial') && item.severity > 2)
						.map(item => {
							const pattern = '\\b' +	item.match.split('*').map((seg: string) => seg.replace(/([a-zA-Z0-9.])(?=[a-zA-Z0-9.])/g, '$1[\\s\\-_.]*')).join('[^a-zA-Z0-9]*') + '\\b';
							const regex = new RegExp(pattern, 'i');
							return regex;
						})
				: [];
			const configLoad = [...(this.deps.stateService.getServerConfig().nickres || [])];
			if(this.deps.stateService.getMarkovConfig().enabled && this.deps.stateService.markovUser){
				configLoad.push(`^${this.deps.stateService.markovUser.nick}$`);
			}

			const nickFilter = [...nickLoad, ...configLoad].filter(Boolean);

			this.nickFilter = [
				...nickFilter.map(pattern => new RegExp(pattern, 'i')),
				...this.profFilter,
				...this.deps.clientCommands.map(cmd => new RegExp(`^${cmd}$`, 'i')), //exact commands only
				...this.deps.clientSubCommands.map(cmd => new RegExp(`^${cmd}$`, 'i')) 
			];
		} 
		catch(error: unknown){
			handleError(error, 'Nick Filter Load');
			this.nickFilter = [];
			this.profFilter = [];
		}
	};
}