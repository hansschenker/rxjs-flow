# M09 — Local operation and Cloudflare delivery

Revision: **rxjs-flow migration r2 — Cloudflare/Hono**. Updated: 2026-09-23.

The primary runnable application is the custom JSX browser with Hono on the local
Cloudflare Workers runtime and a SQLite-backed Durable Object collection. M09
retains the Node adapter as a tested, local, in-memory compatibility mode for this
revision. The build is locally runnable; public release configuration and actual
Cloudflare deployment remain separate, unperformed work. The
[acceptance report](acceptance.md) records the verified commit and executed gates.

## Fresh checkout and the reference page

Use **Node 22.22.1**, matching CI. These commands are for a new directory; preserve
any existing checkout and its local database. While M09 is under review:

```bash
git clone --branch m09/completion-delivery https://github.com/hansschenker/rxjs-flow.git rxjs-flow-m09
cd rxjs-flow-m09
node --version
npm --version
npm ci
npm run dev:worker
```

After merge, clone or update `main` instead. `npm ci` installs the committed lockfile;
it does not select newer dependency versions. Do not run a starter generator over
this application. All commands below run from the repository root. The explicit
`node node_modules/wrangler/bin/wrangler.js` spelling always uses the installed
project version and cannot download another Wrangler.

Open **http://localhost:5174** in two tabs. Add, edit completion and delete Todos;
both tabs receive committed updates. Filters and unsaved drafts belong to each
mounted page. Browser refresh reconstructs the page from the saved collection.
Stop and restart `dev:worker` from the same directory to retain that collection.
The [reference-app guide](../m07/local-development.md) describes validation,
feedback and reconnect; the [tracing guide](../m08/local-development.md) explains
optional bounded observations.

Development needs no Cloudflare login or separate Node backend. The Vite plugin
uses local bindings (`remoteBindings: false`), binds to `127.0.0.1` and enables the
explicit `local-loopback` Todo policy only for development. Trusted configuration
selects `local-reference`; request headers/query strings cannot select a collection.
The request URL must be loopback, Origin must match when present, and a cross-site
fetch indicator is rejected. This policy supplies no public user authentication.

## Storage and recovery

Saved Todos live in local SQLite files below **`.wrangler/state/v3`**, managed by
the development runtime, not in browser localStorage. `RXJS_FLOW_LOCAL_STATE`
can select another local storage directory before `dev:worker` starts. A different
directory is an independent history; it is not a backup restore or data migration.
Do not delete the state directory to solve a startup problem if its Todos matter.

Each committed envelope contains `schemaVersion`, `collectionId`,
`stateGeneration`, `revision` and `todos`. Reconstruction preserves the committed
generation/revision. Subscriptions and browser drafts are not persisted. The
client receives complete, validated snapshots after reconnect and does not replay
uncertain mutations. A lost reply or local cancellation can follow a successful
server commit; inspect the resynchronized list before deliberately repeating it.

The checkpoints below use their own temporary state, stop their local processes
and remove that state afterward. They do not read or reset the ordinary development
collection. Local state has not been uploaded to Cloudflare.

## Reproduce validation

```bash
npm run typecheck
npm test
npm run test:worker
npm run cf:typecheck
npm run build:worker
npm run smoke:worker
npm run smoke:worker -- --dev
node scripts/m05c-checkpoint.mjs --preview
node scripts/m05d-checkpoint.mjs
node scripts/m05d-checkpoint.mjs --preview
node scripts/m09-delivery-checkpoint.mjs
```

| Command | Boundary exercised |
|---|---|
| `typecheck` | Generates Worker types, then checks client, Worker, Node and both test environments with their separate TypeScript configurations. |
| `npm test` | Pure/domain, RxJS policy, DOM and retained Node lifecycle/HTTP/SSE contracts. |
| `test:worker` | Actual local workerd, Hono adapters and attached Durable Object SQLite. |
| `cf:typecheck` | Checks generated `WorkerEnv` against project configuration and the pinned runtime. |
| `build:worker` | Browser assets and Worker output; browser imports are checked against server/platform leakage. |
| `smoke:worker` | Built HTML/JavaScript, foundation API, JSON API failures, SPA precedence and disabled Todo access. |
| `smoke:worker -- --dev` | Actual local development CRUD and validation failures through `/api`. |
| `m05c-checkpoint --preview` | Built CRUD, concurrent callers and saved contents after a full local runtime restart. |
| `m05d-checkpoint` / `--preview` | Retained legacy SSE wire, independent responses, cancellation and reconnect in development/built output. |
| `m09-delivery-checkpoint` | Built browser asset plus CRUD/versioned live snapshots, access failures and resnapshot recovery through the same public API paths. |

These are reproduction instructions; exact results/counts belong to
[acceptance](acceptance.md) and [execution.json](execution.json). A native browser
checkpoint is also available in `scripts/m08-browser-checkpoint.mjs`; its external
Playwright/Chromium setup is in the tracing guide. It is not a hidden dependency of
`npm ci` or normal CI.

Generated `worker-configuration.d.ts` is ignored and reproducible. The
`cf:typegen` command is `wrangler types --config wrangler.jsonc
worker-configuration.d.ts --env-interface WorkerEnv`. It describes this repository's
configured default environment, not an inspected remote account. No credentials
are required for these local type, test or build commands.

## Build, preview and enabled local built execution

```bash
npm run build:worker
npm run preview:worker
```

Open **http://localhost:4174**. Ordinary preview serves the built page and assets,
but Todo API requests return **503 JSON: Todo access is not configured**. That is
the intended checked-in/built policy, not a broken database or an instruction to
log in. `workers_dev` and `preview_urls` remain `false`; no routes or domains are
configured.

To use the built app with local Todos, stop preview on port 4174 and run:

```bash
node node_modules/wrangler/bin/wrangler.js dev --config dist/rxjs_flow_foundation/wrangler.json --local --var TODO_ACCESS_POLICY:local-loopback --persist-to .wrangler/state --ip 127.0.0.1 --port 4174
```

The override applies to this local process only. Open **http://localhost:4174**.
The explicit persistence directory is kept between runs. This is built code in
local workerd; it does not publish an application or validate a remote deployment.
For an isolated built check use the automated checkpoints instead.

The build produces `dist/client` and
`dist/rxjs_flow_foundation/wrangler.json` with its Worker JavaScript. Deploying
only the static folder would omit the API and authority. Use the generated config
with its generated asset path; do not copy source config over it or manually edit
build output to claim a new reviewed release.

## Same-origin HTTP and asset routing

The browser requests `/api/...` on its own origin. In Worker mode that prefix is
kept through asset routing and registered once by the Hono adapter. Canonical
route definitions remain `/todos`, `/todos/:id`, `/todos/live` and `/todos/stream`.
`/api/api/todos` is not an alternate route.

`wrangler.jsonc` sets `assets.run_worker_first` to `["/api", "/api/*"]` and
`not_found_handling` to `single-page-application`. Thus API responses are handled
before the HTML fallback, including browser navigation requests. Cloudflare
documents this explicit route-pattern precedence [1]. This project's checkpoints
verify the behavior against built output.

| Request | Expected result |
|---|---|
| `/` and built JavaScript asset | HTML page and executable browser asset. |
| Unknown non-API page navigation | The SPA shell. |
| `/api`, `/api/missing`, `/api/api/todos` | 404 JSON, never the HTML shell. |
| `/api/todos` with access disabled | 503 JSON. |
| Local Todo request with mismatched Origin or forbidden collection selector | 403 JSON. |
| `/api/todos/live` with permitted local access | `text/event-stream`, versioned `todo-snapshot` events. |
| `/api/todos/stream` with permitted local access | Legacy `todos` events with bare Todo arrays. |

## Retained Node mode

**Decision:** retain the existing Node HTTP adapter as a supported local
compatibility mode for r2. Hono/Workers remains the primary durable runtime.
Existing Node HTTP, startup/readiness/failure, stop/port-release and SSE tests stay
in `npm test`. This decision adds no production Node deployment, process manager,
separate database or promise of indefinite dual-platform support.

Use two terminals from the installed checkout:

```bash
npm run dev:server
```

```bash
npm run dev:client
```

Open **http://localhost:5173**. Vite proxies `/api` to port 3000 and removes the
prefix once. Direct Node API routes are `/todos`, `/todos/live` and
`/todos/stream`. The Node collection is independent `node-memory`, seeded with
`Learn rxjs-stack`. Reloading the page sees that process's current memory; a
server restart recreates the seed and a new history. `store.reset()` also changes
history. No Todo data is transferred between Node and Worker modes.

The Node launcher calls `app.start(3000)` without a host restriction or process
signal hook. It does not enforce the Worker's loopback access policy. Use it on a
trusted development machine without publishing or forwarding the listener.
The explicit `app.stop()` lifecycle is tested; terminating the launcher is not
claimed to invoke those application shutdown hooks. Stop both terminal commands
when finished. The supported migration from Node usage is to start Worker mode
and create its separate local collection; there is no automatic memory importer.

## Wrangler authentication and future environments

The following commands are for an operator preparing a **separately authorized
release**. They are not prerequisites for local development and were not executed
as authentication during M09:

```bash
node node_modules/wrangler/bin/wrangler.js login
node node_modules/wrangler/bin/wrangler.js whoami
```

`login` authorizes the developer with Cloudflare OAuth; `whoami` checks that
identity/account access. This does not authenticate users of the Todo application.
If a local OAuth callback cannot be reached, the pinned CLI also supports
`login --device`. Follow the interactive authorization on the operator's machine,
and keep returned credentials out of repository artifacts. CLI help for login,
deploy and secret handling was checked locally without authenticating [2].

There are currently **no named staging/production environments**. Source
`wrangler.jsonc` describes the default `rxjs-flow-foundation` Worker, binding
`TODO_COLLECTIONS`, collection `local-reference`, and disabled public Todo access.
Do not invent an environment by adding `--env production` to a current command.

If a later reviewed release introduces a named environment, define its Worker
identity, variables and bindings deliberately; bindings/variables do not inherit
automatically [3]. Select the environment at Vite development/build time with
`CLOUDFLARE_ENV`. Vite emits a flattened config for that choice; selecting a
different environment at preview/deploy time does not retarget it [4]. For example,
only after `staging` exists and has been reviewed:

```bash
CLOUDFLARE_ENV=staging npm run build:worker
```

This assignment uses Bash syntax. In PowerShell, set `$env:CLOUDFLARE_ENV` before
the command and remove it afterward. Inspect the generated Worker name, asset
path, bindings, migrations and access policy before using that artifact. A Vite
mode alone does not select a Cloudflare environment in this project's config.

## Migration declarations and secrets

The committed declaration is:

```json
{ "tag": "m05c-v1", "new_sqlite_classes": ["TodoCollection"] }
```

It introduces the SQLite-backed class used by `TODO_COLLECTIONS`. Local workerd
tests exercise that declaration; no remote namespace or migration is claimed.
In Cloudflare's migration-array workflow, deployment applies unapplied migration
tags in order. Preserve the existing history and review any subsequent class
rename, deletion or transfer. Changing stored schema also requires application
compatibility/recovery work; a class migration does not transform the snapshot
envelope automatically [5]. This is attached Durable Object storage, not a D1
database; a D1 migration command does not apply here.

Cloudflare's current docs also describe a newer `exports` configuration. This
repository deliberately keeps its verified `migrations` representation; M09 does
not convert it. The formats are mutually exclusive in the pinned Wrangler schema,
and switching an already deployed Worker to `exports` cannot later be reversed
to `migrations` according to the platform docs [6]. Reassess such a change in a
dedicated release/toolchain decision.

The reference application requires **no application secrets**:
`secrets.required` is empty. Wrangler's developer OAuth credentials and a future
CI deployment token are separate from Worker application bindings. Keep secrets
out of source, `vars`, browser bundles, command arguments and trace labels. Local
`.dev.vars*`/`.env*` secret files are ignored. The explicit required-name list
restricts additional local secret names [4]; the pinned loader also permits
loaded values to override keys already present in `vars`. Thus an empty required
list is not a guarantee that a developer's local files cannot change existing
configuration. CI disables `.env` dev-variable loading and supplies no deployment
credentials; clean-checkout verification contains no local secret files.

A future release that needs a secret must review its name, target environment and
consumer first. Use an ignored local secret file for development or an approved
remote secret operation for deployment; regenerate types after changing required
names. **`wrangler secret put` creates and immediately deploys a Worker version**;
it is a release action, not an innocuous setup check. `versions secret put` also
creates a remote version. Neither command is part of M09 execution [7].

## Gated deployment procedure

This procedure documents the next release boundary. It is not authorization to
run it. The current release blocker is concrete: Todo access accepts only
`local-loopback`, and built configuration disables it. There is no reviewed public
access policy or routing target. Setting the current policy to `local-loopback`
on a public Worker would still reject public-host Todo requests.

1. Review the exact commit, account, Worker/environment, collection scope and
   public access policy. Implement and test any required public access behavior
   in its own change; review intended routing separately. `netxpert.ch` is context,
   not permission to change its DNS, routes or domains.
2. Run a clean install and every local validation gate above on that candidate.
   Select any reviewed environment at build time and inspect the generated config.
   Record the commit, tool versions and artifact identity. An optional local
   packaging check is:

   ```bash
   node node_modules/wrangler/bin/wrangler.js deploy --config dist/rxjs_flow_foundation/wrangler.json --dry-run
   ```

   The pinned CLI defines this as compilation/checks without uploading. It is not
   remote authorization, migration application or deployed acceptance.
3. After explicit release authorization, the operator authenticates, confirms
   account access, and performs only the reviewed secret/resource preparation.
   Confirm the exact migration effects and a storage-compatible rollback/recovery
   plan before the remote write.
4. Deploy that reviewed generated artifact with project-local Wrangler:

   ```bash
   node node_modules/wrangler/bin/wrangler.js deploy --config dist/rxjs_flow_foundation/wrangler.json
   ```

   This uploads code/assets and can apply configured migrations/routing. It must
   not be run merely because local tests or a PR passed. No default deploy script,
   CI deploy job, release tag or package publication is introduced by M09.
5. Record the actual remote deployment identity and URL. Verify the page/asset,
   permitted and rejected API calls, validation, versioned SSE across two clients,
   saved state and interruption recovery against that service. Local process
   restart evidence cannot stand in for this remote verification. Do not describe
   `netxpert.ch` as serving the app until that is actually verified.

Deployment version rollback is not a backup restore: Worker versions do not
capture associated storage state [8]. No backup schedule, restore drill or
disaster-recovery guarantee has been established for this application.

## Remaining operational limits

| Area | Current boundary |
|---|---|
| Access | One configured local collection; no public user/tenant authentication or reviewed public sharing policy. |
| Persistence | One validated snapshot envelope, 1,000 Todos and 120 KiB; unsupported/corrupt stored data fails without silently replacing history. No production backup/restore procedure has been tested. |
| Capacity | 32 admitted authority operations and 32 active/registering live consumers per collection; bounded application frame queues are not a measured service capacity or a bound on platform/network buffers. |
| Delivery | Complete snapshots may coalesce; reconnect repairs current state, not an exactly-once event history. Writes are not automatically retried. |
| Time | Client reconnect delays are 1, 2, 4 and 8 seconds with a 10-second first-snapshot deadline per attempt. No heartbeat bounds silent-partition detection after synchronization. |
| Failure | Commit followed by lost response is uncertain to the client. Failed flush blocks further snapshots from that authority activation until reconstruction. Cancellation is not rollback. |
| Observation | Optional bounded/redacted local traces, no deployed distributed tracing or production alerting. Runtime-local clocks do not establish global order. |
| Operations | No remote account/resource audit, production load test, availability objective, cost/capacity sign-off or actual deployed verification. |

## Primary platform references

Checked on **2026-09-23**. These describe platform behavior, not project execution
evidence; pinned CLI/schema checks and the acceptance record describe this build.

1. [Static asset SPA routing and `run_worker_first`](https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/)
2. [Wrangler login and whoami](https://developers.cloudflare.com/workers/wrangler/commands/general/)
3. [Wrangler environments and non-inheritable bindings](https://developers.cloudflare.com/workers/wrangler/environments/)
4. [Cloudflare environments with Vite and local secret loading](https://developers.cloudflare.com/workers/vite-plugin/reference/cloudflare-environments/)
5. [Durable Object class migrations (migration-array workflow)](https://developers.cloudflare.com/durable-objects/reference/durable-object-class-migrations-legacy/)
6. [Durable Object class exports and transition from migrations](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)
7. [Worker secrets and deployment effects](https://developers.cloudflare.com/workers/configuration/secrets/)
8. [Worker versions and deployments](https://developers.cloudflare.com/workers/versions-and-deployments/)
