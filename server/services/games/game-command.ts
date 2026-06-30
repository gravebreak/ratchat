import { Server, Socket } from 'socket.io';

import { tType, mType } from '../../../shared/schema';
import type { Command, Identity } from '../../../shared/schema';

import { DispatchService } from '../dispatch';
import { StateService } from '../state';
import { GameIdentityService } from './game-identity';
import { IdentityService } from '../identity';

import { getDisplayNick, getDisplayColor } from '../../utils/format';
import { isValidGUID } from '../../utils/input';

const clearInput: boolean = true;
const keepInput: boolean = false;

export interface GameCommandServiceDependencies {
	dispatchService: DispatchService;
	stateService: StateService;
	gameIdentityService: GameIdentityService;
	identityService: IdentityService;
}

export class GameCommandService {
	private gameCommands: Record<string, (ctx: Command) => boolean | Promise<boolean>> = {};
	private activeGameCommands: Map<string, boolean> = new Map();
	
	private deps: GameCommandServiceDependencies;
	constructor(dependencies: GameCommandServiceDependencies){
		this.deps = dependencies;
		this.registerGameCommands();
	}

	public async gameCommandHandler(msg: string, socket: Socket, io: Server, user: Identity): Promise<boolean>{
		const args = msg.slice(1).trim().split(/ +/);
		const commandName = args.shift()?.toLowerCase() || '';
		
		if(this.activeGameCommands.get(socket.id)){
			return keepInput;
		}

		this.activeGameCommands.set(socket.id, true);
		
		try{
			const clearText = await this.execute(commandName, {
				socket,
				io,
				args,
				fullArgs: args.join(' '),
				commandUser: user
				});
			
			return clearText;
		}

		finally{
			this.activeGameCommands.delete(socket.id)
		}
	}

	public getGameCommands(): string[]{
		return Object.keys(this.gameCommands);
	}

	//execute the command, true to clear 
	private async execute(name: string, ctx: Command): Promise<boolean> {
		const handler = this.gameCommands[name];
		if(handler){

			return await handler(ctx);
		} else {
			this.deps.dispatchService.sendSystemChat(ctx.socket, mType.error, "system: that's not a command lol");
			return keepInput;
		}
	}

	private registerGameCommands(){
		this.gameCommands['gamehelp'] = (ctx) => {
			const config = this.deps.stateService.getServerConfig();
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