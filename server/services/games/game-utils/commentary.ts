import {fType, hType} from '../../../defs/def-events';
import type {GameText, GameLine, GameTextPayload} from '../../../defs/def-events';
import type {HorseLabel, HorseRaceEntry, CommentaryLine, HorseField, HorseBet} from '../../../defs/def-games';

import {AppError} from '../../../utils/errors';
import {getOrdinalSuffix} from '../../../utils/format';
import {pickUniform} from '../../../utils/random';

import {commOpeningLines, commCorner1Lines, commMidwayLines, commCorner2Lines, commFinalStretchLines} from '../../catalogs/catalog-commentary';
import {commLeadStart, commLeadStable, commLeadGrowing, commLeadShrinking, commLeadNew, commLeadNewSurge} from '../../catalogs/catalog-commentary';
import {commClusterSecond, commClusterMiddle, commClusterEnd} from '../../catalogs/catalog-commentary';
import {commSurgeLines, commFallLines} from '../../catalogs/catalog-commentary';
import {commFinishFirst, commFinishSecond, commFinishThird} from '../../catalogs/catalog-commentary';

enum ClusterType {
	Second,
	Middle,
	End
}

type HorseMovement = HorseRaceEntry & {
	surged: boolean;
	fell: boolean;
};

const BIG = 0.2;
const SMALL = 0.1;

const blankLine: GameLine = [{text:'', color:hType.clear, format: []}];

export function createHorseNameText(horse: HorseLabel): GameText[] {
	const nametext: GameText[] = [
		{text: '[', color: hType.normal, format: []},
		{text: `No.${String(horse.horsePost).padStart(2, '0')}`, color: horse.horseColor, format: [fType.b,fType.mono]},
		{text: '][', color: hType.normal, format: []},
		{text: horse.horseName, color: horse.horseColor, format: []},
		{text: ']', color: hType.normal, format: []}
	];

	return nametext;
}

export function createHorseOddsText(field: HorseField): GameTextPayload {
	const gameText: GameTextPayload = [];
	const sortedField = [...field].sort((a, b) => {
		const probA = a.oddsDen / (a.oddsNum + a.oddsDen);
		const probB = b.oddsDen / (b.oddsNum + b.oddsDen);
		return probB - probA;
	});

	for(let index = 0; index < sortedField.length; index++){
		const horse = sortedField[index];
		const horseNameText = createHorseNameText(horse);
		const line: GameLine = [
			...horseNameText,
			{text: `at ${horse.oddsNum} : ${horse.oddsDen}`, color: hType.normal, format: []},
		];
		gameText.push(line);
	}
	return gameText;
}

export function createHorseBetsText(bets: Omit<HorseBet, 'callback'>[]): GameTextPayload {
	const gameText: GameTextPayload = [];

	for(const bet of bets){
		const horseNameText = createHorseNameText(bet);
		const line1: GameLine = [
			{text: `you bet ${bet.stake.toLocaleString('en-US')} on `, color: hType.normal, format: []},
			...horseNameText,
			{text: ` at ${bet.oddsNum} : ${bet.oddsDen}`, color: hType.normal, format: []},
		];
		gameText.push(line1);

		let expectedPayout = bet.stake + (bet.stake * (bet.oddsNum / bet.oddsDen));
		if(bet.prerace){
			expectedPayout = expectedPayout * 2;
			const preraceline: GameLine = [{text: 'prerace bonus applied!', color: hType.normal, format: [fType.i]}];
			gameText.push(preraceline);
		}

		const firstPays = Math.ceil(expectedPayout);
		const secondPays = Math.ceil(expectedPayout / 2);
		const thirdPays = Math.ceil(expectedPayout / 3);
		const line2: GameLine = [
			{text: `first place pays: ${firstPays}, second place pays: ${secondPays}, third place pays: ${thirdPays}`, color: hType.normal, format: []}
		];
		gameText.push(line2);
	}

	return gameText;
}

export function createHorseStartCommentary(curr: HorseRaceEntry[]): GameTextPayload {
	const commentary: GameTextPayload = [blankLine];
	const openerChosen = pickUniform(commOpeningLines.map(line => line.commentary));
	const openerLine: GameLine = [{text: openerChosen, color: hType.normal, format: []}];
	commentary.push(openerLine);
	commentary.push(blankLine);

	const leaderGap = curr[0].score - curr[1].score;
	const leaderCandidates = filterCommentaryPool(commLeadStart, leaderGap, true);
	const leaderChosen = pickUniform(leaderCandidates.map(line => line.commentary));
	const leaderLabel = {horseName: curr[0].horseName, horseColor: curr[0].horseColor, horsePost: curr[0].horsePost};
	const leaderName = appendHorseNames([leaderLabel]);
	const leaderLine: GameLine = [...leaderName, {text: leaderChosen, color: hType.normal, format: []}];
	commentary.push(leaderLine);

	const movementArray = curr.slice(1).map(entry => ({...entry, surged: false, fell: false}));
	const clusters = createHorseClusters(movementArray);
	const endCluster = clusters.pop();
	if(clusters.length > 0){
		const secondCluster = clusters[0];
		const secondGap = curr[0].score - secondCluster[0].score;
		const secondLine = createClusterCommentary(secondCluster, secondGap, ClusterType.Second);
		commentary.push(secondLine);

		for(let clusterIndex = 1; clusterIndex < clusters.length; clusterIndex++){
			const cluster = clusters[clusterIndex];
			const previousCluster = clusters[clusterIndex - 1];
			const gap = previousCluster[previousCluster.length - 1].score - cluster[0].score;
			const line = createClusterCommentary(cluster, gap, ClusterType.Middle);
			commentary.push(line);
		}
	}

	if(endCluster && endCluster.length > 0 ){
		let endGap: number;
		if(clusters.length > 0){
			const lastBeforeCluster = clusters[clusters.length - 1];
			endGap = lastBeforeCluster[lastBeforeCluster.length - 1].score - endCluster[0].score;
		}
		else{
			endGap = curr[0].score - endCluster[0].score;
		}
		const endLine = createClusterCommentary(endCluster, endGap, ClusterType.End);
		commentary.push(endLine);
	}

	commentary.push(blankLine);
	return commentary;
}

export function createHorseCommentary(curr: HorseRaceEntry[], prev: HorseRaceEntry[], phase: number): GameTextPayload {
	let locationPool: CommentaryLine[];
	switch(phase){
		case 2:{
			locationPool = commCorner1Lines;
			break;
		}
		case 3:{
			locationPool = commMidwayLines;
			break;
		}
		case 4:{
			locationPool = commCorner2Lines;
			break;
		}
		case 5:{
			locationPool = commFinalStretchLines;
			break;
		}
		default:{
			throw new AppError('createHorseCommentary called with unexpected phase', 'bug');
		}
	}
	const leaderGap = curr[0].score - curr[1].score;
	const locationCandidates = filterCommentaryPool(locationPool, leaderGap, true);

	const commentary: GameTextPayload = [blankLine];
	const openerChosen = pickUniform(locationCandidates.map(line => line.commentary));
	const openerLine: GameLine = [{text: openerChosen, color: hType.normal, format: []}];
	commentary.push(openerLine);
	commentary.push(blankLine);

	const movementArray = createHorseMovementArray(curr, prev);

	const sameLeader = curr[0].horseName === prev[0].horseName;
	let leaderPool: CommentaryLine[];
	if(sameLeader){
		if(curr[1].score < prev[1].score){
			leaderPool = commLeadGrowing;
		}
		else if(curr[1].score > prev[1].score){
			leaderPool = commLeadShrinking;
		}
		else{
			leaderPool = commLeadStable;
		}
	}
	else{
		if(movementArray[0].surged){
			leaderPool = commLeadNewSurge;
		}
		else{
			leaderPool = commLeadNew;
		}
	}
	const leaderCandidates = filterCommentaryPool(leaderPool, leaderGap, true);
	const leaderChosen = pickUniform(leaderCandidates.map(line => line.commentary));
	const leaderLabel = {horseName: curr[0].horseName, horseColor: curr[0].horseColor, horsePost: curr[0].horsePost};
	const leaderName = appendHorseNames([leaderLabel]);
	let leaderLine: GameLine;
	if(!sameLeader && movementArray[0].surged){
		leaderLine = [...leaderName, {text: leaderChosen, color: hType.normal, format: [fType.b]}];
	}
	else{
		leaderLine = [...leaderName, {text: leaderChosen, color: hType.normal, format: []}];
	}
	commentary.push(leaderLine);

	const clusters = createHorseClusters(movementArray.slice(1));
	const endCluster = clusters.pop();

	if(clusters.length > 0){
		const secondCluster = clusters[0];
		const secondGap = curr[0].score - secondCluster[0].score;

		if(secondCluster[0].surged){
			let nextCluster = clusters[1];
			if(!nextCluster && endCluster){
				nextCluster = endCluster;
			}
			const surgeLine = createSurgeCommentary(secondCluster[0], nextCluster);
			commentary.push(surgeLine);
		}
		else{
			const secondLine = createClusterCommentary(secondCluster, secondGap, ClusterType.Second);
			commentary.push(secondLine);
		}

		for(let clusterIndex = 1; clusterIndex < clusters.length; clusterIndex++){
			const cluster = clusters[clusterIndex];
			const previousCluster = clusters[clusterIndex - 1];
			const gap = previousCluster[previousCluster.length - 1].score - cluster[0].score;

			if(cluster[0].surged){
				let nextCluster = clusters[clusterIndex + 1];
				if(!nextCluster && endCluster){
					nextCluster = endCluster;
				}
				const surgeLine = createSurgeCommentary(cluster[0], nextCluster ?? []);
				commentary.push(surgeLine);
				continue;
			}
			if(cluster[0].fell){
				const fallLine = createFallCommentary(cluster[0]);
				commentary.push(fallLine);
				continue;
			}

			const line = createClusterCommentary(cluster, gap, ClusterType.Middle);
			commentary.push(line);
		}
	}

	if(endCluster && endCluster.length > 0){
		for(const endEntry of endCluster){
			if(endEntry.fell){
				const fallLine = createFallCommentary(endEntry);
				commentary.push(fallLine);
			}
		}

		let endGap: number;
		if(clusters.length > 0){
			const lastBeforeCluster = clusters[clusters.length - 1];
			endGap = lastBeforeCluster[lastBeforeCluster.length - 1].score - endCluster[0].score;
		}
		else{
			endGap = curr[0].score - endCluster[0].score;
		}
		const endLine = createClusterCommentary(endCluster, endGap, ClusterType.End);
		commentary.push(endLine);
	}

	commentary.push(blankLine);
	return commentary;
}

export function createHorseEndCommentary(curr: HorseRaceEntry[]): GameTextPayload {
	const commentary: GameTextPayload = [blankLine];

	const firstGap = curr[0].score - curr[1].score;
	const firstCandidates = filterCommentaryPool(commFinishFirst, firstGap, true);
	const firstChosen = pickUniform(firstCandidates.map(line => line.commentary));
	const firstLabel = {horseName: curr[0].horseName, horseColor: curr[0].horseColor, horsePost: curr[0].horsePost};
	const firstName = appendHorseNames([firstLabel]);
	const firstLine: GameLine = [...firstName, {text: firstChosen, color: hType.gold, format: [fType.b]}];
	commentary.push(firstLine);

	const secondGap = curr[0].score - curr[1].score;
	const secondCandidates = filterCommentaryPool(commFinishSecond, secondGap, true);
	const secondChosen = pickUniform(secondCandidates.map(line => line.commentary));
	const secondLabel = {horseName: curr[1].horseName, horseColor: curr[1].horseColor, horsePost: curr[1].horsePost};
	const secondName = appendHorseNames([secondLabel]);
	const secondLine: GameLine = [...secondName, {text: secondChosen, color: hType.silver, format: []}];
	commentary.push(secondLine);

	const thirdGap = curr[1].score - curr[2].score;
	const thirdCandidates = filterCommentaryPool(commFinishThird, thirdGap, true);
	const thirdChosen = pickUniform(thirdCandidates.map(line => line.commentary));
	const thirdLabel = {horseName: curr[2].horseName, horseColor: curr[2].horseColor, horsePost: curr[2].horsePost};
	const thirdName = appendHorseNames([thirdLabel]);
	const thirdLine: GameLine = [...thirdName, {text: thirdChosen, color: hType.bronze, format: []}];
	commentary.push(thirdLine);

	commentary.push(blankLine);
	for(let index = 3; index < curr.length; index++){
		const place = index + 1;
		const label = {horseName: curr[index].horseName, horseColor: curr[index].horseColor, horsePost: curr[index].horsePost};
		const name = appendHorseNames([label]);
		const line: GameLine = [...name, {text: ` finishes ${place}${getOrdinalSuffix(place)}.`, color: hType.normal, format: []}];
		commentary.push(line);
	}

	commentary.push(blankLine);
	return commentary;
}

function filterCommentaryPool(pool: CommentaryLine[], gap: number, singular: boolean): CommentaryLine[] {
	const close = gap < SMALL;
	const far = gap > BIG;

	const candidates = pool.filter(line => {
		if(line.singular !== singular){
			return false;
		}
		if(line.small && !close){
			return false;
		}
		if(line.big && !far){
			return false;
		}
		return true;
	});
	return candidates;
}

function createClusterCommentary(input: HorseRaceEntry[], gap: number, type: ClusterType): GameLine {
	let pool: CommentaryLine[];
	switch(type){
		case ClusterType.Second:{
			pool = commClusterSecond;
			break;
		}
		case ClusterType.Middle:{
			pool = commClusterMiddle;
			break;
		}
		case ClusterType.End:{
			pool = commClusterEnd;
			break;
		}
	}

	const singular = input.length < 2;
	const candidates = filterCommentaryPool(pool, gap, singular);

	const chosen = pickUniform(candidates.map(line => line.commentary));
	const names = appendHorseNames(input);
	const line: GameLine = [...names, {text: chosen, color: hType.normal, format: []}];
	return line;
}

function createSurgeCommentary(entry: HorseMovement, nextCluster: HorseMovement[]): GameLine {
	const surgeCandidates = filterCommentaryPool(commSurgeLines, 0, true);
	const chosen = pickUniform(surgeCandidates.map(line => line.commentary));

	let passedNames: GameText[];
	if(nextCluster.length === 0){
		passedNames = [{text: 'no one!', color: hType.normal, format: [fType.b]}];
	}
	else{
		passedNames = appendHorseNames(nextCluster);
	}
	const horseLabel = {horseName: entry.horseName, horseColor: entry.horseColor, horsePost: entry.horsePost};
	const horse = appendHorseNames([horseLabel]);
	const line: GameLine = [...horse, {text: chosen, color: hType.normal, format: [fType.b]}, ...passedNames];
	return line;
}

function createFallCommentary(entry: HorseMovement): GameLine {
	const fallCandidates = filterCommentaryPool(commFallLines, 0, true);
	const chosen = pickUniform(fallCandidates.map(line => line.commentary));
	const horseLabel = {horseName: entry.horseName, horseColor: entry.horseColor, horsePost: entry.horsePost};
	const horse = appendHorseNames([horseLabel]);
	const line: GameLine = [...horse, {text: chosen, color: hType.normal, format: []}];
	return line;
}

function createHorseMovementArray(curr: HorseRaceEntry[], prev: HorseRaceEntry[]): HorseMovement[] {
	const movementArray: HorseMovement[] = [];

	for(const entry of curr){
		const prevEntry = prev.find(prevCandidate => prevCandidate.horseName === entry.horseName);
		if(!prevEntry){
			throw new AppError('no matching previous entry found for horse during movement tagging', 'bug');
		}

		const delta = entry.score - prevEntry.score;
		const surged = delta > BIG;
		const fell = delta < -BIG;

		const taggedEntry: HorseMovement = {
			...entry,
			surged: surged,
			fell: fell
		};
		movementArray.push(taggedEntry);
	}

	return movementArray;
}

function createHorseClusters(horses: HorseMovement[]): HorseMovement[][] {
	let endStart = horses.length;
	for(let index = 0; index < horses.length; index++){
		if(horses[index].score < 0.3){
			endStart = index;
			break;
		}
	}

	const clusters: HorseMovement[][] = [];
	const beforeClusters = horses.slice(0, endStart);
	const endCluster = horses.slice(endStart);

	let anchorIndex = 0;
	while(anchorIndex < beforeClusters.length){
		const anchor = beforeClusters[anchorIndex];

		if(anchor.surged || anchor.fell){
			clusters.push([anchor]);
			anchorIndex++;
			continue;
		}

		const cluster: HorseMovement[] = [anchor];
		let nextIndex = anchorIndex + 1;
		while(
			nextIndex < beforeClusters.length &&
			!beforeClusters[nextIndex].surged &&
			!beforeClusters[nextIndex].fell &&
			anchor.score - beforeClusters[nextIndex].score <= SMALL
		){
			cluster.push(beforeClusters[nextIndex]);
			nextIndex++;
		}

		clusters.push(cluster);
		anchorIndex = nextIndex;
	}

	clusters.push(endCluster);
	return clusters;
}

function appendHorseNames(horses: HorseLabel[]): GameText[] {
	const names: GameText[] = [];

	if(horses.length === 1){
		names.push(...createHorseNameText(horses[0]));
	}
	else if(horses.length === 2){
		names.push(...createHorseNameText(horses[0]));
		names.push({text: ' and ', color: hType.normal, format: []});
		names.push(...createHorseNameText(horses[1]));
	}
	else{
		const allButLast = horses.slice(0, -1);
		const last = horses[horses.length - 1];

		for(const horse of allButLast){
			names.push(...createHorseNameText(horse));
			names.push({text: ', ', color: hType.normal, format: []});
		}
		names.push({text: 'and ', color: hType.normal, format: []});
		names.push(...createHorseNameText(last));
	}

	return names;
}
