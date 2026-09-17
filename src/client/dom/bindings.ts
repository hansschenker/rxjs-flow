import { Observable, Subscription, tap } from 'rxjs';
import type { Scope } from '../runtime/scope';

function reportBindingError(error: unknown): void {
	console.error(error);
}

/** Synchronous DOM commits; completion retains the last committed value. */
function bindValue<T>(
	scope: Scope,
	values$: Observable<T>,
	commit: (value: T) => void,
	onError: (error: unknown) => void,
): Subscription {
	// tap routes a thrown commit into the owned subscription's error boundary.
	return scope.subscribe(values$.pipe(tap(commit)), { error: onError });
}

export function bindText(
	scope: Scope,
	target: Node,
	values$: Observable<string>,
	onError: (error: unknown) => void = reportBindingError,
): Subscription {
	function commitText(value: string): void {
		if (target.textContent !== value) target.textContent = value;
	}
	return bindValue(scope, values$, commitText, onError);
}

export function bindProperty<T extends object, K extends keyof T>(
	scope: Scope,
	target: T,
	key: K,
	values$: Observable<T[K]>,
	onError: (error: unknown) => void = reportBindingError,
): Subscription {
	function commitProperty(value: T[K]): void {
		// Native input can change between identical model values. Compare the DOM,
		// not the preceding emission, and avoid resetting a matching selection.
		if (!Object.is(target[key], value)) target[key] = value;
	}
	return bindValue(scope, values$, commitProperty, onError);
}

export function bindAttribute(
	scope: Scope,
	target: Element,
	name: string,
	values$: Observable<string | null>,
	onError: (error: unknown) => void = reportBindingError,
): Subscription {
	function commitAttribute(value: string | null): void {
		if (target.getAttribute(name) === value) return;
		if (value === null) target.removeAttribute(name);
		else target.setAttribute(name, value);
	}
	return bindValue(scope, values$, commitAttribute, onError);
}

export function bindClass(
	scope: Scope,
	target: Element,
	name: string,
	values$: Observable<boolean>,
	onError: (error: unknown) => void = reportBindingError,
): Subscription {
	function commitClass(value: boolean): void {
		if (target.classList.contains(name) !== value) target.classList.toggle(name, value);
	}
	return bindValue(scope, values$, commitClass, onError);
}

interface ConditionalChild {
	readonly scope: Scope;
	nodes: readonly Node[];
}

/**
 * Owns one child while visible. Repeated true retains it; false releases it.
 * Source completion retains the current child. The returned subscription is
 * the view lifetime: unsubscribe, owner disposal, or source/commit error removes
 * the child and releases its bindings. Sibling DOM is never removed.
 */
export function bindIf(
	scope: Scope,
	container: HTMLElement,
	visible$: Observable<boolean>,
	create: (child: Scope) => Node,
	onError: (error: unknown) => void = reportBindingError,
): Subscription {
	const lifetime = new Subscription();
	scope.add(lifetime);
	const binding = scope.child();
	let current: ConditionalChild | undefined;

	function removeNodes(child: ConditionalChild): void {
		for (const node of child.nodes) {
			if (node.parentNode === container) container.removeChild(node);
		}
	}

	function releaseChild(): void {
		const previous = current;
		current = undefined;
		if (!previous) return;
		try { previous.scope.dispose(); }
		finally { removeNodes(previous); }
	}

	// These owners exist before a synchronous visibility source or factory runs.
	lifetime.add(() => binding.dispose());
	lifetime.add(releaseChild);

	function commitVisibility(visible: boolean): void {
		if (!visible) {
			releaseChild();
			return;
		}
		if (current || lifetime.closed) return;
		const child: ConditionalChild = { scope: binding.child(), nodes: [] };
		current = child;
		const node = create(child.scope);
		child.nodes = node.nodeType === 11 ? Array.from(node.childNodes) : [node];
		function releaseRenderedChild(): void {
			if (current === child) current = undefined;
			removeNodes(child);
		}
		// Adding to an already closed child immediately releases a late factory
		// result. A factory can synchronously hide the content or dispose its owner.
		child.scope.add(releaseRenderedChild);
		if (current === child && !child.scope.closed && !lifetime.closed) {
			container.appendChild(node);
		}
	}

	function failBinding(error: unknown): void {
		try { lifetime.unsubscribe(); }
		finally { onError(error); }
	}

	binding.subscribe(visible$.pipe(tap(commitVisibility)), { error: failBinding });
	return lifetime;
}
