import type {WeightedCandidates, UniformCandidates, Baseline} from '../defs/def-random';

import {AppError} from './errors';

export function pickWeighted<CandidateType>(candidates: WeightedCandidates<CandidateType>): CandidateType {
	const firstEntry = candidates.keys().next().value;
	if(!firstEntry){
		throw new AppError('No candidates for weighted selection', 'bug');
	}

	let total = 0;
	for(const weight of candidates.values()){
		if(weight < 0){
			throw new AppError('Negative weight provided', 'bug');
		}
		total += weight;
	}

	if(total <= 0){
		throw new AppError('Improper weights provided', 'bug');
	}

	let range = Math.random() * total;
	let currentCandidate: CandidateType = firstEntry;

	for (const [candidate, weight] of candidates) {
		range -= weight;
		if(range <= 0){
			return candidate;
		}
		currentCandidate = candidate;
	}

	return currentCandidate;
}

export function pickUniform<CandidateType>(candidates: UniformCandidates<CandidateType>): CandidateType {
	if(candidates.length === 0){
		throw new AppError('No candidates for uniform selection', 'bug');
	}

	const index = Math.floor(Math.random() * candidates.length);
	return candidates[index];
}

export function pickUniformExclusive<CandidateType>(candidates: UniformCandidates<CandidateType>, count: number): CandidateType[] {
	if(candidates.length === 0){
		throw new AppError('No candidates for uniform exclusive selection', 'bug');
	}
	if(count > candidates.length){
		throw new AppError('pickUniformExclusive called with count greater than candidate pool size', 'bug');
	}
	if(count < 0){
		throw new AppError('pickUniformExclusive called with negative count', 'bug');
	}

	const pool = [...candidates];
	const picks: CandidateType[] = [];

	for(let i = 0; i < count; i++){
		const index = Math.floor(Math.random() * pool.length);
		picks.push(pool[index]);
		pool.splice(index, 1);
	}

	return picks;
}

export function pickGaussian(baseline: Baseline): number {
	const standardDev = baseline / 3;

	const random1 = Math.random();
	const random2 = Math.random();
	const signedBellPosition = Math.sqrt(-2 * Math.log(1-random1)) * Math.cos(2 * Math.PI * (1-random2));

	const result = baseline + (signedBellPosition * standardDev);

	const clamped = Math.min(Math.max(result, 0), baseline * 2);
	return clamped;
}

export function randomInt(min: number, max: number): number {
	if(min > max){
		throw new AppError('randomInt called with min greater than max', 'bug');
	}

	return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function randomIntArray(min: number, max: number): number[] {
	const minInt = Math.ceil(min);
	const maxInt = Math.floor(max);

	if(minInt > maxInt){
		throw new AppError('randomIntArray called with min greater than max', 'bug');
	}

	const pool: number[] = [];
	for(let i = minInt; i <= maxInt; i++){
		pool.push(i);
	}

	const picks: number[] = [];
	while(pool.length > 0){
		const index = Math.floor(Math.random() * pool.length);
		picks.push(pool[index]);
		pool.splice(index, 1);
	}

	return picks;
}

export function randomOrder<CandidateType>(candidates: UniformCandidates<CandidateType>): CandidateType[] {
	const shuffled = [...candidates];

	for(let i = 0; i < shuffled.length - 1; i++){
		const remaining = shuffled.length - i;
		const j = i + Math.floor(Math.random() * remaining);

		const current = shuffled[i];
		const swapped = shuffled[j];
		shuffled[i] = swapped;
		shuffled[j] = current;
	}

	return shuffled;
}
