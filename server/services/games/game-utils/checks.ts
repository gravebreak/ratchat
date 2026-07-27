import type {ConfigService} from '../../config';

import {AppError} from '../../../utils/errors';

export function assertGamesEnabled(configService: ConfigService, caller: string): void {
	if(!configService.getGameConfig().enabled){
		throw new AppError(`${caller} call with minigames disabled`, 'bug');
	}
}

export function assertHorseRacingEnabled(configService: ConfigService, caller: string): void {
	if(!configService.getGameConfig().horseRacing){
		throw new AppError(`${caller} call with horse racing disabled`, 'bug');
	}
}

export function assertDuelingEnabled(configService: ConfigService, caller: string): void {
	if(!configService.getGameConfig().dueling){
		throw new AppError(`${caller} call with dueling disabled`, 'bug');
	}
}

export function assertDuelingChallengesEnabled(configService: ConfigService, caller: string): void {
	if(!configService.getGameConfig().duelingChallenge){
		throw new AppError(`${caller} call with dueling challenges disabled`, 'bug');
	}
}

export function assertBlackjackEnabled(configService: ConfigService, caller: string): void {
	if(!configService.getGameConfig().blackjack){
		throw new AppError(`${caller} call with blackjack disabled`, 'bug');
	}
}

export function assertFishingEnabled(configService: ConfigService, caller: string): void {
	if(!configService.getGameConfig().fishing){
		throw new AppError(`${caller} call with fishing disabled`, 'bug');
	}
}
