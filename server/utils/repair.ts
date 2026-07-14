import { dirname, basename, extname, join } from 'path';
import { existsFile } from './serialize';
import { AppError } from './errors';

export function assertSafeStartup(path: string): void {
	if(existsFile(getRepairPath(path))){
		throw new AppError(`Repair file present at ${path}, aborting`, 'internal', 'error');
	}
	if(existsFile(getTempPath(path))){
		throw new AppError(`Temp file present at ${path}, aborting`, 'internal', 'error');
	}
}

export function getRepairPath(originalPath: string): string {
	const dir = dirname(originalPath);
	const ext = extname(originalPath);
	const base = basename(originalPath, ext);
	return join(dir, `repair-${base}${ext}`);
}

function getTempPath(originalPath: string): string{
	const temp = `${originalPath}.tmp`;
	return temp;
}