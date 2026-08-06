import {cardRank, cardSuit} from '../../../defs/def-games';
import type {BlackjackCard, BlackjackHand, BlackjackShoe, BlackjackValue} from '../../../defs/def-games';
import {AppError} from '../../../utils/errors';
import {shuffle} from '../../../utils/random';

const SHOE_SIZE_DECKS = 8;

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

export function createBlackjackHand(cards: BlackjackCard[]): BlackjackHand {
	const blackjackValue = createBlackjackHandValue(cards);
	const blackjack = (cards.length === 2 && blackjackValue.value === 21);
	const bust = (blackjackValue.value > 21);
	let split = false;
	if(cards.length === 2 && calculateBlackjackCardValue(cards[0]) === calculateBlackjackCardValue(cards[1])){
		split = true;
	}

	const blackjackHand: BlackjackHand = {
		...blackjackValue,
		blackjack: blackjack,
		bust: bust,
		split: split
	};

	return blackjackHand;
}

export function createBlackjackHandValue(cards: BlackjackCard[]): BlackjackValue{
	let soft = false;
	let aced = false;
	let value = 0;
	cards.forEach(card => {
		const calcvalue = calculateBlackjackCardValue(card);
		if(calcvalue === 1){
			aced = true;
		}
		value = value + calcvalue;
	});

	if(value <= 21 && aced){
		const softvalue = value + 10;
		if(softvalue <= 21){
			value = softvalue;
			soft = true;
		}
	}

	const blackjackValue: BlackjackValue ={
		cards: cards,
		value: value,
		soft: soft
	};

	return blackjackValue;
}

function calculateBlackjackCardValue(card: BlackjackCard): number{
	if(card.rank === 'A'){
		return 1;
	}
	else if (card.rank === 'T' || card.rank === 'J' || card.rank === 'Q' || card.rank === 'K'){
		return 10;
	}
	else{
		const rankNumber = Number(card.rank);
		if(Number.isInteger(rankNumber)){
			return rankNumber;
		}
		else{
			throw new AppError('calculateBlackjackCardValue non integer rank', 'bug');
		}
	}
}
