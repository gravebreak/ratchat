import { existsSync } from 'fs';

import { DatabaseSync } from "node:sqlite";
import { Server } from 'socket.io';

import { mType, tType} from '../../shared/schema';

import { DispatchService } from './dispatch';
import { StateService } from './state';
import { ModerationService } from './moderation';
import { IdentityService } from './identity';

import { WeightedMap, weightedRandom } from '../utils/random';
import { getDisplayNick } from '../utils/format';
import { AppError, handleError } from '../utils/errors';

type Neuron = {
	table: string;
	word1: string;
	word2: string;
	word3: string;
	count: number;
}
type InsertNeuron = Omit<Neuron, 'count' | 'word3'> & {word3?: string}
type StartNeuron = Omit<Neuron, 'table' | 'word3'>;
type GramNeuron = Omit<Neuron, 'table'>;

export interface MarkovServiceDependencies {
	dispatchService: DispatchService;
	stateService: StateService;
	moderationService: ModerationService;
	identityService: IdentityService;

	brainPath: string;
	io: Server;
}

export class MarkovService{
	private dictionary: Set<string> = new Set();
	private db: DatabaseSync | null = null;
	private markovQ = Promise.resolve();

	private deps: MarkovServiceDependencies;
	constructor(dependencies: MarkovServiceDependencies){
		this.deps = dependencies;
		try{
			this.loadBrain(this.deps.brainPath);
		}
		catch(error: unknown){
			handleError(error, 'Load Markov Brain (Startup)');
		}
		this.markovTimer(this.deps.io);
	}

	public async markovGen(io: Server, seed?: string): Promise<string> {
		if(!this.db){
			throw new AppError('brain db not initialized', 'internal', 'warn');
		}

		const markovUser = this.deps.stateService.markovUser;
		if(!markovUser){
			throw new AppError('markovGen call with markov disabled', 'bug');
		}

		for(let attempt = 0; attempt < 5; attempt++){
			const raw: string[] = [];

			if(seed){
				const seedLow = seed.toLowerCase();

				if(!this.dictionary.has(seedLow)){
					throw new AppError(`${getDisplayNick(markovUser.nick)} don't know nothin about '${seed}'`, 'user');
				}

				let letter = seedLow[0].toUpperCase();
				letter = letter.replace(/[^A-Z_]/g, "_");
				const candidates = await this.loadNeuron(letter, seedLow);

				if(candidates.length === 0){
					throw new AppError(`${getDisplayNick(markovUser.nick)} don't know nothin about '${seed}'`, 'user');
				}

				const weightMap: WeightedMap = new Map(
					candidates.map((candidate, candidateIndex) => [String(candidateIndex), candidate.count])
				);

				const chosen = candidates[Number(weightedRandom(weightMap))];
				
				raw.push(chosen.words[0], chosen.words[1]);
			}
			else{
				const candidates = await this.loadNeuron();

				if(candidates.length === 0){
					throw new AppError("no start entries in markov brain", 'internal', 'warn');
				}

				const weightMap: WeightedMap = new Map(
					candidates.map((candidate, candidateIndex) => [String(candidateIndex), candidate.count])
				);

				const chosen = candidates[Number(weightedRandom(weightMap))];
				

				raw.push(chosen.words[0], chosen.words[1]);
			}

			while(true){
				const prev = raw[raw.length - 2];
				const curr = raw[raw.length - 1];

				let letters = (prev[0] + curr[0]).toUpperCase();
				letters = letters.replace(/[^A-Z_]/g, "_");
				const candidates = await this.loadNeuron(letters, prev, curr);

				if(candidates.length === 0){
					break;
				}
				const weightMap: WeightedMap = new Map(
					candidates.map((candidate, candidateIndex) => [String(candidateIndex), candidate.count])
				);

				const chosen = candidates[Number(weightedRandom(weightMap))];
				const next = chosen.words[2];

				if(!next || next === "<END>"){
					break;
				}

				raw.push(next);

				if(raw.join(" ").length > this.deps.stateService.getServerConfig().maxMsgLen){
					raw.pop();
					break;
				}
			}

			if(raw.length < 4){
				continue;
			}

			try{
				const safe = this.deps.moderationService.textCheck(raw.join(" "), markovUser, tType.chat);
				return safe;
			}
			catch(error: unknown){
				if(error instanceof AppError){
					if(error.message === "watch your profamity"){
						this.deps.dispatchService.sendSystemChat(io, mType.ann, `${getDisplayNick(markovUser.nick)} tried to say something naughty`);
						continue;
					}
					else{
						handleError(error, 'Markov Gen');
						continue;
					}
				}
				handleError(error, 'Markov Gen');
				
				throw new AppError(`failed to generate markov text: unknown error`, 'user');
			}
		}

		throw new AppError("no valid text generated after 5 attempts", 'user');
	}

	public async markovLearn(str: string){
		if(!this.deps.stateService.getMarkovConfig().learning){
			return;
		}

		if(!this.db){
			throw new AppError('brain db not initialized', 'internal', 'warn');
		}

		const words =  str
			.split(/\s+/)
			.filter(w => !this.deps.identityService.existsUserByNick(w))
			.map(w => w.trim())
			.filter(Boolean);
		
		if(words.length < 2){
			return;
		}

		const entries: InsertNeuron[] = [];

		const w0 = words[0];
		const w1 = words[1];

		const startLetter = (w0[0] || "_").toUpperCase().replace(/[^A-Z_]/g, "_");
		entries.push({table: `start_${startLetter}`, word1: w0, word2: w1});

		if(!this.dictionary.has(w0.toLowerCase())){
			this.dictionary.add(w0.toLowerCase());
		}

		if(words.length === 2){
			const letters = (w0[0] + w1[0]).toUpperCase().replace(/[^A-Z_]/g, "_");
			entries.push({table: `gram_${letters}`, word1: w0, word2: w1, word3: '<END>'});
			this.saveNeuronQueue(entries);
			return;
		}

		for(let i = 0; i < words.length - 2; i++){
			const a = words[i];
			const b = words[i + 1];
			const c = words[i + 2];

			const letters = (a[0] + b[0]).toUpperCase().replace(/[^A-Z_]/g, "_");
			entries.push({table: `gram_${letters}`, word1: a, word2: b, word3: c});
		}

		const lastA = words[words.length - 2];
		const lastB = words[words.length - 1];
		const endLetters = (lastA[0] + lastB[0]).toUpperCase().replace(/[^A-Z_]/g, "_");
		entries.push({table: `gram_${endLetters}`, word1: lastA, word2: lastB, word3: '<END>'});

		this.saveNeuronQueue(entries);
		return;
	}

	private markovTimer(io: Server){
		setInterval(async () =>{
			if(this.deps.stateService.markovSleep){
				return;
			}
			try{
				const gentext = await this.markovGen(io);
				if(this.deps.stateService.markovUser){
					this.deps.dispatchService.sendMarkovChat(io, gentext, this.deps.stateService.markovUser, this.deps.stateService.markovUser, '');
				}
			}
			catch(error: unknown){
				handleError(error, 'Markov Timer');
			}
		}, this.deps.stateService.getMarkovConfig().timer*1000);
	}
	private saveNeuronQueue(entries: InsertNeuron[]){
		this.markovQ = this.markovQ.then(() => this.saveNeuron(entries));
	}

	private async saveNeuron(entries: InsertNeuron[]){
		if(!this.db){
			return;
		}

		this.db.exec("BEGIN");

		try{
			for(const n of entries){
				if(n.table.startsWith("start_") && n.table.length === "start_".length + 1){
					this.db.prepare(`INSERT INTO ${n.table} (word1, word2, count) VALUES (?, ?, 1) ON CONFLICT(word1, word2) DO UPDATE SET count = count + 1;`).run(n.word1, n.word2);
				}
				else if(n.table.startsWith("gram_") && n.table.length === "gram_".length + 2){
						if(!n.word3){
							console.warn(`skipping gram entry missing word3: ${n.word1} ${n.word2}`);
							continue;
						}
					this.db.prepare(`INSERT INTO ${n.table} (word1, word2, word3, count) VALUES (?, ?, ?, 1) ON CONFLICT(word1, word2, word3) DO UPDATE SET count = count + 1;`).run(n.word1, n.word2, n.word3);
				}
				else{
					continue;
				}
			}

			this.db.exec("COMMIT");
		}
		catch(error: unknown){
			this.db.exec("ROLLBACK");
			handleError(error, 'Save Neuron');
		}
	}

	private async loadNeuron(letters?: string, prev?: string, curr?: string){
		if(!this.db){
			throw new AppError('brain db not initialized', 'internal', 'warn');
		}

		if(!letters){
			const results: { 
				words: string[], count: number }[] = [];

			const tables = 
				(this.db
					.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'start_%'`)
					.all() as {name: string}[]
				)
				.map(row => row.name);

			for(const table of tables){
				const rows = this.db.prepare(`SELECT word1, word2, count FROM ${table}`).all() as StartNeuron[];
				for (const row of rows){
					results.push({
						words: [row.word1, row.word2],
						count: row.count
					});
				}
			}

			return results;
		}

		if(letters.length === 1){
			const table = `start_${letters}`;

			let rows: StartNeuron[];

			if(prev && !curr){
				rows = this.db.prepare(`SELECT word1, word2, count FROM ${table} WHERE LOWER(word1) = LOWER(?)`).all(prev) as StartNeuron[];
			} else {
				rows = this.db.prepare(`SELECT word1, word2, count FROM ${table}`).all() as StartNeuron[];
			}

			return rows.map(row => ({
				words: [row.word1, row.word2],
				count: row.count
			}));
		}

		if(letters.length === 2){
			const table = `gram_${letters}`;

			let rows: GramNeuron[];

			if(prev && curr){
				rows = this.db.prepare(`SELECT word1, word2, word3, count FROM ${table} WHERE LOWER(word1) = LOWER(?) AND LOWER(word2) = LOWER(?)`).all(prev, curr) as GramNeuron[];
			} 
			else{
				rows = this.db.prepare(`SELECT word1, word2, word3, count FROM ${table}`).all() as GramNeuron[];
			}

			return rows.map(row => ({
				words: [row.word1, row.word2, row.word3],
				count: row.count
			}));
		}
		throw new AppError ('neuron load failure', 'internal', 'warn');
	}

	private loadBrain(brainPath: string){
		const brain = existsSync(brainPath);
		this.db = new DatabaseSync(brainPath);
		
		if(!brain){
			console.log('building markov brain....');
			const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ_";
			const startSchema = `CREATE TABLE IF NOT EXISTS %TABLE% (word1 TEXT, word2 TEXT, count INTEGER, PRIMARY KEY (word1, word2));`;
			const gramSchema = `CREATE TABLE IF NOT EXISTS %TABLE% (word1 TEXT,	word2 TEXT,	word3 TEXT, count INTEGER, PRIMARY KEY (word1, word2, word3));`;

			this.db.exec("PRAGMA journal_mode = MEMORY;");
			this.db.exec("BEGIN");
			for(const L of letters){
				const table = `start_${L}`;
				this.db.prepare(startSchema.replace("%TABLE%", table)).run();
			}

			for(const A of letters){
				for(const B of letters){
					const table = `gram_${A}${B}`;
					this.db.prepare(gramSchema.replace("%TABLE%", table)).run();
				}
			}
			this.db.exec("COMMIT");
			this.db.exec("PRAGMA journal_mode = DELETE;");
		}

		const tables = 
			(this.db
				.prepare(`SELECT name	FROM sqlite_master WHERE type='table' AND name LIKE 'start%';`)
				.all() as {name: string}[]
			)
			.map(row => row.name);

		let totalRows = 0;
		for(const table of tables){
			if(!/^[A-Za-z0-9_]+$/.test(table)){
				console.log("sus table:", table);
				continue;
			}

			try{
				const rows = this.db.prepare(`SELECT word1 FROM ${table}`).all();

				for(const row of rows){
					if(row.word1 && typeof row.word1 === "string"){
						this.dictionary.add(row.word1.toLowerCase());
					}
				}

				totalRows += rows.length;
			} 
			catch(error: unknown){
				handleError(error, 'Markov Load Brain');
			}
		}
		console.log(`loaded ${totalRows} markov start entries`);
	}
}