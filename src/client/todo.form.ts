export interface DraftValidation {
	readonly title: string;
	readonly error: string | null;
}

/** Client convenience only: the server independently validates every request. */
export function validateTodoDraft(value: string): DraftValidation {
	const title = value.trim();
	return { title, error: title.length === 0 ? 'Enter a task title.' : null };
}
