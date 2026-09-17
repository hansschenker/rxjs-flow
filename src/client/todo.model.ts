import { distinctUntilChanged, map, type Observable } from 'rxjs';
import { createProgram } from './runtime/program';
import { createInitialState, reducer, type Action, type State } from './todo.state';
import { equalViewModel, selectViewModel, type ViewModel } from './todo.selectors';

export function createTodoModel() {
	const program = createProgram<State, Action>({ initialState: createInitialState, reduce: reducer });
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
		state$,
		transitions$: program.transitions$,
		viewModel$,
	};
}

export type TodoModel = ReturnType<typeof createTodoModel>;
