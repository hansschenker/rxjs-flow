import { z } from 'zod';
import type { Todo } from './types';

/** Runtime validation for external Todo values; domain types alone cannot decode JSON. */
export const todoSchema: z.ZodType<Todo> = z.object({
	id: z.string().min(1),
	title: z.string().min(1),
	completed: z.boolean(),
	createdAt: z.iso.datetime(),
});

export const todoListSchema = z.array(todoSchema);
