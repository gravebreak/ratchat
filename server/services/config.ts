import { defaultServerConfig, defaultMarkovConfig, defaultGameConfig, ServerConfigSchema, MarkovConfigSchema, GameConfigSchema } from '../defs/def-config';
import { aType } from '../defs/def-parse';
import type { ServerConfig, MarkovConfig, GameConfig, Config, ServerConfigParams, MarkovConfigParams, GameConfigParams, ConfigParams } from '../defs/def-config';
import type { ParseFailureRecord } from '../defs/def-parse';

import { handleError, AppError } from '../utils/errors';
import { mergeConfigDefaults } from '../utils/parse';
import { assertSafeStartup, getRepairPath } from '../utils/repair';
import { existsFile, createJsonFile, readJsonFile } from '../utils/serialize';

export interface ConfigServiceDependencies{
	serverConfigPath: string;
	markovConfigPath: string;
	gameConfigPath: string;
}

export class ConfigService {
	private serverConfig: ServerConfig = {...defaultServerConfig};
	private markovConfig: MarkovConfig = {...defaultMarkovConfig};
	private gameConfig: GameConfig = {...defaultGameConfig};

	private deps: ConfigServiceDependencies;
	constructor(dependencies: ConfigServiceDependencies){
		this.deps = dependencies;
		this.init();
	}

	private init(): void {
		assertSafeStartup(this.deps.serverConfigPath);
		assertSafeStartup(this.deps.markovConfigPath);
		assertSafeStartup(this.deps.gameConfigPath);
		this.initializeServerConfig();
		this.initializeMarkovConfig();
		this.initializeGameConfig();
	}

	public getServerConfig(): ServerConfig{
		return this.serverConfig;
	}

	public getMarkovConfig(): MarkovConfig{
		return this.markovConfig;
	}

	public getGameConfig(): GameConfig{
		return this.gameConfig;
	}

	private initializeServerConfig(): void {
		try{
			const raw = this.fetchConfigFile(this.deps.serverConfigPath, defaultServerConfig, aType.sconfig);
			const resolved = this.resolveConfig(raw, this.deps.serverConfigPath, {label: aType.sconfig, fallback: defaultServerConfig, schema: ServerConfigSchema});
			if(resolved.gdprcontact === 'admin@email.here'){
				console.warn('No GDPR contact info set. If hosting publicly please set gdprcontact in config.json');
			}
			this.serverConfig = resolved;
			Object.freeze(this.serverConfig);
			console.log('LOADED SERVER CONFIG:', this.serverConfig);
		} 
		catch(error: unknown){
			handleError(error, 'Server Config Merge');
			this.serverConfig = defaultServerConfig;
			Object.freeze(this.serverConfig);
			console.error('SERVER CONFIG LOAD FAILURE, ROLLED BACK TO DEFAULT', defaultServerConfig);
		}
	}

	private initializeMarkovConfig(): void {
		try{
			const raw = this.fetchConfigFile(this.deps.markovConfigPath, defaultMarkovConfig, aType.mconfig);
			const resolved = this.resolveConfig(raw, this.deps.markovConfigPath, {label: aType.mconfig, fallback: defaultMarkovConfig, schema: MarkovConfigSchema});
			this.markovConfig = resolved;
			Object.freeze(this.markovConfig);
			console.log('LOADED MARKOV CONFIG:', this.markovConfig);
		} 
		catch(error: unknown){
			handleError(error, 'Markov Config Merge');
			this.markovConfig = defaultMarkovConfig;
			Object.freeze(this.markovConfig);
			console.error('MARKOV CONFIG LOAD FAILURE, ROLLED BACK TO DEFAULT', defaultMarkovConfig);
		}
	}

	private initializeGameConfig(): void {
		try{
			const raw = this.fetchConfigFile(this.deps.gameConfigPath, defaultGameConfig, aType.gconfig);
			const resolved = this.resolveConfig(raw, this.deps.gameConfigPath, {label: aType.gconfig, fallback: defaultGameConfig, schema: GameConfigSchema});
			this.gameConfig = resolved;
			Object.freeze(this.gameConfig);
			console.log('LOADED GAME CONFIG:', this.gameConfig);
		} 
		catch(error: unknown){
			handleError(error, 'Game Config Merge');
			this.gameConfig = defaultGameConfig;
			Object.freeze(this.gameConfig);
			console.error('GAME CONFIG LOAD FAILURE, ROLLED BACK TO DEFAULT', defaultGameConfig);
		}
	}

	private fetchConfigFile(path: string, defaultConfig: Config, label: ConfigParams['label']): unknown{
		if(!existsFile(path)){
			try{
				createJsonFile(path, defaultConfig);
				console.log(`created default ${label} json file`);
			}
			catch(error: unknown){
				handleError(error, `Create ${label} Default Json File`);
			}
			return defaultConfig;
		}

		try{
			return readJsonFile(path);
		}
		catch(error: unknown){
			handleError(error, `${label} Config Load`);
			return defaultConfig;
		}
	}

	private resolveConfig(input: unknown, path: string, params: ServerConfigParams): ServerConfig;
	private resolveConfig(input: unknown, path: string, params: MarkovConfigParams): MarkovConfig;
	private resolveConfig(input: unknown, path: string, params: GameConfigParams): GameConfig;
	private resolveConfig(input: unknown, path: string, params: ConfigParams): Config {
		let merged: Config;
		let failures: ParseFailureRecord[];

		switch(params.label){
			case aType.sconfig:{
				[merged, failures] = mergeConfigDefaults(input, params);
				break;
			}

			case aType.mconfig:{
				[merged, failures] = mergeConfigDefaults(input, params);
				break;
			}

			case aType.gconfig:{
				[merged, failures] = mergeConfigDefaults(input, params);
				break;
			}

			default:{
				throw new AppError('resolveConfig called without appropriate label', 'bug');
			}
		}

		if(failures.length > 0){
			const repairPath = getRepairPath(path);
			console.error(`${params.label} had ${failures.length} field(s) fall back to default, writing repair file`);
			createJsonFile(repairPath, failures);
		}

		if(merged === null || merged === undefined){
			throw new AppError('config null/undefined, resolve config', 'bug');
		}
		return merged;
	}
}