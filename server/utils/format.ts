const DISPLAY_COLOR_LENGTH = 7;

export function getBaseNick(fullNick: string): string{
	return fullNick.substring(DISPLAY_COLOR_LENGTH);
}

export function getNickColor(fullNick: string): string{
	return fullNick.substring(0, DISPLAY_COLOR_LENGTH);
}