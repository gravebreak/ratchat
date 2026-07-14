import { existsSync } from 'fs';
import { DatabaseSync } from 'node:sqlite';
import { Server } from 'socket.io';

import { mType } from '../defs/def-message';
import { tType } from '../defs/def-moderation';
import type { RandomCandidateMap } from '../defs/def-random';

import { ConfigService } from './config';
import { DispatchService } from './dispatch';
import { ModerationService } from './moderation';
import { IdentityService } from './identity';
import { StateService } from './state';

import { AppError, handleError } from '../utils/errors';
import { getBaseNick } from '../utils/format';
import { isUnknownArray } from '../utils/parse';
import { pickWeighted } from '../utils/random';

const MAX_RETRY_ATTEMPTS = 5;
const MIN_WORD_COUNT = 4;

type Neuron = {
	table: string;
	word1: string;
	word2: string;
	word3: string;
	count: number;
};
type InsertNeuron = Omit<Neuron, 'count' | 'word3'> & {word3?: string};
type StartNeuron = Omit<Neuron, 'table' | 'word3'>;
type GramNeuron = Omit<Neuron, 'table'>;

export interface MarkovServiceDependencies {
	configService: ConfigService;
	dispatchService: DispatchService;
	moderationService: ModerationService;
	identityService: IdentityService;
	stateService: StateService;

	brainPath: string;
	io: Server;
}

export class MarkovService{
	private startTables: Neuron['table'][] = [];
	private dictionary: Set<StartNeuron['word1']> = new Set();
	private db: DatabaseSync | null = null;
	private markovQ = Promise.resolve();

	private deps: MarkovServiceDependencies;
	constructor(dependencies: MarkovServiceDependencies){
		this.deps = dependencies;
		this.init();		
	}
	
	private init(): void {
		this.initializeMarkovBrain();
		this.startMarkovTimer(this.deps.io);
	}

	public async generateMarkovText(io: Server, seed?: string): Promise<string> {
		if(!this.db){
			throw new AppError('brain db not initialized', 'internal', 'warn');
		}

		const markovUser = this.deps.stateService.markovUser;
		const maxMsgLen = this.deps.configService.getServerConfig().maxMsgLen;
		if(!markovUser){
			throw new AppError('generateMarkovText call with markov disabled', 'bug');
		}

		for(let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt++){
			const generatedWords: string[] = [];

			if(seed){
				const seedLowercase = seed.toLowerCase();

				if(!this.dictionary.has(seedLowercase)){
					throw new AppError(`${getBaseNick(markovUser.fullnick)} don't know nothin about '${seed}'`, 'user');
				}

				const startCandidates = await this.loadStartNeuron(seedLowercase);

				if(startCandidates.length === 0){
					throw new AppError(`${getBaseNick(markovUser.fullnick)} don't know nothin about '${seed}'`, 'user');
				}

				const weightMap: RandomCandidateMap = new Map(
					startCandidates.map((candidate, candidateIndex) => [String(candidateIndex), candidate.count])
				);

				const chosenStart = startCandidates[Number(pickWeighted(weightMap))];
				
				generatedWords.push(chosenStart.word1, chosenStart.word2);
			}
			else{
				const startCandidates = await this.loadStartNeuron();

				if(startCandidates.length === 0){
					throw new AppError('no start entries in markov brain', 'internal', 'warn');
				}

				const weightMap: RandomCandidateMap = new Map(
					startCandidates.map((candidate, candidateIndex) => [String(candidateIndex), candidate.count])
				);

				const chosenStart = startCandidates[Number(pickWeighted(weightMap))];

				generatedWords.push(chosenStart.word1, chosenStart.word2);
			}

			while(true){
				const prevWord = generatedWords[generatedWords.length - 2];
				const currWord = generatedWords[generatedWords.length - 1];

				const gramCandidates = await this.loadGramNeuron(prevWord, currWord);

				if(gramCandidates.length === 0){
					break;
				}
				const weightMap: RandomCandidateMap = new Map(
					gramCandidates.map((candidate, candidateIndex) => [String(candidateIndex), candidate.count])
				);

				const chosenGram = gramCandidates[Number(pickWeighted(weightMap))];
				const nextWord = chosenGram.word3;

				if(!nextWord || nextWord === '<END>'){
					break;
				}

				generatedWords.push(nextWord);

				if(generatedWords.join(' ').length > maxMsgLen){
					generatedWords.pop();
					break;
				}
			}

			if(generatedWords.length < MIN_WORD_COUNT){
				continue;
			}

			try{
				const safe = this.deps.moderationService.moderateText(generatedWords.join(' '), markovUser, tType.chat);
				return safe;
			}
			catch(error: unknown){
				if(error instanceof AppError){
					if(error.message === 'watch your profamity'){
						this.deps.dispatchService.sendSystemChat(io, mType.ann, `${getBaseNick(markovUser.fullnick)} tried to say something naughty`);
						continue;
					}
					else{
						handleError(error, 'Generate Markov Text');
						continue;
					}
				}
				handleError(error, 'Generate Markov Text');
				
				throw new AppError('failed to generate markov text: unknown error', 'user');
			}
		}

		throw new AppError(`no valid text generated after ${MAX_RETRY_ATTEMPTS} attempts`, 'user');
	}

	public async learnMarkovText(message: string): Promise<void> {
		if(!this.deps.configService.getMarkovConfig().learning){
			return;
		}

		if(!this.db){
			throw new AppError('brain db not initialized', 'internal', 'warn');
		}

		const words = message
			.split(/\s+/)
			.filter(word => !this.deps.identityService.existsUserByBaseNick(word))
			.map(word => word.trim())
			.filter(Boolean);
		
		if(words.length < 2){
			return;
		}

		const entries: InsertNeuron[] = [];

		const word1 = words[0];
		const word2 = words[1];
		const end = '<END>';
		const startLetter = (word1[0] || '_').toUpperCase().replace(/[^A-Z_]/g, '_');

		const startEntry: InsertNeuron = {table: `start_${startLetter}`, word1: word1, word2: word2};
		entries.push(startEntry);

		const dictionaryWord = startEntry.word1.toLowerCase();
		if(!this.dictionary.has(dictionaryWord)){
			this.dictionary.add(dictionaryWord);
		}

		if(words.length === 2){
			const gramLetters = (word1[0] + word2[0]).toUpperCase().replace(/[^A-Z_]/g, '_');
			const gramEntry: InsertNeuron = {table: `gram_${gramLetters}`, word1: word1, word2: word2, word3: end};
			entries.push(gramEntry);
			this.queueSaveNeuron(entries);
			return;
		}

		for(let i = 0; i < words.length - 2; i++){
			const prevWord = words[i];
			const currWord = words[i + 1];
			const nextWord = words[i + 2];
			const gramLetters = (prevWord[0] + currWord[0]).toUpperCase().replace(/[^A-Z_]/g, '_');
			const gramEntry: InsertNeuron = {table: `gram_${gramLetters}`, word1: prevWord, word2: currWord, word3: nextWord};
			entries.push(gramEntry);
		}

		const penultimateWord = words[words.length - 2];
		const lastWord = words[words.length - 1];
		const gramLetters = (penultimateWord[0] + lastWord[0]).toUpperCase().replace(/[^A-Z_]/g, '_');
		const gramEntry: InsertNeuron = {table: `gram_${gramLetters}`, word1: penultimateWord, word2: lastWord, word3: end};
		entries.push(gramEntry);

		this.queueSaveNeuron(entries);
	}

	private queueSaveNeuron(entries: InsertNeuron[]): void {
		this.markovQ = this.markovQ.then(() => this.saveNeuron(entries));
	}

	private async saveNeuron(entries: InsertNeuron[]): Promise<void> {
		if(!this.db){
			return;
		}

		this.db.exec('BEGIN');

		try{
			for(const entry of entries){
				if(entry.table.startsWith('start_') && entry.table.length === 'start_'.length + 1){
					this.db.prepare(`INSERT INTO ${entry.table} (word1, word2, count) VALUES (?, ?, 1) ON CONFLICT(word1, word2) DO UPDATE SET count = count + 1;`).run(entry.word1, entry.word2);
				}
				else if(entry.table.startsWith('gram_') && entry.table.length === 'gram_'.length + 2){
						if(!entry.word3){
							console.warn(`skipping gram entry missing word3: ${entry.word1} ${entry.word2}`);
							continue;
						}
					this.db.prepare(`INSERT INTO ${entry.table} (word1, word2, word3, count) VALUES (?, ?, ?, 1) ON CONFLICT(word1, word2, word3) DO UPDATE SET count = count + 1;`).run(entry.word1, entry.word2, entry.word3);
				}
				else{
					continue;
				}
			}

			this.db.exec('COMMIT');
		}
		catch(error: unknown){
			this.db.exec('ROLLBACK');
			handleError(error, 'Save Neuron');
		}
	}

	private async loadStartNeuron(seed?: StartNeuron['word1']): Promise<StartNeuron[]> {
		if(!this.db){
			throw new AppError('brain db not initialized', 'internal', 'warn');
		}

		let rows: unknown[];

		if(seed){
			const db = this.db;
			const startLetter = seed[0].toUpperCase().replace(/[^A-Z_]/g, '_');
			const table = `start_${startLetter}`;
			rows = (db
				.prepare(`SELECT word1, word2, count FROM ${table} WHERE LOWER(word1) = LOWER(?)`)
				.all(seed));
		}
		else{
			const db = this.db;
			const tables = this.startTables;
			rows = tables.flatMap(table => db
				.prepare(`SELECT word1, word2, count FROM ${table}`)
				.all());
		}

		const results: StartNeuron[] = [];
		let drops = 0;

		for(const row of rows){
			if(!this.isValidStartNeuron(row)){
				drops++;
				continue;
			}
			results.push(row);
		}

		if(drops > 0){
			console.warn(`${drops} dropped start neuron row(s) on loadStartNeuron, check brain db integrity`);
		}

		return results;
	}

	private async loadGramNeuron(prevWord: Neuron['word1'], currWord: Neuron['word2']): Promise<GramNeuron[]> {
		const db = this.db;
		if(!db){
			throw new AppError('brain db not initialized', 'internal', 'warn');
		}

		const gramLetters = (prevWord[0] + currWord[0]).toUpperCase().replace(/[^A-Z_]/g, '_');
		const table = `gram_${gramLetters}`;
		const rows: unknown[] = (db
			.prepare(`SELECT word1, word2, word3, count FROM ${table} WHERE LOWER(word1) = LOWER(?) AND LOWER(word2) = LOWER(?)`)
			.all(prevWord, currWord));
		
		const results: GramNeuron[] = [];
		let drops = 0;

		for(const row of rows){
			if(!this.isValidGramNeuron(row)){
				drops++;
				continue;
			}
			results.push(row);
		}

		if(drops > 0){
			console.warn(`${drops} dropped gram neuron row(s) on loadGramNeuron, check brain db integrity`);
		}

		return results;
	}

	private isValidStartNeuron(input: unknown): input is StartNeuron {
		if(typeof input !== 'object' || input === null){
			return false;
		}
		if(!('word1' in input) || typeof input.word1 !== 'string'){
			return false;
		}
		if(!('word2' in input) || typeof input.word2 !== 'string'){
			return false;
		}
		if(!('count' in input) || typeof input.count !== 'number'){
			return false;
		}
		return true;
	}
	
	private isValidGramNeuron(input: unknown): input is GramNeuron {
		if(typeof input !== 'object' || input === null){
			return false;
		}
		if(!('word1' in input) || typeof input.word1 !== 'string'){
			return false;
		}
		if(!('word2' in input) || typeof input.word2 !== 'string'){
			return false;
		}
		if(!('word3' in input) || typeof input.word3 !== 'string'){
			return false;
		}
		if(!('count' in input) || typeof input.count !== 'number'){
			return false;
		}
		return true;
	}

	private initializeMarkovBrain(): void {
		try{
			this.db = new DatabaseSync(this.deps.brainPath);
			const tableNames = this.fetchBrain(this.deps.brainPath);
			const validTableNames = this.resolveBrain(tableNames);
			this.startTables = validTableNames; 
			this.assignDictionary();
			console.log(`Loaded ${this.dictionary.size} start entries`);
		}
		catch(error: unknown){
			handleError(error, 'Load Markov Brain (Startup)');
		}
	}

	private fetchBrain(path: string): unknown[]{
		if(!this.db){
			throw new AppError('Connection failed before brain fetch', 'internal', 'error');
		}

		if(!existsSync(path)){
			console.log('building markov brain....');
			const allLetters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ_';
			const startSchema = 'CREATE TABLE IF NOT EXISTS %TABLE% (word1 TEXT, word2 TEXT, count INTEGER, PRIMARY KEY (word1, word2));';
			const gramSchema = 'CREATE TABLE IF NOT EXISTS %TABLE% (word1 TEXT,	word2 TEXT,	word3 TEXT, count INTEGER, PRIMARY KEY (word1, word2, word3));';

			this.db.exec('PRAGMA journal_mode = MEMORY;');
			this.db.exec('BEGIN');
			for(const startLetter of allLetters){
				const table = `start_${startLetter}`;
				this.db.prepare(startSchema.replace('%TABLE%', table)).run();
			}

			for(const gramLetter1 of allLetters){
				for(const gramLetter2 of allLetters){
					const table = `gram_${gramLetter1}${gramLetter2}`;
					this.db.prepare(gramSchema.replace('%TABLE%', table)).run();
				}
			}
			this.db.exec('COMMIT');
			this.db.exec('PRAGMA journal_mode = DELETE;');
		}
		const startTablesNames = (this.db.prepare('SELECT name	FROM sqlite_master WHERE type=\'table\' AND name LIKE \'start\\_%\' ESCAPE \'\\\''));
		startTablesNames.setReturnArrays(true);
		return startTablesNames.all();
	}

	private resolveBrain(input: unknown[]): Neuron['table'][]{
		const results: Neuron['table'][] = [];
		let drops = 0;

		for(const row of input){
			if(!isUnknownArray(row) || typeof row[0] !== 'string'){
				drops++;
				continue;
			}

			if(!/^[A-Za-z0-9_]+$/.test(row[0])){
				drops++;
				continue;
			}

			results.push(row[0]);
		}

		if(drops > 0){
			console.warn(`${drops} dropped table entries on resolveBrain, check brain db integrity`);
		}

		return results;
	}

	private assignDictionary(): void {
		if(!this.db){
			throw new AppError('Connection failed before dictionary assignment', 'internal', 'error');
		}

		let drops = 0;
		const tables = this.startTables;
		for(const table of tables){
			try{
				const rows: unknown[] = this.db.prepare(`SELECT word1 FROM ${table}`).all();
				for(const row of rows){
					if(typeof row !== 'object' || row === null || !('word1' in row) || typeof row.word1 !== 'string'){
						drops++;
						continue;
					}

					this.dictionary.add(row.word1.toLowerCase());
				}
			}
			catch(error: unknown){
				handleError(error, 'Assign Dictionary');
			}
		}

		if(drops > 0){
			console.warn(`${drops} dropped dictionary row(s) on assignDictionary, check brain db integrity`);
		}
	}

	private startMarkovTimer(io: Server): void {
		setInterval(async () =>{
			if(this.deps.stateService.markovSleep){
				return;
			}
			try{
				const generatedText = await this.generateMarkovText(io);
				if(this.deps.stateService.markovUser){
					this.deps.dispatchService.sendMarkovChat(io, generatedText, this.deps.stateService.markovUser, this.deps.stateService.markovUser, '');
				}
			}
			catch(error: unknown){
				handleError(error, 'Markov Timer');
			}
		}, this.deps.configService.getMarkovConfig().timer*1000);
	}
}