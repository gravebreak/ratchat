import { readFileSync } from "fs";

import type { Identity, TimeType, TextType } from "../../shared/schema.ts";

import { StateService } from "./state";
import { textSanitize, isValidHexColor } from "../utils/input.js";

export type SafeString = string & {__brand: 'SafeString'};

export interface ModerationServiceDependencies{
	stateService: StateService;

	nickFilterPath: string;
	profFilterPath: string;
}


export class ModerationService {
	private profFilter: RegExp[] = [];
	private nickFilter: RegExp[] = [];

	private deps: ModerationServiceDependencies;
	constructor(dependencies: ModerationServiceDependencies){
		this.deps = dependencies;
		this.loadFilters(); 
	}

	public textCheck(raw: string, user: Identity, type: TextType): SafeString{
		const clean = textSanitize(raw).trim();
		if(type === 'chat'){
			if(clean.length > this.deps.stateService.getServerConfig().maxMsgLen){
				throw new Error('sorry your message is too long lmao')
			}
			if(clean.length < 1){
				throw new Error('no content in message, try resending with ASCII only')
			}
			try{
				this.profCheck(clean);
				this.timeCheck(user, 'chat')
			}
			catch(error: unknown){
				if(error instanceof Error){
					throw error;
				} 
				else{
					console.error("Unexpected non-error thrown:", error);
					throw new Error("Unknown error")
				}
			}
			const safe = this.toSafeString(clean)
			return safe;
		}
		else if(type === 'status'){
			if(clean.length > this.deps.stateService.getServerConfig().maxStatusLen){
				throw new Error('tl;dr - set something shorter')
			}
			try{
				this.profCheck(clean);
				this.timeCheck(user, 'other')
			}
			catch(error: unknown){
				if(error instanceof Error){
					throw error;
				} 
				else{
					console.error("Unexpected non-error thrown:", error);
					throw new Error("Unknown error")
				}
			}
			const safe = this.toSafeString(clean)
			return safe;
		}
		else if(type === 'nick'){
			if(clean.length > this.deps.stateService.getServerConfig().maxNickLen || clean.length < 2){
				throw new Error(`nickname must be between 2 and ${this.deps.stateService.getServerConfig().maxNickLen} characters`);
			}
			if(/\s/.test(clean)){
				throw new Error('no spaces in usernames');
			}
			try{
				this.nickCheck(clean);
				this.timeCheck(user, 'nick')
			}
			catch(error: unknown){
				if(error instanceof Error){
					throw error;
				} 
				else{
					console.error("Unexpected non-error thrown:", error);
					throw new Error("Unknown error")
				}
			}
			const safe = this.toSafeString(clean)
			return safe;
		}
		else if(type === 'color'){

			if(!isValidHexColor(clean)){
				throw new Error('invalid hex code. please use format #RRGGBB');
			}

			try{
				this.timeCheck(user, 'other');
			}
			catch(error: unknown){
				if(error instanceof Error){
					throw error;
				} 
				else{
					console.error("Unexpected non-error thrown:", error);
					throw new Error("Unknown error")
				}
			}
			const safe = this.toSafeString(clean)
			return safe;
		}
		else{
			throw new Error('text type error');
		}		
	}

	public textCheckNewUser(raw: string, type: TextType): SafeString{
		const clean = textSanitize(raw).trim();
		if(type === 'nick'){
			if(clean.length > this.deps.stateService.getServerConfig().maxNickLen || clean.length < 2){
				throw new Error(`nickname must be between 2 and ${this.deps.stateService.getServerConfig().maxNickLen} characters`);
			}
			if(/\s/.test(clean)){
				throw new Error('no spaces in usernames');
			}
			try{
				this.nickCheck(clean);
			}
			catch(error: unknown){
				if(error instanceof Error){
					throw error;
				} 
				else{
					console.error("Unexpected non-error thrown:", error);
					throw new Error("Unknown error")
				}
			}
			const safe = this.toSafeString(clean)
			return safe;
		}
		else{
			throw new Error('text type error');
		}		
	}
		
	public timeCheck(user: Identity, type: TimeType){
		const now = Date.now();
		const lastMessage = new Date(user.lastMessage).getTime();
		const lastChanged = new Date(user.lastChanged).getTime();

		if(lastMessage > now){
			throw new Error ('ur in timeout rn');
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
		const waitTime = ((last + limits[type]) - now) /1000

		if(waitTime > 0){
			throw new Error(`you're doing that too fast, wait ${Math.ceil(waitTime)} seconds.`)
		}

		return;

	}
	
	private toSafeString(str: string): SafeString{
		return str as SafeString
	}

	private nickCheck(nick: string){
		
		const matched = this.nickFilter.find(regex => regex.test(nick));
		if(matched){
			console.log(`nick filter "${nick}" because it matched pattern: ${matched}`);
			throw new Error(`can't be named that`);
		}

		return;
	}

	private profCheck(str: string){
		
		const matched = this.profFilter.find(regex => regex.test(str));
		if(matched){
			console.log(`prof filter "${str}" because it matched pattern: ${matched}`)
			throw new Error('watch your profamity')
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
				configLoad.push(`^${this.deps.stateService.markovUser.nick}$`)
			}

			const nickFilter = [...nickLoad, ...configLoad].filter(Boolean);

			this.nickFilter = [
				...nickFilter.map(pattern => new RegExp(pattern, 'i')),
				...this.profFilter
			];
		} 
		catch(error: unknown){
			console.error('WARNING: nick filter load issue:', error);
			this.nickFilter = [];
		}
	};
}