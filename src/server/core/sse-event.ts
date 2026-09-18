import type { SseEvent } from './types';

/** JSON payloads remain the existing SSE wire format; fields cannot inject lines. */
export function encodeSseEvent(value: SseEvent): Uint8Array {
	let text = '';
	for (const name of ['id', 'event'] as const) {
		const field = value[name];
		if (field === undefined) continue;
		if (typeof field !== 'string' || /[\r\n\0]/.test(field)) throw new TypeError('Invalid SSE field');
		text += `${name}: ${field}\n`;
	}
	const data = JSON.stringify(value.data);
	if (data === undefined) throw new TypeError('SSE data cannot be represented as JSON');
	return new TextEncoder().encode(`${text}data: ${data}\n\n`);
}

