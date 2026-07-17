import { HorseOdds, HorseFieldEntry, HorseRaceEntry, HorseRaceResult } from '../../../defs/def-games';
import { PrivateHorseRecordList } from '../../../defs/def-record';
import type { Candidate, WeightedCandidates } from '../../../defs/def-random';

import { AppError } from '../../../utils/errors';
import { pickUniformExclusive, randomInt } from '../../../utils/random';

import { createHorseStartCommentary, createHorseCommentary, createHorseEndCommentary } from './commentary';

const MIN_FIELD_SIZE = 8;
const MAX_FIELD_SIZE = 13;

export function createHorseRaceResult(records: PrivateHorseRecordList): HorseRaceResult{
	const fieldSize = randomInt(MIN_FIELD_SIZE, MAX_FIELD_SIZE);

	const candidateHorses = records.map(entry => entry.horseName);
	const selectedHorses = pickUniformExclusive(candidateHorses, fieldSize);
	const weightedHorses = createHorseWeights(selectedHorses);

	const raceField: HorseRaceEntry[] = [];
	for(const [horseName, weight] of weightedHorses){
		const odds = createHorseOdds(weight);
		const raceEntry: HorseRaceEntry = {
			horseName: horseName,
			weight: weight,
			score: 0,
			oddsNum: odds.oddsNum,
			oddsDen: odds.oddsDen
		};
		raceField.push(raceEntry);
	}

	const gateScores = createHorseScoresPhase(raceField, 1, 0);
	const gateSqueeze = squeezeHorseScores(gateScores, .5, .5);
	const gates = createHorseStartCommentary(gateSqueeze);

	const checkpoint1Scores = createHorseScoresPhase(gateScores, 0.7, 0.3);
	const checkpoint1 = createHorseCommentary(checkpoint1Scores, gateScores, 2);

	const checkpoint2Scores = createHorseScoresPhase(checkpoint1Scores, 0.5, 0.5);
	const checkpoint2 = createHorseCommentary(checkpoint2Scores, checkpoint1Scores, 3);

	const checkpoint3Scores = createHorseScoresPhase(checkpoint2Scores, 0.3, 0.7);
	const checkpoint3 = createHorseCommentary(checkpoint3Scores, checkpoint2Scores, 4);

	const finalStretchScores = createHorseScoresPhase(checkpoint3Scores, 0.2, 0.8);
	const finalStretch = createHorseCommentary(finalStretchScores, checkpoint3Scores, 5);

	const endScores = createHorseScoresPhase(finalStretchScores, 0.1, 0.9);
	const end = createHorseEndCommentary(endScores);

	const field = createHorseField(raceField);
	const result: HorseRaceResult = {
		field: field,
		gates: gates,
		checkpoint1: checkpoint1,
		checkpoint2: checkpoint2,
		checkpoint3: checkpoint3,
		finalStretch: finalStretch,
		end: end,
		first: endScores[0].horseName,
		second: endScores[1].horseName,
		third: endScores[2].horseName
	};

	return result;
}

function createHorseWeights(candidates: Candidate[]): WeightedCandidates {
	let remaining = 1;
	const weighted: WeightedCandidates = new Map();
	for(let i = 0; i < candidates.length; i++){
		if(i === candidates.length - 1){
			let finalWeight: number;
			if(remaining > 0.2){
				finalWeight = Math.max(remaining * Math.random(), 0.001);
			}
			else{
				finalWeight = Math.max(remaining, 0.001);
			}
			weighted.set(candidates[i], finalWeight);
		}
		else{
			const doubleroll = (Math.random() + Math.random())/2;
			const thisWeight = Math.max(remaining * doubleroll * 0.3, 0.001);
			weighted.set(candidates[i], thisWeight);
			remaining -= thisWeight;
		}
	}
	const normalized = normalizeHorseWeights(weighted);
	return normalized;
}

function normalizeHorseWeights(weighted: WeightedCandidates): WeightedCandidates {
	let total = 0;
	for(const weight of weighted.values()){
		total += weight;
	}

	if(total <= 0){
		throw new AppError('horse weight normalization found non-positive total weight', 'internal', 'warn');
	}

	for(const [horse, weight] of weighted){
		weighted.set(horse, weight / total);
	}

	return weighted;
}

function createHorseOdds(weight: number): HorseOdds {
	const weightOddsRatio = (1 - weight) / weight;
	const denominators = [1, 2, 3, 4, 5, 10, 20];
	const minNumerator = 1;
	const maxNumerator = 32;
	const margin = 0.05;

	const candidates: { denominator: number, numerator: number, diff: number }[] = [];
	for(const denominator of denominators){
		const rawNumerator = Math.round(weightOddsRatio * denominator);
		const numerator = Math.min(Math.max(rawNumerator, minNumerator), maxNumerator);
		const diff = Math.abs((numerator / denominator) - weightOddsRatio);
		candidates.push({ denominator, numerator, diff });
	}

	//lowest denom canidadte within margin, fallback to best diff
	let chosen = candidates.find(candidate => candidate.diff <= margin);
	if(!chosen){
		let best = candidates[0];
		for(const candidate of candidates){
			if(candidate.diff < best.diff){
				best = candidate;
			}
		}
		chosen = best;
	}

	const odds: HorseOdds = {
		oddsNum: chosen.numerator,
		oddsDen: chosen.denominator
	};

	return odds;
}

function createHorseScoresPhase(race: HorseRaceEntry[], weightWeight: number, scoreWeight: number): HorseRaceEntry[] {
	const scores: HorseRaceEntry[] = [];

	for(const raceEntry of race){
		const newScore = createHorseScore(raceEntry, weightWeight, scoreWeight);
		const updatedEntry: HorseRaceEntry = { ...raceEntry, score: newScore };
		scores.push(updatedEntry);
	}

	const normalized = normalizeHorseScores(scores);
	const sorted = normalized.sort((a, b) => b.score - a.score);

	return sorted;
}

function createHorseScore(raceEntry: HorseRaceEntry, weightWeight: number, scoreWeight: number): number {
	const blend = (weightWeight * raceEntry.weight + scoreWeight * raceEntry.score);
	const random = ((Math.random() - 0.5) * 0.3);
	const newScore = Math.max(blend + random, 0.01);
	return newScore;
}

function squeezeHorseScores(race: HorseRaceEntry[], mult: number, add: number): HorseRaceEntry[] {
	for(const raceEntry of race){
		raceEntry.score = raceEntry.score * mult + add;
	}
	return race;
}

function normalizeHorseScores(race: HorseRaceEntry[]): HorseRaceEntry[] {
	let max = 0;
	for(const raceEntry of race){
		if(raceEntry.score > max){
			max = raceEntry.score;
		}
	}

	if(max <= 0){
		throw new AppError('horse race score normalization found non-positive max score', 'internal', 'warn');
	}

	for(const raceEntry of race){
		raceEntry.score = raceEntry.score / max;
	}

	return race;
}

function createHorseField(race: HorseRaceEntry[]): HorseFieldEntry[] {
	const field: HorseFieldEntry[] = [];
	for(const raceEntry of race){
		const fieldEntry: HorseFieldEntry = {
			horseName: raceEntry.horseName,
			oddsNum: raceEntry.oddsNum,
			oddsDen: raceEntry.oddsDen
		};
		field.push(fieldEntry);
	}

	return field;
}
