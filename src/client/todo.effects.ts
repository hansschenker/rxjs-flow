import {
	Observable, Subject, Subscriber, catchError, concat, concatMap, defer, exhaustMap, filter,
	ignoreElements, map, merge, of, switchMap, take, tap, throwIfEmpty,
} from 'rxjs';
import { createRequestFailure } from '../shared/http-error';
import type { Transition } from './runtime/program';
import {
	describeOperation, interpretTodoIntent, operationFailed, operationSucceeded,
	type MutationIntent, type TodoIntent,
} from './todo.intents';
import type { TodoService } from './todo.service';
import type { Action, Operation, State } from './todo.state';
import { allocateTraceId, emitTrace, traceObservable, type Trace, type TraceContext } from '../shared/trace';
import { todoOperationId } from './todo.model';

export interface TodoEffectsOptions {
	/** Active plus waiting writes. The default is 32; overflow emits MUTATION_REJECTED. */
	readonly mutationCapacity?: number;
	readonly trace?: Trace;
	readonly traceScope?: string;
}

interface MutationTask {
	readonly intent: MutationIntent;
	readonly operation: Operation;
	readonly ready$: Observable<never>;
	readonly settle: () => void;
}

type RequestOutcome = { readonly value: unknown } | { readonly failure: unknown };

function request$(intent: TodoIntent, service: TodoService): Observable<unknown> {
	switch (intent.kind) {
		case 'load': return service.getAll$();
		case 'create': return service.create$({ title: intent.title });
		case 'update': return service.update$(intent.todoId, { completed: intent.completed });
		case 'delete': return service.remove$(intent.todoId);
	}
}

function operation$(intent: TodoIntent, operation: Operation, service: TodoService,
	trace?: Trace, context?: TraceContext): Observable<Action> {
	function selectedRequest(): Observable<unknown> {
		const selectedService = context?.operationId && service.withOperation
			? service.withOperation(context.operationId) : service;
		return request$(intent, selectedService);
	}
	const finite$ = defer(selectedRequest).pipe(
		take(1),
		throwIfEmpty(() => createRequestFailure({
			kind: 'decode', message: `No result received for ${intent.kind} request.`,
		})),
	);
	// The finite capability selects one result. Its completion is distinct from
	// take(1) releasing the underlying source, and failures precede recovery facts.
	const result$ = traceObservable(finite$, trace, context ?? { scopeId: 'todo.effects', sourceId: 'todo.request' }).pipe(
		map((value): RequestOutcome => ({ value })),
		// Only the finite capability boundary recovers. Interpretation and result
		// projection remain outside catchError, so programming faults reach the host.
		catchError((failure: unknown) => of<RequestOutcome>({ failure })),
		map(outcome => 'failure' in outcome
			? operationFailed(operation, outcome.failure)
			: operationSucceeded(operation, outcome.value)),
	);
	return concat(of<Action>({ type: 'OPERATION_STARTED', operation }), result$);
}

function isLoad(intent: TodoIntent): intent is Extract<TodoIntent, { kind: 'load' }> {
	return intent.kind === 'load';
}

function isCreate(intent: TodoIntent): intent is Extract<TodoIntent, { kind: 'create' }> {
	return intent.kind === 'create';
}

function isOtherMutation(intent: TodoIntent): intent is Extract<TodoIntent, { kind: 'update' | 'delete' }> {
	return intent.kind === 'update' || intent.kind === 'delete';
}

/**
 * Cold, instance-owned effect graph. The mounted root subscribes once and feeds
 * these facts into the model's serialized ingress; view/trace consumers observe
 * model streams. Each additional subscription here intentionally starts a new run.
 *
 * The private subjects connect admission to one concatMap queue. This subscription
 * owns their source, policies and requests. Disposal cancels transports and drops
 * queued tasks; it cannot emit cancellation facts into an already disposed model.
 */
export function todoEffects$(
	transitions$: Observable<Transition<State, Action>>,
	service: TodoService,
	options: TodoEffectsOptions = {},
): Observable<Action> {
	return new Observable<Action>(subscriber => {
		const scopeId = options.traceScope ?? allocateTraceId(options.trace, 'todo.effects');
		const capacity = options.mutationCapacity ?? 32;
		if (!Number.isSafeInteger(capacity) || capacity < 1) {
			throw new RangeError('mutationCapacity must be a positive safe integer.');
		}
		const intents = new Subject<TodoIntent>();
		const mutations = new Subject<MutationTask>();
		let nextId = 0;
		let admitted = 0;
		let activeWrites = 0;
		let activeRead: Operation | undefined;
		function operationContext(operation: Operation): TraceContext {
			return { scopeId, sourceId: `todo.${operation.kind}`,
				...(options.trace ? { operationId: todoOperationId(options.trace, scopeId, operation.id) } : {}),
				metadata: { kind: operation.kind } };
		}
		function queueState(reason: string): void {
			emitTrace(options.trace, { event: 'resource.state', scopeId, sourceId: 'todo.mutation-queue',
				metadata: { active: activeWrites, queued: admitted - activeWrites, count: admitted, capacity, reason } });
		}
		function accepted(operation: Operation): void {
			emitTrace(options.trace, { event: 'intent.accepted', ...operationContext(operation) });
		}

		function admit(intent: MutationIntent, settle: () => void): void {
			if (admitted >= capacity) {
				queueState('overflow');
				subscriber.next({ type: 'MUTATION_REJECTED', message: `Mutation queue is full (capacity ${capacity}). Please try again.` });
				settle();
				return;
			}
			const operation = describeOperation(intent, String(++nextId));
			admitted++;
			// Reserve FIFO position before exposing QUEUED to a possibly reentrant
			// consumer. The completion latch prevents STARTED overtaking QUEUED.
			const ready = new Subject<never>();
			mutations.next({ intent, operation, ready$: ready.asObservable(), settle });
			accepted(operation);
			queueState('admitted');
			if (!subscriber.closed) subscriber.next({ type: 'OPERATION_QUEUED', operation });
			ready.complete();
		}

		function runWrite(task: MutationTask): Observable<Action> {
			function startWrite(): Observable<Action> {
				activeWrites = 1;
				queueState('started');
				return subscriber.closed ? of<Action>() : operation$(task.intent, task.operation, service, options.trace, operationContext(task.operation));
			}
			function settleWrite(action: Action): void {
				if (action.type === 'OPERATION_STARTED') return;
				admitted--;
				activeWrites = 0;
				queueState('settled');
				task.settle();
			}
			return concat(task.ready$, defer(startWrite)).pipe(tap(settleWrite));
		}
		const writes$ = mutations.pipe(concatMap(runWrite));
		const reads$ = intents.pipe(filter(isLoad), switchMap(intent => {
			const previous = activeRead;
			const operation = describeOperation(intent, String(++nextId));
			activeRead = operation;
			accepted(operation);
			const current$ = operation$(intent, operation, service, options.trace, operationContext(operation)).pipe(tap(action => {
				if (action.type !== 'OPERATION_STARTED') activeRead = undefined;
			}));
			// switchMap has already unsubscribed the previous request. Settlement
			// clears activeRead explicitly; finalize is not a cancellation signal.
			return previous
				? concat(of<Action>({ type: 'OPERATION_CANCELLED', operationId: previous.id }), current$)
				: current$;
		}));
		const creates$ = intents.pipe(filter(isCreate), exhaustMap(intent => new Observable<never>(gate => {
			// The gate remains subscribed while this create waits in the same FIFO
			// as update/delete, and closes on success, failure or rejected admission.
			admit(intent, () => gate.complete());
		})));
		const otherWrites$ = intents.pipe(filter(isOtherMutation), tap(intent => admit(intent, () => {})), ignoreElements());

		// Connect every policy before enabling possibly synchronous source inputs.
		// Passing the output subscriber gives it direct ownership of all policies.
		merge(writes$, reads$, creates$, otherWrites$).subscribe(subscriber);
		if (!subscriber.closed) {
			const ingress = new Subscriber<TodoIntent>({
				next: intent => intents.next(intent),
				error: (error: unknown) => subscriber.error(error),
				complete: () => { intents.complete(); mutations.complete(); },
			});
			// Own the actual Subscriber before source activation, so disposal from
			// a synchronous output closes the producer in this same call stack.
			subscriber.add(ingress);
			transitions$.pipe(
				map(interpretTodoIntent),
				filter((intent): intent is TodoIntent => intent !== null),
			).subscribe(ingress);
		}
		// Registered after policy ownership so this snapshot follows request
		// teardown and queue release, including synchronous completion/disposal.
		subscriber.add(function releaseQueue() {
			admitted = 0;
			activeWrites = 0;
			activeRead = undefined;
			queueState('disposed');
		});
	});
}
