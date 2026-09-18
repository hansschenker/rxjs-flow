# M05c — Todos that survive a local runtime restart

Revision: **rxjs-flow migration r2 — Cloudflare/Hono**. The existing Todo page now
uses a Durable Object collection with attached SQLite storage in the local
Cloudflare Workers runtime. Saved Todos survive both browser refresh and stopping
and restarting that runtime.

## Run the page

Use Node **22.22.1**. While the milestone PR is under review:

```bash
git fetch origin
git switch m05c/durable-todos
npm ci
npm run dev:worker
```

After merge, use updated `main` instead. Open **http://localhost:5174**. This one
command serves the page, Hono API and local collection authority. A separate Node
backend is not needed.

1. Add a Todo and change its completed checkbox.
2. Open the same URL in another tab. Both tabs address the same collection.
3. Add another Todo in either tab. Use the app's **Refresh** button in the other
   tab to read the updated collection.
4. Stop the development command with Ctrl+C, then run `npm run dev:worker` again
   from the same checkout.
5. Reload both tabs. The saved Todos and their completed values remain.

Updates between tabs still require Refresh. Worker live delivery is M05d and
application live synchronization is M06. A draft that has not been submitted is
not stored as a Todo; preserving input during the app's Refresh operation and
persisting saved data are separate behaviors.

## Where the data lives

The local runtime writes SQLite files below **`.wrangler/state/v3`** in this
checkout. This is local disk storage managed by the Cloudflare development tools.
The browser reads it through `/api/todos`; it does not store the saved collection
in browser localStorage. Keeping the same checkout and state directory preserves
the collection across command restarts. Removing that state or using a different
state directory creates a separate local history.

The configured collection is `local-reference`. It starts **empty** the first
time it is accessed. Todos from M05b's volatile in-memory Worker demo are not
transferred automatically. The retained Node mode (`dev:server` plus `dev:client`)
still uses its own in-memory store and resets when its server restarts.

Each committed storage record contains the Todos together with schema version,
collection identity, state generation and revision. A mutation reads and validates
the previous record, applies a named pure transition, and commits the entire next
record atomically before reporting success. Ordinary reconstruction retains the
same generation and revision; reading does not increment the revision.

## Repeatable two-caller and restart checks

```bash
node scripts/m05c-checkpoint.mjs
```

The script starts the actual local development runtime, exercises API validation
and CRUD, overlaps writes from two independent HTTP callers, stops the runtime,
and starts it again against the same disk state. It checks that two new callers
read the exact saved collection after restart. The script uses a private temporary
database and cleans it up; your normal development collection is not changed.

To exercise the built browser assets and Worker:

```bash
npm run build:worker
node scripts/m05c-checkpoint.mjs --preview
```

Here `--preview` runs the built artifact through **local Wrangler**, with the
explicit local access policy and an isolated database. The ordinary Vite preview
command remains a separate check: `npm run preview:worker` serves the built shell,
but `/api/todos` returns **503: Todo access is not configured**.

To open the built page with persistent local Todos yourself, stop any process
using port 4174 and run this single command in Bash or PowerShell:

```bash
npx wrangler dev --config dist/rxjs_flow_foundation/wrangler.json --local --var TODO_ACCESS_POLICY:local-loopback --persist-to .wrangler/state --ip 127.0.0.1 --port 4174
```

Open **http://localhost:4174**. `--local` runs the built Worker on this computer;
`--var` enables only this local invocation. No Cloudflare account login or remote
deployment is part of these checkpoints.

## Access and failure behavior

Development binds to loopback. Trusted configuration selects the collection;
request query parameters or headers cannot select another one. Browser Origin,
when present, must match the request origin, and cross-site requests are rejected.
The checked-in and built configuration keeps Todo access disabled. This local
reference policy is not a production login or sharing system.

The authority admits at most **32 active and waiting application operations**.
Each collection is limited to **1,000 Todos** and **120 KiB** of snapshot JSON.
Busy admission returns 503; a mutation that would exceed collection capacity
returns 507 without committing that change. These are application limits, not a
bound on Cloudflare's internal delivery queue. Live subscriber capacity is zero
until M05d implements that path.

A confirmed transaction failure returns a structured failure and retains the
previous committed state. A connection can disappear after a mutation commits;
the caller then cannot infer whether it committed from the lost response alone.
Read the collection again before deciding what to do. The implementation does
not automatically retry a mutation or claim that cancellation rolls it back.

See the [acceptance report](acceptance.md) for the exact commands, results,
storage-failure tests and limits of local evidence.
