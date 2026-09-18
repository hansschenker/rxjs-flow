import { describe, expect, it } from 'vitest';
import type { Todo } from '../../shared/types';
import { createTodoTransition, deleteTodoTransition, filterTodos, updateTodoTransition } from './todo.transitions';

const existing: Todo = { id: 'one', title: 'First', completed: false, createdAt: '2026-09-18T10:00:00.000Z' };

describe('pure Todo transitions', () => {
	it('creates deterministically from injected identity and time without changing existing state', () => {
		const state = Object.freeze([Object.freeze({ ...existing })]);
		const input = { title: 'Second' };
		const metadata = { id: 'two', createdAt: '2026-09-18T11:00:00.000Z' };
		const first = createTodoTransition(state, input, metadata);
		expect(first).toEqual(createTodoTransition(state, input, metadata));
		expect(first.value).toEqual({ ...metadata, title: 'Second', completed: false });
		expect(state).toEqual([existing]);
		first.todos[0].title = 'Independent copy';
		first.value.title = 'Independent result';
		expect(state[0]).toEqual(existing);
		expect(first.todos[1].title).toBe('Second');
	});

	it('rejects an injected identity collision instead of creating duplicate keys', () => {
		expect(() => createTodoTransition([existing], { title: 'Collision' }, existing)).toThrow('Todo identity already exists');
	});

	it('updates only title and completion, retaining identity and creation time', () => {
		const result = updateTodoTransition([existing], existing.id, { title: 'Changed', completed: true });
		expect(result.value).toEqual({ ...existing, title: 'Changed', completed: true });
		expect(existing.title).toBe('First');
		result.value.title = 'Result copy';
		expect(result.todos[0].title).toBe('Changed');
	});

	it('retains current values for empty or undefined updates', () => {
		expect(updateTodoTransition([existing], existing.id, {})).toEqual({ todos: [existing], value: existing });
		expect(updateTodoTransition([existing], existing.id, { title: undefined })).toEqual({ todos: [existing], value: existing });
	});

	it('rejects updates and deletions of a missing Todo', () => {
		expect(() => updateTodoTransition([existing], 'missing', { completed: true })).toThrow('Todo not found');
		expect(() => deleteTodoTransition([existing], 'missing')).toThrow('Todo not found');
	});

	it('deletes without mutating the old collection or surviving objects', () => {
		const second = { ...existing, id: 'two' };
		const before = [existing, second];
		const result = deleteTodoTransition(before, existing.id);
		expect(result).toEqual({ todos: [second], value: null });
		result.todos[0].title = 'Independent';
		expect(before).toEqual([existing, second]);
		expect(second.title).toBe('First');
	});

	it('filters completed values and returns defensive copies for all filters', () => {
		const complete = { ...existing, id: 'two', completed: true };
		const before = [existing, complete];
		expect(filterTodos(before, true)).toEqual([complete]);
		expect(filterTodos(before, false)).toEqual([existing]);
		const all = filterTodos(before);
		expect(all).toEqual(before);
		all[0].title = 'Independent';
		expect(existing.title).toBe('First');
	});
});
