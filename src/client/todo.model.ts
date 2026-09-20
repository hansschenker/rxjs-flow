import { distinctUntilChanged, map, type Observable } from 'rxjs';
import { createProgram } from './runtime/program';
import { createInitialState, reducer, type Action, type State, type TodoStateOptions } from './todo.state';
import { equalViewModel, selectViewModel, type ViewModel } from './todo.selectors';
import { allocateTraceId, traceRuntimeId, type Trace, type TraceDetails } from '../shared/trace';
import type { Transition } from './runtime/program';

export interface TodoModelOptions extends TodoStateOptions {
	readonly trace?: Trace;
	readonly traceScope?: string;
}

/** Local IDs remain domain values; diagnostic correlation qualifies their owner. */
export function todoOperationId(trace: Trace, scopeId: string, operationId: string): string {
	return `${traceRuntimeId(trace)}:${scopeId}:${operationId}`;
}

export function createTodoModel(options: TodoModelOptions = {}) {
	const traceScope = options.traceScope ?? allocateTraceId(options.trace, 'todo.model');
	let traceDetails: TraceDetails = {};
	function initialState(): State { return createInitialState(options); }
	function messageTrace(message: Action): TraceDetails {
		const localId = 'operation' in message ? message.operation.id : 'operationId' in message ? message.operationId : undefined;
		return {
			...(localId && options.trace ? { operationId: todoOperationId(options.trace, traceScope, localId) } : {}),
			...('connectionId' in message ? { connectionId: String(message.connectionId) } : {}),
			metadata: { kind: message.type },
		};
	}
	function transitionTrace(transition: Transition<State, Action>): TraceDetails {
		const { state, message } = transition;
		const identity = state.live?.identity;
		traceDetails = {
			...messageTrace(message),
			...(identity ? { collectionId: identity.collectionId, stateGeneration: identity.stateGeneration, revision: identity.revision } : {}),
			metadata: { kind: message.type, count: state.todos.length, pending: state.pending.length,
				changed: state !== transition.previous },
		};
		return traceDetails;
	}
	const program = createProgram<State, Action>({
		initialState, reduce: reducer, trace: options.trace,
		scopeId: `${traceScope}/model`, sourceId: 'todo.ingress', messageTrace, transitionTrace,
	});
	const state$ = program.state$.pipe(distinctUntilChanged());
	const viewModel$: Observable<ViewModel> = state$.pipe(
		map(selectViewModel),
		distinctUntilChanged(equalViewModel),
	);
	return {
		start: program.start,
		dispose: program.dispose,
		dispatch: program.dispatch,
		get closed() { return program.closed; },
		/** Metadata only, captured before the current state reaches render sinks. */
		get traceDetails() { return traceDetails; },
		state$,
		transitions$: program.transitions$,
		viewModel$,
	};
}

export type TodoModel = ReturnType<typeof createTodoModel>;
