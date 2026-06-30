import { handleError } from "./errors";

export function textSanitize(str: string): string{
	if(typeof str !== "string"){
		return "";
	}
	try{
		let s = str;

		s = s.normalize("NFKC");
		s = s.replace(/<[^>]*>/g, "");
		s = s.replace(/[^\x20-\x7E]/g, "");
		
		return s;
	}
	catch(error: unknown){
		handleError(error, 'Text Sanitize');
		return "";
	}
}

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