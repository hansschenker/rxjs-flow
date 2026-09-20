import { afterEach, describe, expect, it } from 'vitest';
import { Subject } from 'rxjs';
import { createScope } from './runtime/scope';
import { createInitialState, reducer, type Action } from './todo.state';
import { selectViewModel, type ViewModel } from './todo.selectors';
import { bindTodoView, findTodoElements } from './todo.view';

afterEach(() => { document.body.replaceChildren(); });

function bindFixture(live = true) {
	document.body.innerHTML = `
		<form id="add-form"><input id="title-input"><button type="submit">Add</button></form>
		<button id="refresh-todos">Refresh</button><p id="todo-summary"></p>
		<div id="connection-state"><strong id="connection-label"></strong><p id="connection-detail"></p></div>
		<div id="loading-state"></div><ul id="todo-list"></ul><div id="empty-state"></div>
		<p id="error-msg"></p><span id="pending-msg"></span>`;
	const scope = createScope();
	const values = new Subject<ViewModel>();
	const elements = findTodoElements(document);
	const errors: unknown[] = [];
	let state = createInitialState(live ? { collectionSource: 'live' } : {});
	bindTodoView(scope, elements, values, () => undefined, error => errors.push(error));
	values.next(selectViewModel(state));
	function dispatch(action: Action) {
		state = reducer(state, action);
		values.next(selectViewModel(state));
	}
	return { scope, elements, errors, dispatch };
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
