import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { mkdir, writeFile, rename } from "fs/promises";
import { dirname } from "path";

import { AppError } from "./errors";

export function existsFile(path: string): boolean {
	return existsSync(path);
}

export function createJsonFile(path: string, defaultValue: unknown): void {
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify(defaultValue, null, 4), { flag: 'wx' });
	}
	catch (error: unknown) {
		if (error instanceof Error) {
			throw new AppError(`failed to create JSON file at ${path}: ${error.message}`, 'internal', 'warn');
		}
		else {
			throw new AppError(`non error thrown while creating JSON file at ${path}: ${error}`, 'internal', 'error');
		}
	}
}

export function readJsonFile(path: string): unknown {
	try {
		const raw = readFileSync(path, 'utf-8');
		return JSON.parse(raw);
	}
	catch (error: unknown) {
		if (error instanceof Error) {
			throw new AppError(`failed to read/parse JSON file at ${path}: ${error.message}`, 'internal', 'warn');
		}
		else {
			throw new AppError(`non error thrown while reading JSON file at ${path}: ${error}`, 'internal', 'error');
		}
	}
}

export async function writeJsonFile(path: string, data: unknown): Promise<void> {
	const tempPath = `${path}.tmp`;

	try{
		await mkdir(dirname(path), { recursive: true });
		await writeFile(tempPath, JSON.stringify(data, null, 4));
		await rename(tempPath, path);
	}
	catch(error: unknown){
		if (error instanceof Error) {
			throw new AppError(`failed to write JSON file at ${path}: ${error.message}`, 'internal', 'error');
		}
		else {
			throw new AppError(`non error thrown while writing JSON file at ${path}: ${error}`, 'internal', 'error');
		}
	}
}