type LogLevel = 'none' | 'log' | 'warn' | 'error';
type ErrorMode = 'user' | 'internal' | 'silent' | 'bug';

export class AppError extends Error {
	public readonly mode: ErrorMode;
	public readonly logLevel?: LogLevel;

	constructor(message: string, mode: ErrorMode, logLevel?: LogLevel){
		super(message);
		this.name = this.constructor.name;
		this.mode = mode;
		this.logLevel = logLevel;
		if(Error.captureStackTrace){
			Error.captureStackTrace(this, this.constructor);
		}
	}
}

export function handleError(error: unknown, context?: string): string | null {
	const prefix = context ? `[${context}]:` : '';
	if(error instanceof AppError){
		switch(error.mode){
			case 'user':{
				//for user display messages, all other cases cannot be displayed to the user
				return error.message;
			}

			case 'internal':{
				switch(error.logLevel){
					case 'none':{
						return null;
					}

					case 'log':{
						console.log(prefix, error.stack ?? error.message);
						return null;
					}

					case 'warn':{
						console.warn(prefix, error.stack ?? error.message);
						return null;
					}

					case 'error':{
						console.error(prefix, error.stack ?? error.message);
						return null;
					}

					default:{
						console.error(prefix, error.stack ?? error.message);
						return null;
					}
				}
			}

			case 'silent':{
				return null;
			}

			case 'bug':{
				console.error(prefix, 'Unexpected bug:', error.stack ?? error.message);
				return null;
			}

			default:{
				return null;
			}
		}
	}
	else if(error instanceof Error){
		console.error(prefix, 'Unexpected error:', error.stack ?? error.message);
		return null;
	}
	else{
		console.error(prefix, 'Unexpected non-error thrown:', error);
		return null;
	}
}
