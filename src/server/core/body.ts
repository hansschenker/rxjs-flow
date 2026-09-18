import { z } from 'zod';
import { BadRequest } from './errors';

/** Both HTTP adapters bound bytes before accumulating or parsing a body. */
export const MAX_BODY_BYTES = 1024 * 1024;
const jsonBodySchema = z.json();

export function parseJsonBody(text: string): unknown {
	if (text.length === 0) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new BadRequest('Malformed JSON');
	}
	const result = jsonBodySchema.safeParse(parsed);
	if (!result.success) throw new BadRequest('JSON body contains unsupported values');
	return result.data;
}
