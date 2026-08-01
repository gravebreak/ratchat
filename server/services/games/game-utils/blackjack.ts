import {cardRank, cardSuit} from '../../../defs/def-games';
import type {BlackjackCard, BlackjackShoe} from '../../../defs/def-games';
import {shuffle} from '../../../utils/random';

const SHOE_SIZE_DECKS = 4;

export function createBlackjackShoe(): BlackjackShoe {
	const shoe: BlackjackShoe = [];

	for(let deckIndex = 0; deckIndex < SHOE_SIZE_DECKS; deckIndex++){
		for(const suit of Object.values(cardSuit)){
			for(const rank of Object.values(cardRank)){
				shoe.push({rank, suit});
			}
		}
	}

	const randomized = shuffle<BlackjackCard>(shoe);

	return randomized;
}
