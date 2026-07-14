export function isValidHexColor(color: string) : boolean{
	if(/^#[0-9A-F]{6}$/i.test(color)){
		return true;
	}
	return false;
}

export function isValidGUID(guid: string): boolean {
	if(/^[{]?[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}[}]?$/i.test(guid)){
		return true;
	}
	return false;
}

export function isValid7TVID(id: string): boolean {
	if(/^[a-z0-9_-]{17,31}$/i.test(id)){
		return true;
	}
	return false;
}
