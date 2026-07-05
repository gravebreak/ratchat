import { handleError } from "./errors";

export function createSaveQueue(save: () => Promise<void>) {
	let pending: Promise<void> = Promise.resolve();

	return {
		chain(){
			pending = pending.then(save)
			.catch((error: unknown) => {
				handleError(error, `Save Queue: ${save.name}`);
			});
		},
	};
}