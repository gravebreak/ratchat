import type {FishCatch} from '../../../defs/def-games';
import type {PrivateFishRecordList, FishRecordEntry} from '../../../defs/def-record';
import type {UniformCandidates} from '../../../defs/def-random';

import {AppError} from '../../../utils/errors';
import {pickUniform, pickGaussian} from '../../../utils/random';

export function createCatch(target: string | null, records: PrivateFishRecordList): FishCatch | null {
	let fish: FishRecordEntry | null;
	if(!target){
		fish = pickRandomFish(records);
	}
	else{
		fish = pickTargetFish(target, records);
	}

	if(!fish){
		return null;
	}

	const weight = pickFishWeight(fish);
	const value = pickFishValue(weight, fish.baseline);

	const fishCatch = {
		name: fish.fishName,
		flavor: fish.fishFlavor,
		color: fish.fishColor,
		weight: weight,
		value: value
	};
	return fishCatch;

}

function pickRandomFish(records: PrivateFishRecordList): FishRecordEntry {
	const allFishNames: UniformCandidates<FishRecordEntry['fishName']> = records.map(entry => entry.fishName);
	const pickedName = pickUniform<FishRecordEntry['fishName']>(allFishNames);
	const fish = records.find(entry => entry.fishName === pickedName);

	if(!fish){
		throw new AppError('picked fish name not found in records', 'bug');
	}

	return fish;
}

function pickTargetFish(target: string, records: PrivateFishRecordList): FishRecordEntry | null {
	const targetLower = target.toLowerCase();
	const fish = records.find(entry => entry.fishName.toLowerCase() === targetLower);

	if(!fish){
		return null;
	}

	return fish;
}

function pickFishWeight(fish: FishRecordEntry): number {
	const rawWeight = pickGaussian(fish.baseline);
	const roundedWeight = Math.round(rawWeight * 100) / 100;
	const clampedWeight = Math.max(roundedWeight, 0.01);

	return clampedWeight;
}

function pickFishValue(weight: number, baseline: number): number {
	const rawValue = (weight / (baseline * 2)) * 100;
	const roundedValue = Math.round(rawValue * 100) / 100;
	const clampedValue = Math.min(Math.max(roundedValue, 0.01), 99.99);

	return clampedValue;
}
