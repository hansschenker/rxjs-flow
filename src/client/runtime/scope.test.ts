import { Observable, Subject, of, timer } from 'rxjs';
import { afterEach, vi } from 'vitest';
import { fromEventSource } from '../sse';
import { createScope } from './scope';

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe('createScope()', () => {
	it('does not activate a source until explicitly subscribed', () => {
		const activate = vi.fn();
		const source = new Observable(activate);
		const scope = createScope();
		expect(scope.closed).toBe(false);
		expect(activate).not.toHaveBeenCalled();
		scope.subscribe(source);
		expect(activate).toHaveBeenCalledOnce();
		scope.dispose();
	});

	it('owns subscriptions and runs every teardown once across repeated disposal', () => {
		const release = vi.fn();
		const otherRelease = vi.fn();
		const scope = createScope();
		const subscription = scope.subscribe(new Observable(() => release));
		scope.add(otherRelease);
		scope.dispose();
		scope.dispose();
		expect(scope.closed).toBe(true);
		expect(subscription.closed).toBe(true);
		expect(release).toHaveBeenCalledOnce();
		expect(otherRelease).toHaveBeenCalledOnce();
	});

	it('removes one child without stopping its sibling or the parent', () => {
		const parent = createScope();
		const first = parent.child();
		const second = parent.child();
		const events = new Subject<number>();
		const firstValues: number[] = [];
		const secondValues: number[] = [];
		const firstRelease = vi.fn();
		const secondRelease = vi.fn();
		first.subscribe(events, { next: value => firstValues.push(value) });
		second.subscribe(events, { next: value => secondValues.push(value) });
		first.add(firstRelease);
		second.add(secondRelease);
		events.next(1);
		first.dispose();
		events.next(2);
		expect(firstValues).toEqual([1]);
		expect(secondValues).toEqual([1, 2]);
		expect(parent.closed).toBe(false);
		expect(second.closed).toBe(false);
		parent.dispose();
		events.next(3);
		expect(second.closed).toBe(true);
		expect(secondValues).toEqual([1, 2]);
		expect(firstRelease).toHaveBeenCalledOnce();
		expect(secondRelease).toHaveBeenCalledOnce();
	});

	it('immediately releases resources added after disposal', () => {
		const scope = createScope();
		const release = vi.fn();
		scope.dispose();
		scope.add(release);
		expect(release).toHaveBeenCalledOnce();
	});

	it('creates a closed child when its parent is already disposed', () => {
		const parent = createScope();
		parent.dispose();
		const child = parent.child();
		const release = vi.fn();
		child.add(release);
		expect(child.closed).toBe(true);
		expect(release).toHaveBeenCalledOnce();
	});

	it('never activates a source for an already disposed owner', () => {
		const scope = createScope();
		const activate = vi.fn();
		scope.dispose();
		const subscription = scope.subscribe(new Observable(activate));
		expect(subscription.closed).toBe(true);
		expect(activate).not.toHaveBeenCalled();
	});

	it('stops synchronous delivery when the first value disposes its owner', () => {
		const scope = createScope();
		const values: number[] = [];
		const subscription = scope.subscribe(of(1, 2, 3), {
			next: value => {
				values.push(value);
				scope.dispose();
			},
		});
		expect(values).toEqual([1]);
		expect(subscription.closed).toBe(true);
	});

	it('releases teardown returned after synchronous owner disposal', () => {
		const scope = createScope();
		const release = vi.fn();
		scope.subscribe(new Observable<number>(subscriber => {
			subscriber.next(1);
			return release;
		}), { next: () => scope.dispose() });
		expect(release).toHaveBeenCalledOnce();
	});

	it('preserves ordinary RxJS error and completion delivery', () => {
		const scope = createScope();
		const error = new Error('source failed');
		const onError = vi.fn();
		const onComplete = vi.fn();
		scope.subscribe(new Observable(subscriber => subscriber.error(error)), { error: onError });
		scope.subscribe(of(1), { complete: onComplete });
		expect(onError).toHaveBeenCalledExactlyOnceWith(error);
		expect(onComplete).toHaveBeenCalledOnce();
		scope.dispose();
	});

	it('cancels scheduled work and prevents its result after disposal', () => {
		vi.useFakeTimers();
		const scope = createScope();
		const receive = vi.fn();
		scope.subscribe(timer(100), { next: receive });
		expect(vi.getTimerCount()).toBe(1);
		scope.dispose();
		expect(vi.getTimerCount()).toBe(0);
		vi.advanceTimersByTime(100);
		expect(receive).not.toHaveBeenCalled();
	});

	it('owns an EventSource connection and ignores results after closing it', () => {
		const listeners = new Map<string, (event: MessageEvent) => void>();
		const connection = {
			addEventListener: (type: string, listener: (event: MessageEvent) => void) => {
				listeners.set(type, listener);
			},
			removeEventListener: vi.fn((type: string) => { listeners.delete(type); }),
			onerror: null as ((event: Event) => void) | null,
			close: vi.fn(),
		};
		const construct = vi.fn(() => connection);
		function decodeNumber(value: unknown): number {
			if (typeof value !== 'number') throw new TypeError('Expected a number');
			return value;
		}
		const scope = createScope();
		const source = fromEventSource('/todos/stream', 'todos', decodeNumber, {
			createEventSource: construct,
		});
		const receive = vi.fn();
		expect(construct).not.toHaveBeenCalled();
		scope.subscribe(source, { next: receive });
		expect(construct).toHaveBeenCalledExactlyOnceWith('/todos/stream');
		const retainedMessage = listeners.get('todos');
		retainedMessage?.(new MessageEvent('todos', { data: '1' }));
		scope.dispose();
		scope.dispose();
		retainedMessage?.(new MessageEvent('todos', { data: '2' }));
		expect(connection.removeEventListener).toHaveBeenCalledExactlyOnceWith('todos', retainedMessage);
		expect(connection.onerror).toBeNull();
		expect(connection.close).toHaveBeenCalledOnce();
		expect(receive).toHaveBeenCalledExactlyOnceWith(1);
	});
});
