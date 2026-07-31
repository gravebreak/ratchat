import {fType, gType, hType, dType, rType} from '../../defs/def-events';
import type {RatServer, RatSocket, GameLine, GameTextPayload, GamePayload} from '../../defs/def-events';
import type {FishingResult,HorseBetResult} from '../../defs/def-games';
import type {GameIdentity} from '../../defs/def-identity';

import {ConfigService} from '../config';
import {DispatchService} from '../dispatch';
import {GameIdentityService} from './game-identity';
import {IdentityService} from '../identity';
import {StateService} from '../state';

import {AppError, handleError} from '../../utils/errors';
import {getBaseNick} from '../../utils/format';

import {createHorseNameText} from './game-utils/commentary';

export interface GameResolutionServiceDependencies {
	configService: ConfigService;
	dispatchService: DispatchService;
	gameIdentityService: GameIdentityService;
	identityService: IdentityService;
	stateService: StateService;

	io: RatServer;
}

export class GameResolutionService {
	private deps: GameResolutionServiceDependencies;

	constructor(dependencies: GameResolutionServiceDependencies){
		this.deps = dependencies;
	}

	public resolveHorseBet(playerid: GameIdentity['playerid'], results: HorseBetResult[], id: GamePayload['id']): void {
		for(const result of results){
			if(result.playerid !== playerid){
				throw new AppError('resolveHorseBet received a result for a mismatched playerid', 'internal', 'warn');
			}
		}

		const message: GameTextPayload = [];
		const jackpots: GameLine[] = [];
		const popupId = `${id}resolved`;
		let totalStake = 0;
		let totalPayout = 0;

		for(const result of results){
			totalStake += result.stake;
			totalPayout += result.payout;

			const horseName = createHorseNameText(result);
			let line: GameLine;
			if(result.payout > 0){
				line = [
					{text: `you won ${result.payout.toLocaleString('en-US')} betting on `, color: hType.normal, format: []},
					...horseName,
					{text: ` for ${result.stake.toLocaleString('en-US')}`, color: hType.normal, format: []}
				];

				let place: keyof GameIdentity['horseBetWins'] | null = null;
				if(result.place === 1){
					place = 'firsts';
				}
				else if(result.place === 2){
					place = 'seconds';
				}
				else if(result.place === 3){
					place = 'thirds';
				}
				else{
					handleError(new AppError(`horse bet result had payout but an unexpected place: ${result.place}`, 'internal', 'warn'), 'Record Horse Bet Win Place');
				}

				if(place){
					try{
						this.deps.gameIdentityService.incrementHorseBetWins(playerid, place);

						const gameUser = this.deps.gameIdentityService.getGameUser(playerid);
						if(result.payout > gameUser.horseBetBiggestWin.payout){
							this.deps.gameIdentityService.setHorseBetBiggestWin(playerid, result.payout, result.stake);
						}
					}
					catch(error: unknown){
						handleError(error, 'Record Horse Bet Win Stats');
					}
				}

				if(result.payout > this.deps.configService.getGameConfig().horseBetBigWin){
					try{
						const fullnick = this.deps.identityService.getFullNickByPlayerId(playerid);
						const basenick = getBaseNick(fullnick);
						const announcement: GameLine = [
							{text: 'jackpot! ', color: hType.normal, format: [fType.b]},
							{text: `${basenick} won ${result.payout.toLocaleString('en-US')} betting on `, color: hType.normal, format: []},
							...horseName,
							{text: ` for ${result.stake.toLocaleString('en-US')}!`, color: hType.normal, format: []}
						];
						jackpots.push(announcement);
					}
					catch(error: unknown){
						handleError(error, 'Horse Big Win Announcement');
					}
				}
			}
			else{
				line = [
					{text: `your bet of ${result.stake.toLocaleString('en-US')} on `, color: hType.normal, format: []},
					...horseName,
					{text: ' did not pay out.', color: hType.normal, format: []}
				];
			}
			message.push(line);
		}

		const netWinnings = totalPayout - totalStake;

		const summaryLine: GameLine = [];
		if(results.length > 1){
			if(netWinnings > 0){
				const totalWinnings = netWinnings + totalStake;
				summaryLine.push({text: `you made a total of ${totalWinnings.toLocaleString('en-US')} on ${totalStake.toLocaleString('en-US')} staked.`, color: hType.normal, format: []});
			}
			else if(netWinnings < 0){
				summaryLine.push({text: `you lost a total of ${Math.abs(netWinnings).toLocaleString('en-US')} on ${totalStake.toLocaleString('en-US')} staked.`, color: hType.normal, format: []});
			}
			else{
				summaryLine.push({text: `you broke even on ${totalStake.toLocaleString('en-US')} staked.`, color: hType.normal, format: []});
			}
			message.push(summaryLine);
		}

		const sockets = this.deps.stateService.getSocketsByPlayer(playerid);
		const payoutSocket = sockets[0];
		for(const socket of sockets){
			this.deps.dispatchService.sendGamePayload(socket, message, gType.horse, popupId, rType.dynamic, dType.append, 100);
		}

		try{
			if(jackpots.length > 0){
				this.deps.dispatchService.sendGamePayload(this.deps.io, jackpots, gType.horse, null, rType.direct, dType.direct);
			}
		}
		catch(error: unknown){
			handleError(error, 'Horse Bet Result Message');
		}

		if(totalPayout > 0){
			if(payoutSocket){
				this.sendUserPoints(playerid, payoutSocket, totalPayout);
			}
			else{
				try{
					this.deps.gameIdentityService.addGamePoints(playerid, totalPayout);
				}
				catch(error: unknown){
					handleError(error, 'Add Game Points (No Socket)');
				}
			}
		}

		if(netWinnings !== 0){
			try{
				this.deps.gameIdentityService.adjustHorseWinnings(playerid, netWinnings);
			}
			catch(error: unknown){
				handleError(error, 'Adjust Horse Winnings');
			}
		}
	}

	public sendUserPoints(playerid: GameIdentity['playerid'], socket: RatSocket, points: number): void {
		try{
			this.deps.gameIdentityService.addGamePoints(playerid, points);
			const nicepoints = points.toLocaleString('en-US');
			const name = this.deps.configService.getGameConfig().pointsName;
			const message: GameLine = [
				{text: "you've earned ", color: hType.normal, format: []},
				{text: `${nicepoints} `, color: hType.normal, format: [fType.b]},
				{text: name, color: hType.normal, format: [fType.b]},
				{text: ", don't spend it all in one place", color: hType.normal, format: []}
			];
			this.deps.dispatchService.sendGamePayload(socket, [message], gType.info, null, rType.dynamic, dType.replace);
		}
		catch(error: unknown){
			this.deps.dispatchService.sendUserErrorMessage(socket, error, 'Send User Points');
		}
	}

	public resolveFishingCatch(playerid: GameIdentity['playerid'], event: FishingResult): void {
		let message: GameLine;

		switch(event){
			case 'bite':{
				message = [{text: 'fish on! /catch it before it gets away!', color: hType.normal, format: [fType.b]}];
				break;
			}
			case 'expired':{
				message = [{text: 'damn, it got away...', color: hType.normal, format: []}];
				break;
			}
			case 'nothing':{
				message = [{text: 'looks like nothing bit...', color: hType.normal, format: []}];
				break;
			}
			default:{
				message = [{text: 'looks like nothing bit...', color: hType.normal, format: []}];
			}
		}

		const sockets = this.deps.stateService.getSocketsByPlayer(playerid);
		if(sockets){
			for(const socket of sockets){
				this.deps.dispatchService.sendGamePayload(socket, [message], gType.fishing, 'fish', rType.static, dType.append);
			}
		}
	}
}
