import { AppError } from "./errors";

type Candidate = string;
type Weight = number;
export type WeightedMap = Map<Candidate, Weight>;

export function weightedRandom(candidates: WeightedMap): Candidate {
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
	let currentCandidate: Candidate = firstEntry;

	for (const [candidate, weight] of candidates) {
		range -= weight;
		if (range <= 0) return candidate;
		currentCandidate = candidate;
	}

	return currentCandidate;
}