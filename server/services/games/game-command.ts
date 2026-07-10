import { Server, Socket } from 'socket.io';

import { allGames } from '../../defs/def-config';
import { clearInput, keepInput } from '../../defs/def-input';
import { mType } from '../../defs/def-message';
import type { GameType } from '../../defs/def-config';
import type { Identity } from '../../defs/def-identity';
import type { Command } from '../../defs/def-message';

import { DispatchService } from '../dispatch';
import { GameIdentityService } from './game-identity';
import { IdentityService } from '../identity';
import { StateService } from '../state';

type GameCommandEntry = {
	enabledFor: GameType[];
	handler: (ctx: Command) => boolean | Promise<boolean>;
}

export interface GameCommandServiceDependencies {
	dispatchService: DispatchService;
	stateService: StateService;
	gameIdentityService: GameIdentityService;
	identityService: IdentityService;
}

export class GameCommandService {
	private gameCommands: Record<string, GameCommandEntry> = {};
	private activeGameCommands: Map<string, boolean> = new Map();
	
	private deps: GameCommandServiceDependencies;
	constructor(dependencies: GameCommandServiceDependencies){
		this.deps = dependencies;
		this.registerGameCommands();
	}

	public async handleGameCommand(msg: string, socket: Socket, io: Server, caller: Identity): Promise<boolean>{
		const args = msg.slice(1).trim().split(/ +/);
		const commandName = args.shift()?.toLowerCase() || '';

		if(!this.deps.stateService.getGameConfig().enabled){
			return this.sendNotCommand(socket);
		}
		
		if(this.activeGameCommands.get(socket.id)){
			return keepInput;
		}

		this.activeGameCommands.set(socket.id, true);
		
		try{
			const result = await this.executeGameCommand(commandName, {
				socket,
				io,
				args,
				fullArgs: args.join(' '),
				commandUser: caller
				});
			
			return result;
		}
		catch(error: unknown){
			this.deps.dispatchService.sendUserError(socket, error, `Handle Game Command: ${commandName}`);
			return keepInput;
		}
		finally{
			this.activeGameCommands.delete(socket.id);
		}
	}

	public getGameCommands(): string[]{
		return Object.keys(this.gameCommands);
	}

	private sendNotCommand(socket: Socket): boolean {
		this.deps.dispatchService.sendSystemChat(socket, mType.error, "system: that's not a command lol");
		return keepInput;
	}

	//execute the command, true to clear 
	private async executeGameCommand(name: string, ctx: Command): Promise<boolean> {
		const entry = this.gameCommands[name];

		if(!entry){
			return this.sendNotCommand(ctx.socket);
		}

		if(!entry.enabledFor.some(game => this.deps.stateService.getGameConfig()[game])){
			return this.sendNotCommand(ctx.socket);
		}

		return await entry.handler(ctx);
	}

	private registerGameCommands(){
		this.gameCommands['gamehelp'] = {
			enabledFor: allGames,
				handler: (ctx) => {
				const config = this.deps.stateService.getGameConfig();
				const helpMessages = [
					'/gamehelp  : View this list.',
				];

				const formatTable = helpMessages.join('\n');
				this.deps.dispatchService.sendSystemChat(ctx.socket, mType.info, formatTable);
				return clearInput;
			}
	
		// ------------------------------------------------------------------
		// ALIASES
		// ------------------------------------------------------------------

		//this.commands['h'] = this.commands['commands'] = this.commands['help'];
		}
	}
}