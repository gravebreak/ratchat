import { handleError } from './errors';

export function sanitizeText(str: string): string{
	try{
		let s = str;

		s = s.normalize('NFKC');
		s = s.replace(/<[^>]*>/g, '');
		s = s.replace(/[^\x20-\x7E]/g, '');
		
		return s;
	}
	catch(error: unknown){
		handleError(error, 'Sanitize Text');
		return '';
	}
}