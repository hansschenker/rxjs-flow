import { Observable } from 'rxjs';

/**
 * One lazy listener per subscription to an independently hot DOM producer.
 * Capture values and call preventDefault here, before downstream time policies.
 */
export function domEvent$<K extends keyof HTMLElementEventMap, T>(
	target: HTMLElement,
	type: K,
	capture: (event: HTMLElementEventMap[K]) => T,
): Observable<T> {
	return new Observable(subscriber => {
		const listener = (event: HTMLElementEventMap[K]) => {
			try {
				subscriber.next(capture(event));
			} catch (error) {
				subscriber.error(error);
			}
		};
		target.addEventListener(type, listener);
		return () => target.removeEventListener(type, listener);
	});
}
