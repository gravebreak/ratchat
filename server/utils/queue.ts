import { handleError } from './errors';

type SaveQueue = {
	chain(): void;
};

export function createSaveQueue(save: () => Promise<void>): SaveQueue {
	let pending: Promise<void> = Promise.resolve();

	return {
		chain(): void {
			pending = pending.then(save)
				.catch((error: unknown) => {
					handleError(error, `Save Queue: ${save.name}`);
				});
		},
	};
}
