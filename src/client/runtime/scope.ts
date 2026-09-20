import { Observable, Subscription, type Observer, type TeardownLogic } from 'rxjs';
import { allocateTraceId, emitTrace, type Trace } from '../../shared/trace';

export interface Scope {
	readonly closed: boolean;
	add(teardown: TeardownLogic): void;
	child(): Scope;
	dispose(): void;
	subscribe<T>(source: Observable<T>, observer?: Partial<Observer<T>>): Subscription;
}

export interface ScopeOptions {
	readonly trace?: Trace;
	readonly id?: string;
}

/** An inert owner; source activation happens only through an explicit subscribe. */
export function createScope(options: ScopeOptions = {}): Scope {
	return scopeFor(new Subscription(), options.trace, options.id ?? allocateTraceId(options.trace, 'scope'));
}

function scopeFor(owner: Subscription, trace?: Trace, id?: string): Scope {
	let children = 0;
	// This records cancellation initiation. Actual resource release is established
	// by the owned teardowns, not by the presence of this diagnostic event.
	if (trace && id) owner.add(() => emitTrace(trace, { event: 'scope.dispose', scopeId: id, sourceId: 'scope' }));
	return {
		get closed() { return owner.closed; },
		add(teardown) { owner.add(teardown); },
		child() {
			const child = new Subscription();
			// RxJS removes an unsubscribed child from its parent automatically.
			owner.add(child);
			return scopeFor(child, trace, id ? `${id}/${++children}` : undefined);
		},
		dispose() { owner.unsubscribe(); },
		subscribe<T>(source: Observable<T>, observer?: Partial<Observer<T>>) {
			return new Observable<T>(subscriber => {
				// Own the actual subscriber before synchronous source code can run.
				owner.add(subscriber);
				if (!subscriber.closed) source.subscribe(subscriber);
			}).subscribe(observer);
		},
	};
}
