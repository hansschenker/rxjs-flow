import { Observable, Subscription, type Observer, type TeardownLogic } from 'rxjs';

export interface Scope {
	readonly closed: boolean;
	add(teardown: TeardownLogic): void;
	child(): Scope;
	dispose(): void;
	subscribe<T>(source: Observable<T>, observer?: Partial<Observer<T>>): Subscription;
}

/** An inert owner; source activation happens only through an explicit subscribe. */
export function createScope(): Scope {
	return scopeFor(new Subscription());
}

function scopeFor(owner: Subscription): Scope {
	return {
		get closed() { return owner.closed; },
		add(teardown) { owner.add(teardown); },
		child() {
			const child = new Subscription();
			// RxJS removes an unsubscribed child from its parent automatically.
			owner.add(child);
			return scopeFor(child);
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
