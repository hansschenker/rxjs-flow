import type { State } from './todo.state';
import { validateTodoDraft } from './todo.form';

export interface ViewModel {
	readonly todos: State['todos'];
	readonly error: string | null;
	readonly draft: string;
	readonly draftError: string | null;
	readonly draftInvalid: boolean;
	readonly filter: State['filter'];
	readonly visibleCount: number;
	readonly filteredEmpty: boolean;
	readonly recoveryHint: string | null;
	readonly loading: boolean;
	readonly empty: boolean;
	readonly total: number;
	readonly completed: number;
	readonly remaining: number;
	readonly pendingCount: number;
	readonly pendingTodoIds: readonly string[];
	readonly creating: boolean;
	readonly connection: State['connection'];
	readonly live: State['live'];
	readonly canSubmit: boolean;
}

function visibleTodos(state: State): State['todos'] {
	switch (state.filter) {
		case 'all': return state.todos;
		case 'active': return state.todos.filter(isActive);
		case 'completed': return state.todos.filter(isCompleted);
	}
}

function isCompleted(todo: State['todos'][number]): boolean {
	return todo.completed;
}

function isActive(todo: State['todos'][number]): boolean {
	return !todo.completed;
}

function recoveryHint(state: State): string | null {
	if (!state.error) return null;
	if (state.failedOperation === 'load') return 'Refresh to load the current list again.';
	if (state.failedOperation === null) return 'Your draft is kept. Review the message before trying again.';
	const creating = state.failedOperation === 'create';
	const failure = state.failure;
	const details = failure?.details;
	const outcome = typeof details === 'object' && details !== null && 'outcome' in details
		? details.outcome : undefined;
	if (outcome === 'not-committed') {
		return creating
			? 'The server did not save this change. Your draft is kept; review the message before trying again.'
			: 'The server did not save this change. Review the message and list before repeating the change.';
	}
	const rejected = failure?.kind === 'http' && failure.status !== undefined
		&& failure.status >= 400 && failure.status < 500 && outcome !== 'unknown';
	if (rejected) {
		return creating
			? 'The request was rejected. Your draft is kept; correct or review it before submitting again.'
			: 'The request was rejected. Review the message and list before repeating the change.';
	}
	const recovery = state.live ? 'Reconnect' : 'Refresh';
	return creating
		? `The change may already be saved. ${recovery} and review the list before submitting it again. Your draft is kept.`
		: `The change may already be saved. ${recovery} and review the list before repeating the change.`;
}

/** Derive coupled view values from the same state snapshot. */
export function selectViewModel(state: State): ViewModel {
	const total = state.todos.length;
	const completed = state.todos.filter(isCompleted).length;
	const creating = state.pending.some(operation => operation.kind === 'create');
	const validation = validateTodoDraft(state.draft);
	const draftError = state.draftTouched ? validation.error : null;
	const todos = visibleTodos(state);
	return {
		todos,
		error: state.error,
		draft: state.draft,
		draftError,
		draftInvalid: draftError !== null,
		filter: state.filter,
		visibleCount: todos.length,
		filteredEmpty: state.loadStatus === 'ready' && total > 0 && todos.length === 0,
		recoveryHint: recoveryHint(state),
		loading: state.loadStatus === 'idle' || state.loadStatus === 'loading',
		empty: state.loadStatus === 'ready' && total === 0,
		total,
		completed,
		remaining: total - completed,
		pendingCount: state.pending.length,
		pendingTodoIds: [...new Set(state.pending.flatMap(operation =>
			'todoId' in operation ? [operation.todoId] : []))],
		creating,
		connection: state.connection,
		live: state.live,
		canSubmit: validation.error === null && !creating,
	};
}

export function equalViewModel(left: ViewModel, right: ViewModel): boolean {
	return sameTodos(left.todos, right.todos)
		&& left.error === right.error
		&& left.draft === right.draft
		&& left.draftError === right.draftError
		&& left.draftInvalid === right.draftInvalid
		&& left.filter === right.filter
		&& left.visibleCount === right.visibleCount
		&& left.filteredEmpty === right.filteredEmpty
		&& left.recoveryHint === right.recoveryHint
		&& left.loading === right.loading
		&& left.empty === right.empty
		&& left.total === right.total
		&& left.completed === right.completed
		&& left.remaining === right.remaining
		&& left.pendingCount === right.pendingCount
		&& left.pendingTodoIds.length === right.pendingTodoIds.length
		&& left.pendingTodoIds.every((id, index) => id === right.pendingTodoIds[index])
		&& left.creating === right.creating
		&& left.connection === right.connection
		&& left.live === right.live
		&& left.canSubmit === right.canSubmit;
}

function sameTodos(left: State['todos'], right: State['todos']): boolean {
	return left === right || left.length === right.length && left.every((todo, index) => todo === right[index]);
}
