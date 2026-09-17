import type { State } from './todo.state';

export interface ViewModel {
	readonly todos: State['todos'];
	readonly error: string | null;
	readonly draft: string;
	readonly loading: boolean;
	readonly empty: boolean;
	readonly total: number;
	readonly completed: number;
	readonly remaining: number;
	readonly pendingCount: number;
	readonly creating: boolean;
	readonly connection: State['connection'];
	readonly canSubmit: boolean;
}

/** Derive coupled view values from the same state snapshot. */
export function selectViewModel(state: State): ViewModel {
	const total = state.todos.length;
	const completed = state.todos.filter(todo => todo.completed).length;
	const creating = state.pending.some(operation => operation.kind === 'create');
	return {
		todos: state.todos,
		error: state.error,
		draft: state.draft,
		loading: state.loadStatus === 'idle' || state.loadStatus === 'loading',
		empty: state.loadStatus === 'ready' && total === 0,
		total,
		completed,
		remaining: total - completed,
		pendingCount: state.pending.length,
		creating,
		connection: state.connection,
		canSubmit: state.draft.trim().length > 0 && !creating,
	};
}

export function equalViewModel(left: ViewModel, right: ViewModel): boolean {
	return left.todos === right.todos
		&& left.error === right.error
		&& left.draft === right.draft
		&& left.loading === right.loading
		&& left.empty === right.empty
		&& left.total === right.total
		&& left.completed === right.completed
		&& left.remaining === right.remaining
		&& left.pendingCount === right.pendingCount
		&& left.creating === right.creating
		&& left.connection === right.connection
		&& left.canSubmit === right.canSubmit;
}
