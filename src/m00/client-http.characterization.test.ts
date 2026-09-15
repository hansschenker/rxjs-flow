// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest';
import { firstValueFrom, of, throwError } from 'rxjs';
import { fromFetch } from 'rxjs/fetch';
import { createClient } from '../client/api';
import { routes } from '../shared/routes';

vi.mock('rxjs/fetch', () => ({ fromFetch: vi.fn() }));
const transport = vi.mocked(fromFetch);
const client = createClient(routes);
afterEach(() => vi.resetAllMocks());

describe('M00 / M03: finite HTTP outcomes', () => {
  it.each([400, 401, 404, 409, 422, 500, 503])('rejects GET HTTP %i instead of emitting its error body as Todos', async status => {
    transport.mockReturnValue(of(new Response(JSON.stringify({ error: 'rejected' }), { status })));
    await expect(firstValueFrom(client.todos.list({}))).rejects.toBeDefined();
  });

  it.each([404, 500])('rejects failed DELETE HTTP %i instead of emitting success', async status => {
    transport.mockReturnValue(of(new Response(JSON.stringify({ error: 'not deleted' }), { status })));
    await expect(firstValueFrom(client.todos.remove({ id: 'missing' }))).rejects.toBeDefined();
  });

  it('control: a valid DELETE 204 emits success', async () => {
    transport.mockReturnValue(of(new Response(null, { status: 204 })));
    await expect(firstValueFrom(client.todos.remove({ id: 'existing' }))).resolves.toBeUndefined();
  });

  it('control: invalid JSON already errors', async () => {
    transport.mockReturnValue(of(new Response('{', { status: 200 })));
    await expect(firstValueFrom(client.todos.list({}))).rejects.toBeInstanceOf(SyntaxError);
  });

  it('control: a transport error already reaches the subscriber', async () => {
    transport.mockReturnValue(throwError(() => new Error('network unavailable')));
    await expect(firstValueFrom(client.todos.list({}))).rejects.toThrow('network unavailable');
  });
});
