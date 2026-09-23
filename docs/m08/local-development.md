# M08 — Inspect the reference application's temporal behavior

Revision: **rxjs-flow migration r2 — Cloudflare/Hono**.
Status: accepted and merged in [PR #15](https://github.com/hansschenker/rxjs-flow/pull/15)
at `5362f0392b73c8cd7b8f8fb53e0857b257e55eb3`. Status closeout recorded 2026-09-23.

The Todo page keeps its existing appearance and behavior. M08 adds optional
bounded, redacted observations for explaining work and cleanup. Tracing is off
unless the owner supplies it; ordinary application startup does not log payloads
or expose a global debug controller.

## Run the application

Use Node **22.22.1** with the merged application:

```bash
git fetch origin
git switch main
git pull --ff-only
npm ci
npm run dev:worker
```

Open **http://localhost:5174** in two
tabs. Add, toggle and delete Todos; both tabs receive the same saved collection.
Each keeps its own draft and filter. The [M07 guide](../m07/local-development.md)
explains all controls, validation and recovery behavior. Local development needs
no Cloudflare login, separate Node backend or remote account changes.

## Inspect a bounded trace

On a freshly loaded development page, open Chrome DevTools Console. The browser
entry exports the existing app handle plus inert trace constructors. Importing
the cached entry does not mount another application. Dispose its original owner,
then mount one owner with an explicitly supplied recorder:

```javascript
const host = await import('/src/client/browser.ts');
host.app.dispose();

const recorder = host.createTraceRecorder({ capacity: 500 });
function readBrowserTime() { return performance.now(); }
const trace = host.createTrace({
  runtimeId: 'browser-demo',
  now: readBrowserTime,
  sink: recorder.sink,
});
const tracedApp = host.mountTodoApp(document, { trace });
```

Creating `recorder` and `trace` starts no source, timer or request. The explicit
mount owns activation. Add a Todo, change a filter, then inspect the retained
observations:

```javascript
console.table(recorder.records());
console.log({ dropped: recorder.dropped, diagnostics: trace.diagnostics });
```

The clock is milliseconds from this page's performance clock. `sequence` orders
records from this trace runtime even when two timestamps match. The recorder
keeps at most 500 records here; when full, it replaces the oldest and increments
`dropped`. Reading it starts no effect. Titles, bodies, headers, full error
objects and credentials are not recorded. Runtime/scope labels are developer
metadata; do not put private values in those identifiers.

Dispose the mounted owner when finished, then inspect the final records:

```javascript
tracedApp.dispose();
console.table(recorder.records().slice(-20));
```

Controls are now inactive because the owner released their listeners and live
work. Reload to return to ordinary tracing-disabled startup. Run the setup once
per fresh page, or dispose the previous `tracedApp` before making another owner.
The built checkpoint locates the equivalent exported entry through Vite's build
manifest; a development source URL is not a built asset URL.

## Reproduce automated evidence

```bash
npm test
npm run test:worker
npm run typecheck
npm run cf:typecheck
npm run build:worker
npm run smoke:worker
```

For the optional native-browser checkpoint, supply already installed tooling:

```bash
export PLAYWRIGHT_MODULE_PATH=/absolute/path/to/playwright/index.mjs
export CHROMIUM_EXECUTABLE_PATH=/absolute/path/to/chromium
M08_TRACE_OUTPUT=/tmp/m08-dev-traces.json node scripts/m08-browser-checkpoint.mjs --dev
npm run build:worker
M08_TRACE_OUTPUT=/tmp/m08-built-traces.json node scripts/m08-browser-checkpoint.mjs
```

Replace these paths with your installed tooling. `CHROMIUM_EXECUTABLE_PATH` is
optional when Playwright manages its browser. `M08_CHROMIUM_ARGS` accepts an
optional JSON array of local launch arguments; `M08_SCREENSHOT` selects an
optional screenshot output path. `M08_TRACE_OUTPUT` writes the bounded captured
records and scenario summary. The script starts and stops its own local runtime
with private temporary storage; no browser dependency or download is added to
normal CI.

To print the actual local SQLite/Hono/client trace bundle with no browser:

```bash
npm run test:worker -- src/worker/todo-trace.integration.test.ts --reporter=default --reporter=./scripts/m08-trace-reporter.mjs
```

The host-side reporter emits a `M08_TRACE_CAPTURE` JSON line from test metadata.
It avoids depending on workerd console forwarding. The fixed-clock context labels
in this one local fixture do not represent separately routed remote instances.

The scenario compares the same sequence with tracing disabled and enabled, then
tests actual server restart separately. Recorded request and resource counts,
including development HMR's document lifetime, belong to the
[acceptance report](acceptance.md). Final runs `browser-built-final` and
`browser-dev-final` both passed with equal 13-request trace-disabled/enabled
vectors and zero remaining current-document API requests. The full automated
suites passed 1,018 tests. The [recorded JSON](trace-records.json) preserves actual
selected records and source digests.

The [readable temporal traces](temporal-traces.md) show the captured operation,
cancellation and authority recovery. The [acceptance report](acceptance.md) and
[execution ledger](execution.json) distinguish actual local run results from
reproduction instructions. M08's review-head CI is recorded in its merged PR;
M09 verification is recorded separately in [M09 acceptance](../m09/acceptance.md).

## Evidence boundaries

The Workers integration uses actual local workerd and attached SQLite with a
trusted in-process diagnostic bridge where needed for correlation. Native-browser
checks use the real HTTP/SSE path and client-side trace records. These are
different test arrangements, neither of which forces Cloudflare's remote routing
or observes a deployed service.

Normal local development persists beneath `.wrangler/state`; automated
checkpoints use a private temporary database. Retained Node mode uses independent
memory and resets on restart. Unmount cancels local work; a server write that
already committed remains saved. Reconnect restores the current snapshot without
replaying an uncertain mutation automatically.
