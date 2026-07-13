import type { Identity } from '../defs/def-identity';

const DISPLAY_COLOR_LENGTH = 7;

export function getBaseNick(fullNick: Identity['fullnick']): string{
	return fullNick.substring(DISPLAY_COLOR_LENGTH);
}

export function getNickColor(fullNick: Identity['fullnick']): string{
	return fullNick.substring(0, DISPLAY_COLOR_LENGTH);
}