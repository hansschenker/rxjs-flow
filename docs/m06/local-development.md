# M06 — Two Todo pages stay synchronized

Revision: **rxjs-flow migration r2 — Cloudflare/Hono**.

The actual Todo application now receives committed collection snapshots live.
Open it in two tabs: a change made in either tab reaches both without Refresh.
Each mounted app owns one live connection. After an interruption it keeps the
last accepted collection visible while reconnecting to the current saved state.

## Run the local application

Use Node **22.22.1**. While this milestone PR is under review:

```bash
git fetch origin
git switch m06/live-state
npm ci
npm run dev:worker
```

After merge, use updated `main` instead. Open **http://localhost:5174** in two
browser tabs. One command serves the existing custom-JSX page, Hono API and local
Durable Object with attached SQLite storage. No separate Node backend or
Cloudflare login is needed.

1. Wait for both pages to report **Live**. Their initial connection
   supplies the complete current collection.
2. Add a Todo in tab A. Both tabs show the same new item without Refresh.
3. Toggle it in tab B, then delete it. Both tabs converge after each saved change.
4. Stop `npm run dev:worker`. Each page keeps its latest collection visible and
   reports the interrupted/reconnecting state.
5. Restart the same command from the same checkout. An automatic retry obtains
   the persisted collection. If all retries have already failed, press
   **Reconnect** in each page.
6. Save another Todo and confirm that both pages receive it live again.

The retry delays are **1, 2, 4 and 8 seconds**, with a **10-second deadline** to
receive the first valid snapshot in each connection attempt. A valid snapshot
resets the consecutive-failure budget. Protocol failure and retry exhaustion
require manual Reconnect. The app closes the prior EventSource before retrying,
so only one reconnect mechanism is active. Closing a tab releases its connection
and pending retries; another tab and the saved collection continue independently.

Before synchronization the status reads **Connecting…**. After interruption it
reads **Reconnecting…**, with the last confirmed list retained; exhausted retries
or a protocol failure show **Connection stopped** with guidance to Reconnect.
The 10-second deadline applies only to the first snapshot. No heartbeat is added,
so a silent partition after synchronization has no fixed detection deadline.
Recovery starts when the browser reports transport failure or you press Reconnect.

## Inspect the live data

In Chrome DevTools, open Network and select the request named `live`. The
request remains open while snapshots arrive; this is expected for SSE. Its
EventStream view shows `todo-snapshot` events. A Todo's `createdAt` value ending
in `Z` is in UTC, independent of where the local server runs.

You can also watch the stream directly:

```bash
curl -N http://localhost:5174/api/todos/live
```

In Windows PowerShell use `curl.exe -N` if `curl` resolves to a PowerShell alias.
The new event format is:

```text
event: todo-snapshot
data: {"schemaVersion":1,"collectionId":"local-reference","stateGeneration":"…","revision":2,"todos":[…]}

```

This example abbreviates the UUID and Todo array for readability. Each real
payload contains the full committed collection. Revisions increase within the
same collection generation. A normal durable runtime restart preserves that
history; a newly created/replaced history has a different generation.

The original `/api/todos/stream` route still emits `event: todos` with a bare
Todo array. The [M05d diagnostic page](../m05d/local-development.md) at
**http://localhost:5174/m05d-live.html** continues to demonstrate that legacy
transport. The Todo application uses the versioned `/api/todos/live` route.

The collection display changes from accepted live snapshots. A mutation's
finite HTTP reply settles its pending operation; it does not add the same Todo
a second time. A lost reply may follow a committed write, so the app does not
automatically replay uncertain mutations. Reconnect restores current state, not
an exactly-once history of events.

## Storage and built local execution

The normal local collection is stored in SQLite below `.wrangler/state/v3`.
Keep this directory and use the same checkout when testing a restart. The live
connection owns delivery resources; closing it does not delete stored Todos.

To run the built browser and Worker locally:

```bash
npm run build:worker
npx wrangler dev --config dist/rxjs_flow_foundation/wrangler.json --local --var TODO_ACCESS_POLICY:local-loopback --persist-to .wrangler/state --ip 127.0.0.1 --port 4174
```

Open **http://localhost:4174** in two tabs and repeat the same scenario. Stop
another process using port 4174 first. Ordinary `npm run preview:worker` keeps
the checked-in access-disabled configuration, so Todo routes return 503; this
explicit local Wrangler invocation enables only the local checkpoint.

The retained Node workflow is still available with `npm run dev:server` and
`npm run dev:client` in separate terminals. It uses its own in-memory collection.
Each factory/reset establishes a fresh generation at revision 0, and server
restart loses that collection. Reset interrupts existing versioned streams;
their next connection reads the replacement history. This is separate from the local Durable Object's persistence.

## Repeatable verification

The optional automated native-browser checkpoint runs the built Todo page in two
independent browser contexts. Build first, then supply locally installed
Playwright and Chromium:

```bash
npm run build:worker
export PLAYWRIGHT_MODULE_PATH=/absolute/path/to/playwright/index.mjs
export CHROMIUM_EXECUTABLE_PATH=/absolute/path/to/chromium
node scripts/m06-browser-checkpoint.mjs
```

Replace those paths with your installed tooling. If Playwright already manages
its browser, `CHROMIUM_EXECUTABLE_PATH` is optional. `M06_CHROMIUM_ARGS` accepts
an optional JSON array of local Chromium arguments; `M06_SCREENSHOT` selects an
optional screenshot output path. The runner adds no repository dependency and
is separate from normal CI. It uses private temporary persistence and does not
modify the normal development collection.

The recorded `browser-live-final` run passed with Playwright **1.62.1** and
Chromium **153.0.8010.0**: six mutation requests and six accepted writes, no finite
list GETs or duplicate rows, preserved keyed row identity and draft focus/
selection, independent manual reconnect, automatic recovery after an offline
attempt, full server interruption/restart with the same stored history, and a
later live write. Consumer A opened five stream requests and received nine
snapshots; B opened two and received eight. There were no uncaught browser errors;
both pages and browser contexts closed during cleanup.

Chromium's offline switch alone left existing SSE connections open. That case
therefore presses Reconnect while offline to test a failed replacement request;
full server shutdown separately verifies spontaneous interruption of established
connections. No fixed detection time for every silent partition is inferred.

The existing HTTP transport and durable restart checkpoints remain useful:

```bash
node scripts/m05d-checkpoint.mjs
node scripts/m05d-checkpoint.mjs --preview
```

Their legacy transport evidence complements the M06 application browser scenario;
it does not substitute for it. Exact final regression results are recorded in the
acceptance report and command ledger.

The [M06 acceptance report](acceptance.md) maps every roadmap task and acceptance
clause, documents ordering/recovery policy and records the executed gates. M07–M09
remain separate milestones. These local checks do not deploy a service or change
`netxpert.ch`.
