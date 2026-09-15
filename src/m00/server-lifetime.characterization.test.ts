// @vitest-environment node
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { Observable, Subject, map, mergeMap, throwError } from 'rxjs';
import { createApp } from '../server/core/app';
import { get, type RouteDefinition } from '../server/core/router';
import type { Effect, SseEvent } from '../server/core/types';

let server: http.Server;
let app: ReturnType<typeof createApp>;
let port: number;
let root: Awaited<ReturnType<typeof app.start>>;
const sources: Subject<SseEvent>[] = [];

beforeEach(() => {
  const listen = http.Server.prototype.listen;
  vi.spyOn(http.Server.prototype, 'listen').mockImplementation(function (this: http.Server, ...args: unknown[]) {
    server = this;
    return Reflect.apply(listen, this, args);
  } as typeof listen);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  for (const source of sources.splice(0)) source.complete();
  await app?.stop();
  if (server) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  vi.restoreAllMocks();
});

const healthy: Effect = requests => requests.pipe(map(() => ({ status: 200, body: 'ok' })));

async function start(routes: RouteDefinition[]) {
  app = createApp([get('/ok', healthy), ...routes], { includeHealthRoutes: false });
  root = await app.start(0);
  if (!server.listening) await once(server, 'listening', { signal: AbortSignal.timeout(2000) });
  port = (server.address() as AddressInfo).port;
}

type Outcome = { status?: number; body?: string; error?: string };
function request(path: string): Promise<Outcome> {
  return new Promise(resolve => {
    const req = http.get({ hostname: '127.0.0.1', port, path, agent: false }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    });
    const deadline = setTimeout(() => req.destroy(new Error('500ms request deadline')), 500);
    req.on('error', error => resolve({ error: error.message }));
    req.on('close', () => clearTimeout(deadline));
  });
}

function openEvents(): Promise<{ request: http.ClientRequest; response: http.IncomingMessage; first: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: '/events', agent: false }, response => {
      response.setEncoding('utf8');
      response.once('data', chunk => { clearTimeout(deadline); resolve({ request: req, response, first: String(chunk) }); });
    });
    const deadline = setTimeout(() => req.destroy(new Error('SSE first-event deadline')), 2000);
    req.on('error', error => { clearTimeout(deadline); reject(error); });
  });
}

async function liveFixture() {
  const source = new Subject<SseEvent>();
  sources.push(source);
  const counts = { active: 0, finalized: 0, requestClosed: 0, responseClosed: 0 };
  const events = new Observable<SseEvent>(observer => {
    counts.active++;
    const subscription = source.subscribe(observer);
    observer.next({ data: 'first' });
    return () => { subscription.unsubscribe(); counts.active--; counts.finalized++; };
  });
  await start([get('/events', requests => requests.pipe(map(() => ({ stream: events }))))]);
  let closeResponse!: () => void;
  const responseClosed = new Promise<void>(resolve => { closeResponse = resolve; });
  server.on('request', (req, res) => {
    req.once('close', () => { counts.requestClosed++; });
    res.once('close', () => { counts.responseClosed++; closeResponse(); });
  });
  const client = await openEvents();
  return { source, counts, responseClosed, client };
}

describe('M00 / M05: real HTTP isolation and SSE ownership', () => {
  it.each(['malformed parameter', 'synchronous handler construction'] as const)('%s must leave the next request serviceable', async scenario => {
    const constructionThrow: Effect = () => { throw new Error('construction failure'); };
    await start([get('/item/:id', healthy), get('/throw', constructionThrow)]);
    expect((await request('/ok')).status).toBe(200);
    const bad = await request(scenario === 'malformed parameter' ? '/item/%ZZ' : '/throw');
    const good = await request('/ok');
    console.log(JSON.stringify({ scenario, bad, good, rootClosed: root.closed }));
    expect(good.status).toBe(200);
    expect(root.closed).toBe(false);
  });

  it('control: an error emitted inside a route is already isolated', async () => {
    const streamFailure: Effect = requests => requests.pipe(mergeMap(() => throwError(() => new Error('stream failure'))));
    await start([get('/stream-error', streamFailure)]);
    expect((await request('/stream-error')).status).toBe(500);
    expect((await request('/ok')).status).toBe(200);
    expect(root.closed).toBe(false);
  });

  it('keeps SSE through GET completion, then disposes it on real response disconnect', async () => {
    const live = await liveFixture();
    expect(live.client.first).toContain('first');
    expect(live.counts.requestClosed).toBe(1);
    expect(live.counts.active).toBe(1);
    const nextChunk = once(live.client.response, 'data', { signal: AbortSignal.timeout(2000) });
    live.source.next({ data: 'second' });
    expect(String((await nextChunk)[0])).toContain('second');
    live.client.response.destroy();
    live.client.request.destroy();
    await live.responseClosed;
    await nextTurn();
    console.log(JSON.stringify({ scenario: 'SSE disconnect', ...live.counts }));
    expect(live.counts.active).toBe(0);
    expect(live.counts.finalized).toBe(1);
  });

  it('disposes live SSE subscriptions when the application stops', async () => {
    const live = await liveFixture();
    await app.stop();
    await nextTurn();
    console.log(JSON.stringify({ scenario: 'app stop with SSE', ...live.counts, rootClosed: root.closed }));
    try {
      expect(live.counts.active).toBe(0);
      expect(live.counts.responseClosed).toBe(1);
    } finally {
      live.client.response.destroy();
      live.client.request.destroy();
    }
  });
});
