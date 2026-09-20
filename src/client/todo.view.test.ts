import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Subject } from 'rxjs';
import { createScope } from './runtime/scope';
import { createInitialState, reducer, type Action } from './todo.state';
import { selectViewModel, type ViewModel } from './todo.selectors';
import { bindTodoView, findTodoElements } from './todo.view';
import { describeOperation, interpretTodoIntent } from './todo.intents';

afterEach(() => { document.body.replaceChildren(); });

function bindFixture(live = true) {
	document.body.innerHTML = `
		<form id="add-form" novalidate><input id="title-input" required><button type="submit">Add</button></form>
		<p id="title-hint"></p>
		<button id="refresh-todos">Refresh</button><p id="todo-summary"></p>
		<div id="connection-state"><strong id="connection-label"></strong><p id="connection-detail"></p></div>
		<form><fieldset><legend>Show tasks</legend>
			<label><input type="radio" name="todo-filter" value="all">All</label>
			<label><input type="radio" name="todo-filter" value="active">Active</label>
			<label><input type="radio" name="todo-filter" value="completed">Completed</label>
		</fieldset></form>
		<div id="loading-state"></div><ul id="todo-list"></ul><div id="empty-state"></div>
		<p id="filtered-empty-state" hidden></p><p id="error-msg"></p><p id="error-recovery" hidden></p>
		<button id="dismiss-error" type="button" hidden>Dismiss message</button><span id="pending-msg"></span>`;
	const scope = createScope();
	const values = new Subject<ViewModel>();
	const elements = findTodoElements(document);
	const errors: unknown[] = [];
	const intents: Action[] = [];
	let state = createInitialState(live ? { collectionSource: 'live' } : {});
	bindTodoView(scope, elements, values, action => intents.push(action), error => errors.push(error));
	values.next(selectViewModel(state));
	function dispatch(action: Action) {
		state = reducer(state, action);
		values.next(selectViewModel(state));
	}
	return { scope, elements, errors, intents, dispatch, getState: () => state };
}

const todo = { id: '1', title: 'Keep this row', completed: false, createdAt: '2026-09-20T00:00:00.000Z' };
const snapshot = {
	schemaVersion: 1 as const, collectionId: 'local-reference', stateGeneration: 'history-1', revision: 1, todos: [todo],
};

describe('M06 connection feedback in the stable Todo view', () => {
	it('keeps the last list, row identity, input focus and draft selection through interruption and recovery', () => {
		const { scope, elements, errors, dispatch } = bindFixture();
		try {
			expect(elements.refresh?.textContent).toBe('Reconnect');
			expect(elements.loading?.textContent).toContain('Loading');
			dispatch({ type: 'LIVE_CONNECTING', connectionId: 1, attempt: 1 });
			expect(elements.connectionDetail?.textContent).not.toContain('retry');
			dispatch({ type: 'LIVE_SNAPSHOT', connectionId: 1, snapshot });
			expect(elements.connectionLabel?.textContent).toBe('Live');
			const row = elements.list.firstElementChild;
			dispatch({ type: 'DRAFT_CHANGED', value: 'A draft remains here' });
			elements.input.focus();
			elements.input.setSelectionRange(2, 7);
			dispatch({ type: 'LIVE_INTERRUPTED', connectionId: 1, message: 'Network interrupted', retrying: true, attempt: 2, delayMs: 1_000 });
			expect(elements.connection?.dataset.state).toBe('stale');
			expect(elements.connectionDetail?.textContent).toContain('last confirmed list');
			expect(elements.connectionDetail?.textContent).toContain('Retry 1 in 1 s');
			expect(elements.list.firstElementChild).toBe(row);
			expect(elements.loading?.textContent).toBe('');
			dispatch({ type: 'LIVE_CONNECTING', connectionId: 2, attempt: 2 });
			expect(elements.connectionDetail?.textContent).toContain('retry 1');
			dispatch({ type: 'LIVE_SNAPSHOT', connectionId: 2, snapshot: { ...snapshot, revision: 2, todos: [{ ...todo, completed: true }] } });
			expect(elements.connectionLabel?.textContent).toBe('Live');
			expect(elements.list.firstElementChild).toBe(row);
			expect(row?.classList.contains('completed')).toBe(true);
			expect(document.activeElement).toBe(elements.input);
			expect(elements.input.value).toBe('A draft remains here');
			expect([elements.input.selectionStart, elements.input.selectionEnd]).toEqual([2, 7]);
			expect(errors).toEqual([]);
		} finally { scope.dispose(); }
	});

	it('shows terminal failure and manual recovery without claiming an empty collection before the first snapshot', () => {
		const { scope, elements, dispatch } = bindFixture();
		try {
			dispatch({ type: 'LIVE_CONNECTING', connectionId: 1, attempt: 0 });
			dispatch({ type: 'LIVE_INTERRUPTED', connectionId: 1, message: 'Invalid live snapshot', retrying: false, attempt: 0 });
			expect(elements.connection?.dataset.state).toBe('error');
			expect(elements.connectionLabel?.textContent).toBe('Connection stopped');
			expect(elements.connectionDetail?.textContent).toContain('Invalid live snapshot');
			expect(elements.connectionDetail?.textContent).toContain('Select Reconnect');
			expect(elements.empty?.textContent).toBe('');
			expect(elements.loading?.textContent).toBe('');
			const message = elements.connectionDetail?.textContent;
			scope.dispose();
			dispatch({ type: 'LIVE_CONNECTING', connectionId: 2, attempt: 0 });
			expect(elements.connectionDetail?.textContent).toBe(message);
		} finally { scope.dispose(); }
	});

	it('preserves the explicit finite-service refresh mode', () => {
		const { scope, elements } = bindFixture(false);
		try {
			expect(elements.refresh?.textContent).toBe('Refresh');
			expect(elements.connection?.dataset.state).toBe('manual');
		} finally { scope.dispose(); }
	});
});

describe('M07 form and filter feedback in the stable Todo view', () => {
	it('keeps native radio selection isolated between two copies of the real application shell', () => {
		const markup = readFileSync('index.html', 'utf8');
		const shell = new DOMParser().parseFromString(markup, 'text/html').querySelector('main')!;
		const firstRoot = shell.cloneNode(true) as HTMLElement;
		const secondRoot = shell.cloneNode(true) as HTMLElement;
		const first = findTodoElements(firstRoot);
		const second = findTodoElements(secondRoot);
		document.body.append(firstRoot, secondRoot);
		const firstValues = new Subject<ViewModel>();
		const secondValues = new Subject<ViewModel>();
		const scope = createScope();
		const errors: unknown[] = [];
		let firstState = createInitialState();
		let secondState = createInitialState();
		try {
			bindTodoView(scope.child(), first, firstValues, () => undefined, error => errors.push(error));
			bindTodoView(scope.child(), second, secondValues, () => undefined, error => errors.push(error));
			firstValues.next(selectViewModel(firstState));
			secondValues.next(selectViewModel(secondState));
			expect(first.filters[0]!.form).not.toBe(second.filters[0]!.form);
			expect(first.filters[0]!.form).not.toBeNull();
			first.filters[1]!.click();
			firstState = reducer(firstState, { type: 'FILTER_CHANGED', filter: 'active' });
			firstValues.next(selectViewModel(firstState));
			expect(second.filters.map(control => control.checked)).toEqual([true, false, false]);
			second.filters[2]!.click();
			secondState = reducer(secondState, { type: 'FILTER_CHANGED', filter: 'completed' });
			secondValues.next(selectViewModel(secondState));
			expect(first.filters.map(control => control.checked)).toEqual([false, true, false]);
			expect(second.filters.map(control => control.checked)).toEqual([false, false, true]);
			expect(firstState.filter).toBe('active');
			expect(secondState.filter).toBe('completed');
			expect(errors).toEqual([]);
		} finally { scope.dispose(); }
	});

	it('associates pure validation with the editable native input without mixing it with operation errors', () => {
		const { scope, elements, errors, dispatch } = bindFixture();
		try {
			expect(elements.input.required).toBe(true);
			expect(elements.form.noValidate).toBe(true);
			expect(elements.input.getAttribute('aria-describedby')).toBe(elements.draftHint?.id);
			expect(elements.input.getAttribute('aria-invalid')).toBe('false');
			expect(elements.submit?.disabled).toBe(true);
			dispatch({ type: 'DRAFT_CHANGED', value: '   ' });
			dispatch({ type: 'DRAFT_BLURRED' });
			expect(elements.input.getAttribute('aria-invalid')).toBe('true');
			expect(elements.draftHint?.textContent).toBe('Enter a task title.');
			expect(elements.error.textContent).toBe('');
			expect(elements.errorDismiss?.hidden).toBe(true);
			dispatch({ type: 'DRAFT_CHANGED', value: 'Keep this draft' });
			elements.input.focus();
			elements.input.setSelectionRange(2, 7, 'backward');
			dispatch({ type: 'DRAFT_BLURRED' });
			expect(elements.input.getAttribute('aria-invalid')).toBe('false');
			expect(elements.draftHint?.textContent).toBe('Give your task a name.');
			expect(elements.submit?.disabled).toBe(false);
			expect(elements.input.disabled).toBe(false);
			expect(document.activeElement).toBe(elements.input);
			expect([elements.input.selectionStart, elements.input.selectionEnd, elements.input.selectionDirection]).toEqual([2, 7, 'backward']);
			expect(errors).toEqual([]);
		} finally { scope.dispose(); }
	});

	it('filters locally, retains matching row focus, and releases rows hidden by the filter', () => {
		const { scope, elements, errors, intents, dispatch } = bindFixture();
		try {
			const completed = { ...todo, id: '2', title: 'Already done', completed: true };
			dispatch({ type: 'LIVE_CONNECTING', connectionId: 1, attempt: 1 });
			dispatch({ type: 'LIVE_SNAPSHOT', connectionId: 1, snapshot: { ...snapshot, todos: [todo, completed] } });
			const activeRow = elements.list.children[0];
			const completedRow = elements.list.children[1];
			const activeCheckbox = activeRow!.querySelector('input')!;
			const removedButton = completedRow!.querySelector('button')!;
			activeCheckbox.focus();
			dispatch({ type: 'FILTER_CHANGED', filter: 'active' });
			expect(elements.filters.map(control => control.checked)).toEqual([false, true, false]);
			expect(elements.list.children).toHaveLength(1);
			expect(elements.list.firstElementChild).toBe(activeRow);
			expect(document.activeElement).toBe(activeCheckbox);
			expect(elements.summary?.textContent).toBe('1 remaining · 1 completed');
			expect(completedRow?.isConnected).toBe(false);
			removedButton.click();
			expect(intents).toEqual([]);
			dispatch({ type: 'LIVE_SNAPSHOT', connectionId: 1, snapshot: { ...snapshot, revision: 2, todos: [{ ...todo, completed: true }, completed] } });
			expect(elements.filteredEmpty?.hidden).toBe(false);
			expect(elements.filteredEmpty?.textContent).toBe('No active tasks. Choose All to see the full list.');
			expect(elements.empty?.textContent).toBe('');
			expect(elements.summary?.textContent).toBe('0 remaining · 2 completed');
			activeCheckbox.dispatchEvent(new Event('change'));
			expect(intents).toEqual([]);
			dispatch({ type: 'FILTER_CHANGED', filter: 'completed' });
			expect(elements.filters.map(control => control.checked)).toEqual([false, false, true]);
			expect(elements.list.children).toHaveLength(2);
			expect(elements.filteredEmpty?.hidden).toBe(true);
			dispatch({ type: 'LIVE_SNAPSHOT', connectionId: 1, snapshot: { ...snapshot, revision: 3, todos: [] } });
			expect(elements.empty?.textContent).toContain('Your list is clear.');
			expect(elements.filteredEmpty?.hidden).toBe(true);
			expect(errors).toEqual([]);
		} finally { scope.dispose(); }
	});

	it('keeps newer input and selection editable while an accepted create settles after a live update', () => {
		const { scope, elements, errors, intents, dispatch, getState } = bindFixture();
		try {
			dispatch({ type: 'LIVE_CONNECTING', connectionId: 1, attempt: 1 });
			dispatch({ type: 'LIVE_SNAPSHOT', connectionId: 1, snapshot });
			const retainedRow = elements.list.firstElementChild;
			dispatch({ type: 'DRAFT_CHANGED', value: 'Submitted draft' });
			const state = getState();
			const intent = interpretTodoIntent({ previous: state, state, message: { type: 'CREATE_REQUESTED', title: state.draft } });
			expect(intent).not.toBeNull();
			dispatch({ type: 'OPERATION_QUEUED', operation: describeOperation(intent!, 'create-1') });
			expect(elements.form.getAttribute('aria-busy')).toBe('true');
			expect(elements.submit?.disabled).toBe(true);
			expect(elements.submit?.textContent).toBe('Adding…');
			expect(elements.input.disabled).toBe(false);
			dispatch({ type: 'DRAFT_CHANGED', value: 'The next task' });
			elements.input.focus();
			elements.input.setSelectionRange(4, 8, 'backward');
			const created = { ...todo, id: '2', title: 'Submitted draft' };
			dispatch({ type: 'LIVE_SNAPSHOT', connectionId: 1, snapshot: { ...snapshot, revision: 2, todos: [todo, created] } });
			dispatch({ type: 'CREATE_SUCCEEDED', operationId: 'create-1', todo: created });
			expect(elements.form.getAttribute('aria-busy')).toBe('false');
			expect(elements.submit?.disabled).toBe(false);
			expect(elements.input.value).toBe('The next task');
			expect(document.activeElement).toBe(elements.input);
			expect([elements.input.selectionStart, elements.input.selectionEnd, elements.input.selectionDirection]).toEqual([4, 8, 'backward']);
			expect(elements.list.firstElementChild).toBe(retainedRow);
			expect(elements.list.children).toHaveLength(2);
			expect(intents).toEqual([]);
			expect(errors).toEqual([]);
		} finally { scope.dispose(); }
	});

	it('shows manual recovery for an uncertain write and dismisses only the message', () => {
		const { scope, elements, errors, intents, dispatch } = bindFixture();
		try {
			dispatch({ type: 'LIVE_CONNECTING', connectionId: 1, attempt: 1 });
			dispatch({ type: 'LIVE_SNAPSHOT', connectionId: 1, snapshot });
			const row = elements.list.firstElementChild;
			dispatch({ type: 'DRAFT_CHANGED', value: 'Keep after failure' });
			dispatch({ type: 'OPERATION_QUEUED', operation: { id: 'create-1', kind: 'create', title: 'Keep after failure' } });
			elements.input.focus();
			elements.input.setSelectionRange(5, 10);
			dispatch({ type: 'OPERATION_FAILED', operationId: 'create-1', message: 'The reply was lost.' });
			expect(elements.error.textContent).toBe('The reply was lost.');
			expect(elements.errorRecovery?.textContent).toContain('may already be saved');
			expect(elements.errorRecovery?.textContent).toContain('Reconnect and review');
			expect(elements.errorRecovery?.hidden).toBe(false);
			expect(elements.errorDismiss?.hidden).toBe(false);
			expect(elements.submit?.disabled).toBe(false);
			dispatch({ type: 'ERROR_DISMISSED' });
			expect(elements.error.textContent).toBe('');
			expect(elements.errorRecovery?.hidden).toBe(true);
			expect(elements.errorDismiss?.hidden).toBe(true);
			expect(elements.input.value).toBe('Keep after failure');
			expect(document.activeElement).toBe(elements.input);
			expect([elements.input.selectionStart, elements.input.selectionEnd]).toEqual([5, 10]);
			expect(elements.list.firstElementChild).toBe(row);
			expect(intents).toEqual([]);
			expect(errors).toEqual([]);
		} finally { scope.dispose(); }
	});
});
