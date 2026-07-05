import { createClient } from 'redis';
import type { RedisClientType } from 'redis';

import { handleError, AppError } from '../utils/errors'; 

const REDIS_TTL = 604800;
const REDIS_STARTUP_TIMEOUT = 3000;
const REDIS_RECONNECT_TIMEOUT = 5000;

export class CacheService{
	private redisClient: RedisClientType | null = null;

	public async startRedisClient(){
		if(!process.env.REDIS_URL){
			throw new AppError('startRedisClient called without REDIS_URL set', 'bug');
		}

		const client: RedisClientType = createClient({ url: process.env.REDIS_URL });

		try{
			client.on('error', () => {}); //suppress errors until startup completes
			client.on('reconnecting', () => {});
			client.on('connect', () => {
				if(client.options.socket){
					const port = 'port' in client.options.socket ? client.options.socket.port : 'unknown';
					console.log(`Redis client connected on port: ${port}`);
				}
			});

			await Promise.race([
				client.connect(),
				new Promise((_, reject) => setTimeout(() => reject(new Error('Redis startup timeout')), REDIS_STARTUP_TIMEOUT)),
			]);

			
			client.removeAllListeners('error');
			client.removeAllListeners('reconnecting');
			this.monitorRedisConnection(client);
			this.redisClient = client;
		}
		catch(error: unknown){
			client.destroy();
			handleError(error, 'Redis Startup');
		}
	}
	
	public existsRedisClient(): boolean{
		if(this.redisClient){
			return true;
		}
		return false;
	}
	
	public async getRedisValue(key: string): Promise<unknown>{
		if(!this.redisClient){
			throw new AppError('getRedisValue called while redis is unavailable', 'bug');
		}

		try{
			const raw = await this.redisClient.get(key);
			if(!raw){
				return null;
			}

			return JSON.parse(raw);
		}
		catch(error: unknown){
			if(error instanceof Error){
				throw new AppError(`failed to get/parse redis value for key ${key}: ${error.message}`, 'internal', 'warn');
			}
			else{
				throw new AppError(`non error thrown while getting redis value for key ${key}: ${error}`, 'internal', 'error');
			}
		}
	}

	public async setRedisValue(key: string, value: unknown){
		if(!this.redisClient){
			throw new AppError('setRedisValue called while redis is unavailable', 'bug');
		}

		try{
			await this.redisClient.set(key, JSON.stringify(value), { EX: REDIS_TTL });
		}
		catch(error: unknown){
			if(error instanceof Error){
				throw new AppError(`failed to set redis value for key ${key}: ${error.message}`, 'internal', 'warn');
			}
			else{
				throw new AppError(`non error thrown while setting redis value for key ${key}: ${error}`, 'internal', 'error');
			}
		}
	}

	private monitorRedisConnection(client: RedisClientType){
		let reconnectTimer: NodeJS.Timeout | null = null;

		client.on('reconnecting', () => {
			if(!reconnectTimer){
				console.warn('Redis connection lost, reconnecting...');
				reconnectTimer = setTimeout(() => {
					client.removeAllListeners();
					client.destroy();
					this.redisClient = null;
					console.error('Redis reconnection timeout exceeded 5s, fell back to stateless');
				}, REDIS_RECONNECT_TIMEOUT);
			}
		});

		client.on('connect', () => {
			if(reconnectTimer){
				clearTimeout(reconnectTimer);
				reconnectTimer = null;
			}
		});

		client.on('error', (error) => console.warn('Redis client error:', error.message));
	}
}