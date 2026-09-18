import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

// Default: run after build:worker. --dev checks the development path instead.
// Everything below talks only to the local server started by this script.
const projectDirectory = fileURLToPath(new URL('..', import.meta.url));
const viteEntry = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));
const arguments_ = process.argv.slice(2);
const development = arguments_.length === 1 && arguments_[0] === '--dev';
const mode = development ? 'development' : 'built-preview';
const stopping = new AbortController();
const navigationHeaders = { Accept: 'text/html', 'Sec-Fetch-Mode': 'navigate' };
const checks = [];
let preview;
let previewClosed;
let startupError;
let output = '';

function captureOutput(chunk) {
  output = (output + chunk.toString()).slice(-32_768);
}

function interrupt(signal) {
  stopping.abort(new Error(`Smoke interrupted by ${signal}`));
}

const onInterrupt = () => interrupt('SIGINT');
const onTerminate = () => interrupt('SIGTERM');
process.on('SIGINT', onInterrupt);
process.on('SIGTERM', onTerminate);

async function availablePort() {
  const socket = createServer();
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', resolve);
  });
  const { port } = socket.address();
  await new Promise((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
  return port;
}

function startPreview(port) {
  preview = spawn(process.execPath, [
    viteEntry, ...(development ? [] : ['preview']), '--config', 'vite.worker.config.ts',
    '--host', '127.0.0.1', '--port', String(port), '--strictPort',
  ], {
    cwd: projectDirectory,
    env: {
      ...process.env,
      WRANGLER_SEND_METRICS: 'false',
      CLOUDFLARE_SEND_METRICS: 'false',
    },
    // A separate POSIX process group lets cleanup reach workerd as well as Vite.
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  preview.stdout.on('data', captureOutput);
  preview.stderr.on('data', captureOutput);
  preview.on('error', error => { startupError = error; });
  previewClosed = new Promise(resolve => preview.once('close', resolve));
}

async function localFetch(base, path, headers = {}) {
  return fetch(new URL(path, base), {
    headers,
    redirect: 'error',
    signal: AbortSignal.any([stopping.signal, AbortSignal.timeout(5_000)]),
  });
}

async function waitUntilReady(base) {
  const deadline = Date.now() + 60_000;
  let lastError;
  while (Date.now() < deadline) {
    stopping.signal.throwIfAborted();
    if (startupError) throw startupError;
    if (preview.exitCode !== null || preview.signalCode !== null) {
      throw new Error(`${mode} exited before readiness (${preview.exitCode ?? preview.signalCode})`);
    }
    try {
      const response = await localFetch(base, '/', navigationHeaders);
      await response.body?.cancel();
      if (response.ok) return;
      lastError = new Error(`${mode} readiness returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(200, undefined, { signal: stopping.signal });
  }
  throw new Error(`${mode} did not become ready within 60 seconds`, { cause: lastError });
}

async function checkHtml(base, path) {
  const response = await localFetch(base, path, navigationHeaders);
  assert.equal(response.status, 200, `${path}: expected HTML success`);
  assert.match(response.headers.get('content-type') ?? '', /text\/html/);
  const html = await response.text();
  assert.match(html, /<title>rxjs-flow Todos<\/title>/);
  const scriptPaths = Array.from(html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/g), match => match[1]);
  const scriptPath = scriptPaths.find(candidate => development
    ? candidate === '/src/client/browser.ts'
    : candidate.startsWith('/assets/'));
  assert.ok(scriptPath, `${path}: expected ${mode} JSX entry`);
  checks.push({ path, status: response.status, script: scriptPath });
  return scriptPath;
}

async function checkBrowserScript(base, path) {
  const response = await localFetch(base, path);
  assert.equal(response.status, 200, 'Browser JavaScript must be served');
  assert.match(response.headers.get('content-type') ?? '', /(?:java|ecma)script/);
  const javascript = await response.text();
  assert.ok(javascript.length > 0, 'Browser JavaScript must not be empty');
  checks.push({ path, status: response.status, bytes: Buffer.byteLength(javascript) });
}

async function checkFoundation(base) {
  const path = '/api/foundation';
  const response = await localFetch(base, path);
  assert.equal(response.status, 200, `Hono foundation route must run in ${mode}`);
  assert.match(response.headers.get('content-type') ?? '', /application\/json/);
  const body = await response.json();
  assert.deepEqual(body, { runtime: 'workerd', message: 'rxjs-flow foundation' });
  checks.push({ path, status: response.status, body });
}

async function checkUnknownApi(base, path) {
  // Navigation headers exercise Cloudflare's asset/SPA routing precedence.
  const response = await localFetch(base, path, navigationHeaders);
  assert.equal(response.status, 404, `${path}: unknown API must remain a 404`);
  assert.match(response.headers.get('content-type') ?? '', /application\/json/);
  const body = await response.json();
  assert.ok(body !== null && typeof body === 'object' && !Array.isArray(body));
  checks.push({ path, status: response.status, body });
}

async function checkTodoApi(base) {
  const path = '/api/todos';
  const response = await localFetch(base, path);
  assert.match(response.headers.get('content-type') ?? '', /application\/json/);
  if (!development) {
    assert.equal(response.status, 503, 'Built Worker requires an explicit Todo authority');
    checks.push({ path, status: response.status, mode: 'authority not configured', body: await response.json() });
    return;
  }
  assert.equal(response.status, 200, 'Development Worker exposes its explicit volatile Todo capability');
  const initial = await response.json();
  assert.ok(Array.isArray(initial));
  let createdId;
  async function mutation(method, suffix = '', body) {
    return fetch(new URL(path + suffix, base), {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
      signal: AbortSignal.any([stopping.signal, AbortSignal.timeout(5_000)]),
    });
  }
  try {
    const createdResponse = await mutation('POST', '', { title: 'M05b local Worker smoke' });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json();
    createdId = created.id;
    assert.equal(created.title, 'M05b local Worker smoke');
    const updated = await mutation('PUT', '/' + createdId, { completed: true });
    assert.equal(updated.status, 200);
    assert.equal((await updated.json()).completed, true);
    const filtered = await localFetch(base, path + '?completed=true');
    assert.ok((await filtered.json()).some(todo => todo.id === createdId));
    const malformed = await mutation('POST', '', '{');
    assert.equal(malformed.status, 400);
    await malformed.text();
    const invalid = await mutation('POST', '', { title: '' });
    assert.equal(invalid.status, 422);
    await invalid.text();
    const malformedParameter = await mutation('PUT', '/%ZZ', { completed: true });
    assert.equal(malformedParameter.status, 400);
    await malformedParameter.text();
    const healthy = await localFetch(base, path);
    assert.equal(healthy.status, 200);
    assert.ok((await healthy.json()).some(todo => todo.id === createdId));
    const removed = await mutation('DELETE', '/' + createdId);
    assert.equal(removed.status, 204);
    assert.equal(await removed.text(), '');
    const missing = await mutation('DELETE', '/' + createdId);
    assert.equal(missing.status, 404);
    await missing.text();
    createdId = undefined;
    checks.push({ path, statuses: [200, 201, 200, 400, 422, 400, 200, 204, 404], mode: 'volatile local Todo CRUD and failure isolation' });
  } finally {
    if (createdId) await (await mutation('DELETE', '/' + createdId)).text();
  }
}

function signalPreviewGroup(signal) {
  try {
    process.kill(-preview.pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

async function stopPreview() {
  if (!preview?.pid) return;
  if (process.platform === 'win32') {
    // taskkill /T reaches workerd even if it does not handle Vite's signals.
    await new Promise((resolve, reject) => {
      const killer = spawn('taskkill', ['/pid', String(preview.pid), '/T', '/F'], {
        stdio: 'ignore', timeout: 5_000, killSignal: 'SIGKILL',
      });
      killer.once('error', reject);
      killer.once('close', code => {
        if (code === 0 || preview.exitCode !== null || preview.signalCode !== null) resolve();
        else reject(new Error(`Preview process-tree cleanup failed (${code})`));
      });
    });
  } else {
    signalPreviewGroup('SIGTERM');
    const cleanupDeadline = new AbortController();
    try {
      await Promise.race([previewClosed, delay(2_000, undefined, { signal: cleanupDeadline.signal })]);
    } finally {
      cleanupDeadline.abort();
      // Release any descendant left behind after the Vite process exits.
      signalPreviewGroup('SIGKILL');
    }
  }
  await previewClosed;
}

try {
  assert.ok(arguments_.length === 0 || development, 'Usage: node scripts/smoke-worker.mjs [--dev]');
  const port = await availablePort();
  const base = `http://127.0.0.1:${port}`;
  startPreview(port);
  try {
    await waitUntilReady(base);
    const scriptPath = await checkHtml(base, '/');
    await checkBrowserScript(base, scriptPath);
    await checkFoundation(base);
    for (const path of ['/api', '/api/missing', '/api/api/todos']) await checkUnknownApi(base, path);
    await checkTodoApi(base);
    assert.equal(await checkHtml(base, '/unknown-page'), scriptPath, 'SPA fallback uses the same shell');
  } finally {
    await stopPreview();
  }
  console.log(JSON.stringify({ status: 'passed', runtime: 'local workerd', mode, checks }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ status: 'failed', error: String(error), previewOutput: output }, null, 2));
  process.exitCode = 1;
} finally {
  process.removeListener('SIGINT', onInterrupt);
  process.removeListener('SIGTERM', onTerminate);
}
