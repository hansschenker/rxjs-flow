import { type Observable, Subject, map } from 'rxjs';
import { h } from './h';
import type { Scope } from './runtime/scope';
import type { Action } from './todo.state';
import type { ViewModel } from './todo.selectors';
import { TodoItem, type TodoRowView } from './components/todo-item';
import { bindAttribute, bindIf, bindProperty, bindText } from './dom/bindings';
import { bindKeyedList, type KeyedRow } from './dom/keyed-list';

/** Locate the stable host shell once, before activating any source. */
export function findTodoElements(root: ParentNode) {
	const list = root.querySelector<HTMLElement>('#todo-list');
	const error = root.querySelector<HTMLElement>('#error-msg');
	const form = root.querySelector<HTMLFormElement>('#add-form');
	const input = root.querySelector<HTMLInputElement>('#title-input');
	if (!list || !error || !form || !input) {
		throw new Error('Todo app requires #todo-list, #error-msg, #add-form and #title-input.');
	}
	return {
		list, error, form, input,
		submit: form.querySelector<HTMLButtonElement>('button[type="submit"]'),
		refresh: root.querySelector<HTMLButtonElement>('#refresh-todos'),
		summary: root.querySelector<HTMLElement>('#todo-summary'),
		pending: root.querySelector<HTMLElement>('#pending-msg'),
		loading: root.querySelector<HTMLElement>('#loading-state'),
		empty: root.querySelector<HTMLElement>('#empty-state'),
		connection: root.querySelector<HTMLElement>('#connection-state'),
		connectionLabel: root.querySelector<HTMLElement>('#connection-label'),
		connectionDetail: root.querySelector<HTMLElement>('#connection-detail'),
		filters: Array.from(root.querySelectorAll<HTMLInputElement>('input[name="todo-filter"]')),
		draftHint: root.querySelector<HTMLElement>('#title-hint'),
		filteredEmpty: root.querySelector<HTMLElement>('#filtered-empty-state'),
		errorRecovery: root.querySelector<HTMLElement>('#error-recovery'),
		errorDismiss: root.querySelector<HTMLButtonElement>('#dismiss-error'),
	};
}

/** Subscribe DOM sinks to coherent projections of the model's owned state. */
export function bindTodoView(
	scope: Scope,
	elements: ReturnType<typeof findTodoElements>,
	viewModel$: Observable<ViewModel>,
	onIntent: (action: Action) => void,
	onError: (error: unknown) => void,
	onCommit?: () => void,
): void {
	const { list, error, form, input, submit, refresh, summary, pending, loading, empty,
		connection, connectionLabel, connectionDetail, filters, draftHint, filteredEmpty,
		errorRecovery, errorDismiss } = elements;
	bindText(scope, error, viewModel$.pipe(map(errorText)), onError);
	bindProperty(scope, input, 'value', viewModel$.pipe(map(draftValue)), onError);
	bindAttribute(scope, input, 'aria-invalid', viewModel$.pipe(map(draftInvalid)), onError);
	if (draftHint) {
		bindAttribute(scope, input, 'aria-describedby', viewModel$.pipe(map(draftHintId)), onError);
		bindText(scope, draftHint, viewModel$.pipe(map(draftHintText)), onError);
		bindAttribute(scope, draftHint, 'data-invalid', viewModel$.pipe(map(draftInvalid)), onError);
	}
	bindAttribute(scope, form, 'aria-busy', viewModel$.pipe(map(formBusy)), onError);
	if (submit) {
		bindProperty(scope, submit, 'disabled', viewModel$.pipe(map(submitDisabled)), onError);
		bindText(scope, submit, viewModel$.pipe(map(submitText)), onError);
	}
	if (summary) bindText(scope, summary, viewModel$.pipe(map(remainingText)), onError);
	if (pending) bindText(scope, pending, viewModel$.pipe(map(pendingText)), onError);
	if (loading) bindIf(scope, loading, viewModel$.pipe(map(isLoading)), loadingContent, onError);
	if (empty) bindIf(scope, empty, viewModel$.pipe(map(isEmpty)), emptyContent, onError);
	if (filteredEmpty) {
		bindText(scope, filteredEmpty, viewModel$.pipe(map(filteredEmptyText)), onError);
		bindProperty(scope, filteredEmpty, 'hidden', viewModel$.pipe(map(hideFilteredEmpty)), onError);
	}
	if (errorRecovery) {
		bindText(scope, errorRecovery, viewModel$.pipe(map(recoveryHint)), onError);
		bindProperty(scope, errorRecovery, 'hidden', viewModel$.pipe(map(hideRecoveryHint)), onError);
	}
	if (errorDismiss) bindProperty(scope, errorDismiss, 'hidden', viewModel$.pipe(map(hideErrorDismiss)), onError);
	for (const control of filters) {
		function filterChecked(view: ViewModel): boolean { return control.value === view.filter; }
		bindProperty(scope, control, 'checked', viewModel$.pipe(map(filterChecked)), onError);
	}
	if (refresh) bindText(scope, refresh, viewModel$.pipe(map(recoveryText)), onError);
	if (connection) bindAttribute(scope, connection, 'data-state', viewModel$.pipe(map(connectionTone)), onError);
	if (connectionLabel) bindText(scope, connectionLabel, viewModel$.pipe(map(connectionText)), onError);
	if (connectionDetail) bindText(scope, connectionDetail, viewModel$.pipe(map(connectionDetailText)), onError);

	function createRow(initial: TodoRowView, rowScope: Scope): KeyedRow<TodoRowView> {
		const updates = new Subject<TodoRowView>();
		const element = TodoItem({ todo: initial.todo, view$: updates.asObservable(), scope: rowScope, onIntent, onError });
		rowScope.add(() => updates.complete());
		return { element, update: value => { if (!rowScope.closed) updates.next(value); } };
	}
	// This final sink runs after the scalar bindings and reports only once the
	// keyed rows have been updated and placed successfully.
	bindKeyedList(scope, list, viewModel$.pipe(map(todoRows)), rowKey, createRow, onError, onCommit);
}

export function remainingText(view: ViewModel): string {
	return `${view.remaining} remaining · ${view.completed} completed`;
}

function errorText(view: ViewModel): string { return view.error ?? ''; }
function recoveryText(view: ViewModel): string { return view.live ? 'Reconnect' : 'Refresh'; }
function connectionTone(view: ViewModel): string {
	if (!view.live) return 'manual';
	if (view.connection === 'disconnected') return 'error';
	if (view.connection === 'connected' && !view.live.stale) return 'live';
	return view.live.identity ? 'stale' : 'loading';
}
function connectionText(view: ViewModel): string {
	if (!view.live) return 'Manual refresh';
	if (view.connection === 'disconnected') return 'Connection stopped';
	if (view.connection === 'connected' && !view.live.stale) return 'Live';
	return view.live.identity ? 'Reconnecting…' : 'Connecting…';
}
function connectionDetailText(view: ViewModel): string {
	const live = view.live;
	if (!live) return 'Refresh to see changes made elsewhere.';
	if (view.connection === 'disconnected') {
		return `${live.error ?? 'Live updates are unavailable.'} Select Reconnect to try again.`;
	}
	if (view.connection === 'connected' && !live.stale) return 'Changes appear here automatically.';
	const retained = live.identity ? 'Showing the last confirmed list. ' : 'Waiting for the saved list. ';
	return live.retryDelayMs === null
		? `${retained}Connecting${live.attempt > 1 ? ` (retry ${live.attempt - 1})` : ''}…`
		: `${retained}Retry ${live.attempt - 1} in ${live.retryDelayMs / 1_000} s.`;
}
function draftValue(view: ViewModel): string { return view.draft; }
function draftInvalid(view: ViewModel): string { return String(view.draftInvalid); }
function draftHintId(): string { return 'title-hint'; }
function draftHintText(view: ViewModel): string { return view.draftError ?? 'Give your task a name.'; }
function recoveryHint(view: ViewModel): string { return view.recoveryHint ?? ''; }
function hideRecoveryHint(view: ViewModel): boolean { return !view.recoveryHint; }
function hideErrorDismiss(view: ViewModel): boolean { return view.error === null; }
function formBusy(view: ViewModel): string { return String(view.creating); }
function submitDisabled(view: ViewModel): boolean { return !view.canSubmit; }
function submitText(view: ViewModel): string { return view.creating ? 'Adding…' : 'Add'; }
function pendingText(view: ViewModel): string {
	return view.pendingCount ? `${view.pendingCount} pending` : 'All changes settled';
}
function isLoading(view: ViewModel): boolean { return view.loading; }
function isEmpty(view: ViewModel): boolean { return view.empty; }
function hideFilteredEmpty(view: ViewModel): boolean { return !view.filteredEmpty; }
function filteredEmptyText(view: ViewModel): string {
	if (!view.filteredEmpty) return '';
	return `No ${view.filter} tasks. Choose All to see the full list.`;
}
function loadingContent(): HTMLElement { return <p className="placeholder">Loading your tasks…</p>; }
function emptyContent(): HTMLElement { return <p className="placeholder">Your list is clear. Add a task above to get started.</p>; }
function rowKey(view: TodoRowView): string { return view.todo.id; }
function todoRows(view: ViewModel): readonly TodoRowView[] {
	const pending = new Set(view.pendingTodoIds);
	return view.todos.map(todo => ({ todo, busy: pending.has(todo.id) }));
}
