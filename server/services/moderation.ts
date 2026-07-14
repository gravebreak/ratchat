import { ProfanityFilterEntrySchema } from '../defs/def-moderation';
import type { Identity } from '../defs/def-identity';
import type { TimeType, TextType } from '../defs/def-moderation';

import { ConfigService } from './config';

import { handleError, AppError } from '../utils/errors';
import { isUnknownArray, parseArray } from '../utils/parse';
import { sanitizeText } from '../utils/sanitize';
import { existsFile, readJsonFile } from '../utils/serialize';
import { isValidHexColor } from '../utils/validate';

export type SafeString = string & {readonly __brand: 'SafeString'};

export interface ModerationServiceDependencies{
	configService: ConfigService;

	basenickFilterPath: string;
	profFilterPath: string;
	clientCommands: string[];
	clientSubCommands: string[];
}

export class ModerationService {
	private profFilter: RegExp[] = [];
	private basenickFilter: RegExp[] = [];
	private startup: boolean = true;

	private deps: ModerationServiceDependencies;
	constructor(dependencies: ModerationServiceDependencies){
		this.deps = dependencies;
		this.init();
	}

	private init(): void {
		this.initializeProfanityFilter();
		this.initializeBaseNickFilter();
	}

	public appendBaseNickFilter(commands: string[]): void {
		if(!this.startup){
			throw new AppError('No longer starting up, illegal appendBaseNickFilter call', 'bug');
		}
		const added = this.buildPattern(commands, '^', '$');
		this.basenickFilter.push(...added);
		this.startup = false;
	}

	public moderateText(raw: string, user: Identity, type: TextType): SafeString{
		const clean = sanitizeText(raw).trim();
		switch(type){
			case 'chat':{
				if(clean.length > this.deps.configService.getServerConfig().maxMsgLen){
					throw new AppError('sorry your message is too long lmao', 'user');
				}
				if(clean.length < 1){
					throw new AppError('no content in message, try resending with ASCII only', 'user');
				}
				try{
					this.moderateProfanity(clean);
					this.moderateTime(user, 'chat');
				}
				catch(error: unknown){
					if(error instanceof AppError){
						throw error;
					}
					handleError(error, 'Moderate Text - Chat');

					throw new AppError('failed to validate your message: unknown error', 'user');
				}
				const safe = this.createSafeString(clean);
				return safe;
			}

			case 'status':{
				if(clean.length > this.deps.configService.getServerConfig().maxStatusLen){
					throw new AppError('tl;dr - set something shorter', 'user');
				}
				try{
					this.moderateProfanity(clean);
					this.moderateTime(user, 'other');
				}
				catch(error: unknown){
					if(error instanceof AppError){
						throw error;
					}
					handleError(error, 'Moderate Text - Status');

					throw new AppError('failed to validate your message: unknown error', 'user');
				}
				const safe = this.createSafeString(clean);
				return safe;
			}

			case'base':{
				const basenickmax = this.deps.configService.getServerConfig().maxBaseNickLen;
				if(clean.length > basenickmax || clean.length < 2){
					throw new AppError(`nickname must be between 2 and ${basenickmax} characters`, 'user');
				}
				if(/\s/.test(clean)){
					throw new AppError('no spaces in usernames', 'user');
				}
				try{
					this.moderateBaseNick(clean);
					this.moderateTime(user, 'nick');
				}
				catch(error: unknown){
					if(error instanceof AppError){
						throw error;
					}
					handleError(error, 'Moderate Text - Nick');

					throw new AppError('failed to validate your message: unknown error', 'user');
				}
				const safe = this.createSafeString(clean);
				return safe;
			}

			case 'color':{
				if(!isValidHexColor(clean)){
					throw new AppError('invalid hex code. please use format #RRGGBB', 'user');
				}

				try{
					this.moderateTime(user, 'other');
				}
				catch(error: unknown){
					if(error instanceof AppError){
						throw error;
					}
					handleError(error, 'Moderate Text - Color');

					throw new AppError('failed to validate your message: unknown error', 'user');
				}
				const safe = this.createSafeString(clean);
				return safe;
			}

			default:{
				throw new AppError('moderateText text type missing', 'bug');
			}
		}
	}

	public moderateNewUserBaseNick(raw: string, type: TextType): SafeString{
		const clean = sanitizeText(raw).trim();
		if(type === 'base'){
			const basenickmax = this.deps.configService.getServerConfig().maxBaseNickLen;
			if(clean.length > basenickmax || clean.length < 2){
				throw new AppError(`nickname must be between 2 and ${basenickmax} characters`, 'user');
			}
			if(/\s/.test(clean)){
				throw new AppError('no spaces in usernames', 'user');
			}
			try{
				this.moderateBaseNick(clean);
			}
			catch(error: unknown){
				if(error instanceof AppError){
					throw error;
				}
				handleError(error, 'Moderate New User Base Nick');

				throw new AppError('failed to validate your nickname: unknown error', 'user');
			}
			const safe = this.createSafeString(clean);
			return safe;
		}
		else{
			throw new AppError('moderateNewUserBaseNick text type missing', 'bug');
		}
	}

	public moderateTime(user: Identity, type: TimeType): void {
		const now = Date.now();
		const lastMessage = new Date(user.lastMessage).getTime();
		const lastChanged = new Date(user.lastChanged).getTime();

		if(lastMessage > now){
			throw new AppError ('ur in timeout rn', 'user');
		}

		const serverConfig = this.deps.configService.getServerConfig();
		const gameConfig = this.deps.configService.getGameConfig();
		const limits: Record<TimeType, number> = {
			chat: serverConfig.slowMode * 1000,
			nick: serverConfig.nickSlow * 1000,
			joinleave: serverConfig.otherSlow * 1000,
			game: gameConfig.gameSlow * 1000,
			other: serverConfig.otherSlow * 1000,
		};

		const last = type === 'chat' || type === 'joinleave' ? lastMessage : lastChanged;
		const waitTime = ((last + limits[type]) - now) /1000;

		if(waitTime > 0){
			throw new AppError(`you're doing that too fast, wait ${Math.ceil(waitTime)} seconds.`, 'user');
		}
	}

	private moderateBaseNick(basenick: string): void {
		const matched = this.basenickFilter.find(regex => regex.test(basenick));
		if(matched){
			console.log(`base nick filter "${basenick}" because it matched pattern: ${matched}`);
			throw new AppError('can\'t be named that', 'user');
		}
	}

	private moderateProfanity(str: string): void {
		const matched = this.profFilter.find(regex => regex.test(str));
		if(matched){
			console.log(`prof filter "${str}" because it matched pattern: ${matched}`);
			throw new AppError('watch your profamity', 'user');
		}
	}

	private createSafeString(str: string): SafeString{
		return str as SafeString;
	}

	private buildPattern(entries: string[], prepend: string, append: string): RegExp[]{
		const patterns: RegExp[] = [];
		for(const entry of entries){
			const pattern = prepend + entry + append;
			patterns.push(new RegExp(pattern, 'i'));
		}
		return patterns;
	}

	private initializeProfanityFilter(): void {
		try{
			const raw = this.fetchFilter(this.deps.profFilterPath);
			const profPatterns = this.resolveFilter(raw, 'profanity');
			this.profFilter = profPatterns;
		}
		catch(error: unknown){
			handleError(error, 'Profanity Filter Load');
			this.profFilter = [];
		}
	}

	private initializeBaseNickFilter(): void {
		try{
			const raw = this.fetchFilter(this.deps.basenickFilterPath);
			const basenickPatterns = this.resolveFilter(raw, 'basenick');

			const clientCommandPatterns = this.buildPattern(this.deps.clientCommands, '^', '$');
			const clientSubCommandPatterns = this.buildPattern(this.deps.clientSubCommands, '^', '$');
			const configPatterns = this.buildPattern(this.deps.configService.getServerConfig().baseNickRes, '^', '$');

			let markovPatterns: RegExp[] = [];
			if(this.deps.configService.getMarkovConfig().enabled){
				const markovBaseNick = this.deps.configService.getMarkovConfig().basenick;
				markovPatterns = this.buildPattern([markovBaseNick], '^', '$');
			}

			this.basenickFilter = [
				...this.profFilter,
				...basenickPatterns,
				...clientCommandPatterns,
				...clientSubCommandPatterns,
				...configPatterns,
				...markovPatterns
			];
		}
		catch(error: unknown){
			handleError(error, 'Nick Filter Load');
			this.basenickFilter = [];
		}
	}

	private fetchFilter(path: string): unknown{
		const filter: unknown[] = [];
		try{
			if(!existsFile(path)){
				throw new AppError(`filter file not found at ${path}`, 'internal', 'error');
			}
			return readJsonFile(path);
		}
		catch(error: unknown){
			handleError(error);
			return filter;
		}
	}

	private resolveFilter(input: unknown, type: 'profanity' | 'basenick'): RegExp[]{
		if(!isUnknownArray(input)){
			console.warn(`${type} filter data was not an array, starting fresh`);
			return [];
		}

		let compiledFilter: RegExp[];

		switch(type){
			case 'profanity':{
				const validEntries = parseArray(input, ProfanityFilterEntrySchema);
				const escaped = validEntries
					.filter(item => item.tags.includes('racial') && item.severity > 2)
					.map(item => item.match.split('*').map((seg) => seg.replace(/([a-zA-Z0-9.])(?=[a-zA-Z0-9.])/g, '$1[\\s\\-_.]*')).join('[^a-zA-Z0-9]*'));
				compiledFilter = this.buildPattern(escaped, '\\b', '\\b');
				break;
			}
			case 'basenick':{
				const validEntries = input.filter(entry => typeof entry === 'string');
				compiledFilter = this.buildPattern(validEntries, '^', '$');
				break;
			}
			default:{
				throw new AppError('resolveFilter called without appropriate label', 'bug');
			}
		}

		return compiledFilter;
	}
}
