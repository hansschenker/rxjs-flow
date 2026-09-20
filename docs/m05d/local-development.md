# M05d — Watch committed Todos through two live consumers

Revision: **rxjs-flow migration r2 — Cloudflare/Hono**. The durable collection now
feeds a bounded SSE response for each live consumer. Disconnecting one consumer
releases that connection; the other continues and the collection remains stored.
This guide preserves the M05d legacy transport checkpoint, accepted in PR #12.
At that milestone the Todo page still used Refresh. The current application uses
M06's separate versioned live route; see the [two-tab application guide](../m06/local-development.md).

## Run the local checkpoint

Use Node **22.22.1** with updated `main` (PR #12 is merged):

```bash
git switch main
git pull --ff-only
npm ci
npm run dev:worker
```

Open **http://localhost:5174** for the
existing Todo page. One command runs the assets, Hono API and local Durable Object
with attached SQLite storage. No separate Node backend is required.

Open **http://localhost:5174/m05d-live.html** for the live checkpoint. The page
has separate Consumer A and Consumer B panels, plus a form that saves to the
same local collection. Each panel displays only its latest received snapshot.

1. Press **Connect A** and **Connect B**. Each receives the current committed
   collection.
2. Use **Save Todo** on this page, or add/change a Todo in the normal Todo page.
   Both connected consumers receive the replacement collection without Refresh.
3. Press **Disconnect A**, then save another Todo. B continues receiving updates.
4. Press **Connect A** again. Its new response begins with the complete current
   collection, including the write made while it was disconnected.
5. Stop and restart `npm run dev:worker` in the same checkout. The page reports
   interrupted connections. Press each **Connect** button to read the persisted
   collection through a new response.

The checkpoint closes EventSource on interruption and reconnects only when you
press Connect. These controls demonstrate response ownership; M06 will define
the Todo application's reconnect policy and live state. The diagnostic Save form
does not update either snapshot panel from its HTTP response.

## Observe the wire directly

In another terminal, leave this running:

```bash
curl -N http://localhost:5174/api/todos/stream
```

Run it in a second terminal for an independent consumer. In Windows PowerShell,
use `curl.exe -N` to select curl rather than a possible PowerShell alias.
Create a Todo in the browser, then stop only one curl command with Ctrl+C. The
other remains active. Restart the stopped curl command to receive the current
full collection.

The existing public format is retained:

```text
event: todos
data: [{"id":"…","title":"Example","completed":false,"createdAt":"…"}]

```

Each data payload is a complete array. Slow consumers may receive the latest
snapshot after intermediate full snapshots coalesce. This is current-state
synchronization, not an event log. Collection/generation/revision metadata remains
inside the private authority transport until M06 defines the versioned public
schema. A disconnected mutation may already have committed; reconnection repairs
current state without proving whether an individual lost response succeeded.

## Repeatable checks

```bash
node scripts/m05d-checkpoint.mjs
```

The script uses a private temporary database and actual local HTTP connections.
It checks two live consumers, continued delivery after one disconnects, a new
initial snapshot on reconnect and the declared response-lifetime behavior.
Exact observed resource counts and interruption/restart coverage are recorded in
the [acceptance report](acceptance.md) and execution record. It leaves the normal
`.wrangler/state` development collection alone.

To exercise built assets and the built Worker through local Wrangler:

```bash
npm run build:worker
node scripts/m05d-checkpoint.mjs --preview
```

The ordinary `npm run preview:worker` preserves production's access-disabled
configuration, so Todo endpoints return 503. For a manual built local checkpoint,
stop any process using port 4174 and run:

```bash
npx wrangler dev --config dist/rxjs_flow_foundation/wrangler.json --local --var TODO_ACCESS_POLICY:local-loopback --persist-to .wrangler/state --ip 127.0.0.1 --port 4174
```

Open **http://localhost:4174/m05d-live.html** for the built checkpoint; the same
`/api/todos/stream` path is available.
`--local` and the explicit variable apply only to this local invocation. No
Cloudflare login, remote resources or deployment is needed.

## Optional automated browser checkpoint

The visible page and HTTP script work with the repository's normal dependencies.
For a repeatable native EventSource browser check, an optional runner accepts
Playwright and Chromium already installed by the caller. Build first, then set
these paths in your Bash environment:

```bash
export PLAYWRIGHT_MODULE_PATH=/absolute/path/to/playwright/index.mjs
export CHROMIUM_EXECUTABLE_PATH=/absolute/path/to/chromium
node scripts/m05d-browser-checkpoint.mjs
```

Replace the example paths with your installed tooling. If Playwright already
manages its browser, `CHROMIUM_EXECUTABLE_PATH` is optional. Advanced local launch
arguments can be supplied as a JSON array in `M05D_CHROMIUM_ARGS`; optional
`M05D_SCREENSHOT` selects an output screenshot path. The runner does not install
dependencies or download a browser, and it is separate from normal CI.

This checkpoint passed with Playwright **1.62.1** and Chromium **153.0.8010.0**
against the built page and Worker: two connections, a visible form write,
independent disconnect/reconnect, full runtime interruption, persisted recovery
and a later live write. The scenario observed exactly five stream requests,
five snapshots per panel and zero uncaught browser errors. It ends with both
panels disconnected. This is the standalone transport checkpoint, not M06/M07
Todo application live-state acceptance.

## What stays stored and what is released

The collection lives in local SQLite below `.wrangler/state/v3`. Keeping that
directory and checkout preserves saved Todos across runtime restarts. A live
connection owns a delivery subscription, reader and bounded pending frames. It
does not own the persisted collection or another consumer's connection.

The authority admits at most 32 live registrations, including initial setup,
alongside its existing 32-operation budget. It allows 1,000 Todos and 120 KiB of
stored snapshot JSON. Each Todo stream retains at most one pending complete
snapshot; the generic SSE transport instead preserves FIFO order within a
16-frame/256-KiB pending budget and a 128-KiB maximum frame. A source fault,
malformed frame or overflow terminates the affected stream visibly and releases
its application resources. These bounds do not measure browser, socket or
Cloudflare internal buffers.

The local-only access policy is unchanged: loopback, matching Origin when
provided, and a server-configured collection. Request parameters cannot select
another collection. Checked-in and built configuration leaves Todo access
disabled; no public release or production authentication is claimed.

The retained Node commands (`npm run dev:server` plus `npm run dev:client`) still
use their independent in-memory collection. Their SSE responses now respect
backpressure, a 32-active-stream limit per listener and explicit shutdown; server restart still resets that collection.
See [M05c's guide](../m05c/local-development.md) for durable restart checks and
[M05d acceptance](acceptance.md) for exact tests, terminal policies and limits.
