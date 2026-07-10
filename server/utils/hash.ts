import crypto from 'crypto';

import { AppError } from './errors';

export function hashIP(ip: string): string{
	if(!process.env.IP_PEPPER){
		throw new AppError('No IP_PEPPER set, hash failed', 'internal', 'error');
	}

	const pepper = process.env.IP_PEPPER;
	const hash = crypto.createHash('sha256');

	hash.update(ip + pepper);
	
	return hash.digest('hex');
}