import { describe, expect, it } from 'vitest';
import { describeOperation, interpretTodoIntent } from './todo.intents';
import { createInitialState, reducer, type State } from './todo.state';
import { selectViewModel } from './todo.selectors';
import { validateTodoDraft } from './todo.form';

const created = { id: 'created', title: 'First task', completed: false, createdAt: '2026-01-01T00:00:00.000Z' };

function changeDraft(state: State, value: string): State {
	return reducer(state, { type: 'DRAFT_CHANGED', value });
}

function acceptDraft(state: State): State {
	const message = { type: 'CREATE_REQUESTED' as const, title: state.draft };
	const next = reducer(state, message);
	const intent = interpretTodoIntent({ previous: state, state: next, message });
	if (!intent) throw new Error('Expected a valid create intent.');
	return reducer(next, { type: 'OPERATION_QUEUED', operation: describeOperation(intent, 'create') });
}

function succeed(state: State): State {
	return reducer(state, { type: 'CREATE_SUCCEEDED', operationId: 'create', todo: created });
}

describe('accepted draft identity', () => {
	it('captures exact submitted text and its revision, then clears only unchanged accepted text', () => {
		const touched = reducer(changeDraft(createInitialState(), '  First task  '), { type: 'DRAFT_BLURRED' });
		const pending = acceptDraft(touched);
		expect(pending.pending).toEqual([{ id: 'create', kind: 'create', title: 'First task',
			submittedDraft: { value: '  First task  ', revision: 1 } }]);
		const settled = succeed(pending);
		expect(settled).toMatchObject({ draft: '', draftRevision: 2, draftTouched: false, pending: [] });
		expect(selectViewModel(settled)).toMatchObject({ draftError: null, draftInvalid: false, canSubmit: false });
	});

	it('preserves a newer edit even when its text returns to the submitted value', () => {
		const pending = acceptDraft(changeDraft(createInitialState(), 'First task'));
		const away = changeDraft(pending, 'Something else');
		const back = changeDraft(away, 'First task');
		expect(succeed(back).draft).toBe('First task');
	});

	it('preserves a newer whitespace edit even when the normalized title is unchanged', () => {
		const pending = acceptDraft(changeDraft(createInitialState(), 'First task'));
		expect(succeed(changeDraft(pending, ' First task ')).draft).toBe(' First task ');
	});

	it('keeps duplicate input notifications at the same revision and clears the accepted draft', () => {
		const pending = acceptDraft(changeDraft(createInitialState(), 'First task'));
		expect(changeDraft(pending, 'First task')).toBe(pending);
		expect(succeed(pending).draft).toBe('');
	});

	it('keeps the accepted capture while a create is queued and another draft is typed', () => {
		const waiting = acceptDraft(changeDraft(createInitialState(), 'First task'));
		const typed = changeDraft(waiting, 'Next task');
		const operation = waiting.pending[0];
		const started = reducer(typed, { type: 'OPERATION_STARTED', operation });
		expect(started).toBe(typed);
		expect(succeed(started)).toMatchObject({ draft: 'Next task', pending: [] });
	});

	it('does not clear text for an injected operation without submitted-draft identity', () => {
		const state = changeDraft(createInitialState(), 'First task');
		const queued = reducer(state, { type: 'OPERATION_QUEUED', operation: { id: 'create', kind: 'create', title: 'First task' } });
		expect(succeed(queued).draft).toBe('First task');
	});

	it('does not assign current draft identity to a different submitted value', () => {
		const state = changeDraft(createInitialState(), 'Newer task');
		const message = { type: 'CREATE_REQUESTED' as const, title: 'First task' };
		const intent = interpretTodoIntent({ previous: state, state, message });
		expect(intent).toEqual({ kind: 'create', title: 'First task' });
	});

	it('owns nested accepted-draft data against later caller mutation', () => {
		const state = changeDraft(createInitialState(), 'First task');
		const submittedDraft = { value: 'First task', revision: state.draftRevision };
		const operation = describeOperation({ kind: 'create', title: 'First task', submittedDraft }, 'create');
		submittedDraft.value = 'External change';
		const queued = reducer(state, { type: 'OPERATION_QUEUED', operation });
		if (operation.kind !== 'create' || !operation.submittedDraft) throw new Error('Expected draft capture');
		(operation.submittedDraft as { value: string }).value = 'Later external change';
		expect(succeed(queued).draft).toBe('');
	});
});

describe('pure validation and recoverable form state', () => {
	it.each(['', ' ', '\t\n'])('rejects blank draft %j before an effect is described', value => {
		const state = changeDraft(createInitialState(), value);
		expect(validateTodoDraft(value)).toEqual({ title: '', error: 'Enter a task title.' });
		expect(selectViewModel(state)).toMatchObject({ canSubmit: false, draftError: null, draftInvalid: false });
		const message = { type: 'CREATE_REQUESTED' as const, title: value };
		const attempted = reducer(state, message);
		expect(interpretTodoIntent({ previous: state, state: attempted, message })).toBeNull();
		expect(selectViewModel(attempted)).toMatchObject({ canSubmit: false, draftError: 'Enter a task title.', draftInvalid: true });
		expect(attempted.pending).toEqual([]);
	});

	it('exposes validation after blur and recovers as the next valid draft flows into state', () => {
		const touched = reducer(createInitialState(), { type: 'DRAFT_BLURRED' });
		expect(selectViewModel(touched).draftInvalid).toBe(true);
		const corrected = changeDraft(touched, '  Valid task\n');
		expect(selectViewModel(corrected)).toMatchObject({ draft: '  Valid task\n', canSubmit: true, draftError: null, draftInvalid: false });
		expect(validateTodoDraft(corrected.draft)).toEqual({ title: 'Valid task', error: null });
	});

	it.each(['network', 'decode'] as const)('retains a %s-failed draft and requests reconciliation before a deliberate new submission', kind => {
		const pending = acceptDraft(changeDraft(createInitialState({ collectionSource: 'live' }), 'First task'));
		const failed = reducer(pending, { type: 'OPERATION_FAILED', operationId: 'create', message: 'Request failed.',
			failure: { kind, message: 'Request failed.' } });
		expect(failed).toMatchObject({ draft: 'First task', failedOperation: 'create', pending: [] });
		expect(selectViewModel(failed).recoveryHint).toContain('may already be saved');
		expect(selectViewModel(failed).canSubmit).toBe(true);
		const dismissed = reducer(failed, { type: 'ERROR_DISMISSED' });
		expect(dismissed).toMatchObject({ draft: 'First task', failedOperation: null, failure: null, error: null });
		expect(selectViewModel(dismissed).recoveryHint).toBeNull();
	});

	it('preserves server validation rejection and lets a corrected draft be submitted', () => {
		const pending = acceptDraft(changeDraft(createInitialState(), 'First task'));
		const failed = reducer(pending, { type: 'OPERATION_FAILED', operationId: 'create', message: 'Server rejected title.',
			failure: { kind: 'http', status: 422, message: 'Server rejected title.' } });
		expect(failed.todos).toBe(pending.todos);
		expect(selectViewModel(failed).recoveryHint).toContain('request was rejected');
		const corrected = acceptDraft(changeDraft(failed, 'Corrected task'));
		expect(corrected).toMatchObject({ error: null, failure: null, failedOperation: null });
		expect(corrected.pending[0]).toMatchObject({ title: 'Corrected task' });
	});

	it.each(['not-committed', 'unknown'] as const)('honors the server %s outcome without inferring rollback from a status code', outcome => {
		const pending = acceptDraft(changeDraft(createInitialState(), 'First task'));
		const failed = reducer(pending, { type: 'OPERATION_FAILED', operationId: 'create', message: 'Storage unavailable.',
			failure: { kind: 'http', status: 503, message: 'Storage unavailable.', details: { outcome } } });
		expect(selectViewModel(failed).recoveryHint).toContain(outcome === 'unknown' ? 'may already be saved' : 'did not save');
	});
});
