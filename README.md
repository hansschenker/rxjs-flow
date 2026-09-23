# RxJS-Flow

[![CI](https://github.com/hansschenker/rxjs-flow/actions/workflows/ci.yml/badge.svg)](https://github.com/hansschenker/rxjs-flow/actions/workflows/ci.yml)

An **RxJS 7 + TypeScript application-dataflow foundation**, demonstrated by a
custom-JSX Todo application. Events enter an owned state stream; pure functions
derive the view; effects return typed results. Hono serves HTTP on Cloudflare
Workers, and a Durable Object stores and publishes the committed collection.

**Status, 2026-09-23:** M00–M08 are accepted and merged. [M08 PR #15](https://github.com/hansschenker/rxjs-flow/pull/15)
merged at `5362f0392b73c8cd7b8f8fb53e0857b257e55eb3`, with 1,018 passing
tests in its recorded evidence. **M09: completion review and documented delivery**
is implemented and locally verified; acceptance review/merge remains pending.
The [fresh-checkout acceptance record](docs/m09/acceptance.md) records **1,018
passing tests**, build/preview, public CRUD/live/restart checks and a native
browser checkpoint. No public deployment is claimed.

## Run the reference application

Use Node **22.22.1**, also recorded in `.nvmrc`:

```bash
git clone https://github.com/hansschenker/rxjs-flow.git
cd rxjs-flow
npm ci
npm run dev:worker
```

Open **http://localhost:5174** in two tabs. Add, toggle, filter and delete Todos;
both pages receive the same saved collection. Drafts and filters belong to each
mounted app. Saved Todos persist locally beneath `.wrangler/state`; restart
from the same checkout to recover them. Local development needs no Cloudflare
login. The [delivery guide](docs/m09/delivery.md) explains review-branch checkout,
the built preview, storage, verification and supported runtime modes.

The application owns one live connection per mounted app. HTTP mutation replies
settle pending status; accepted live snapshots replace collection content.
Reconnect restores the current collection. It never automatically repeats an
uncertain write. Unmount releases client resources without undoing a server
write that already committed.

## Understand the application

- [Application graph and proven API](docs/m09/application-and-api.md): what flows,
  when execution starts, sharing, effect policies and ownership.
- [Delivery and operations](docs/m09/delivery.md): clean install, build, preview,
  environments, migrations, secrets and the separately gated deployment procedure.
- [M09 acceptance](docs/m09/acceptance.md) and [execution ledger](docs/m09/execution.json):
  exact starting commit, commands, results and limitations.
- [Reference-app controls and recovery](docs/m07/local-development.md).
- [Optional trace checkpoint](docs/m08/local-development.md) and
  [actual temporal traces](docs/m08/temporal-traces.md).

The UI uses a stable shell, synchronous scalar bindings and keyed rows with
child scopes. Rendering preserves node identity, focus and selection and
initiates no network writes. State uses one owned reducer accumulation; more
state or view consumers do not start additional effects. Constructor-injected
tracing is optional, bounded and redacted by default.

## Verify locally

```bash
npm run typecheck
npm test
npm run test:worker
npm run cf:typecheck
npm run build:worker
npm run smoke:worker
node scripts/m09-delivery-checkpoint.mjs
```

`npm test` runs Node/DOM tests; `npm run test:worker` runs the separate local
workerd/SQLite suite. The smoke/checkpoint commands own their local processes
and temporary storage. The M09 checkpoint exercises a built browser asset and
the public `/api` CRUD/live routes, plus routing/access failure boundaries.
See the delivery guide for durable restart, live transport and optional native
browser checks. CI validates; it does not deploy.

## Supported runtime modes

| Mode | Role | State |
|---|---|---|
| Hono / local Workers runtime | Primary reference application and Cloudflare-oriented build | Attached SQLite storage; committed state survives restart |
| Node HTTP | Retained, tested local compatibility mode | Independent in-memory collection; restart resets it |
| Deployed Cloudflare service | Separately reviewed and authorized future delivery | No deployed verification is claimed |

For the Node compatibility mode, run `npm run dev:server` and
`npm run dev:client` in separate terminals. The API uses port 3000; Vite uses
port 5173 and proxies `/api/*` to it. Node is not a second production deployment
target in this milestone. The [runtime decision](docs/runtime-cloudflare-hono.md)
records the supported scope and limitations.

The built configuration intentionally leaves Todo access disabled. An explicit
local preview configuration is documented; no command above creates a remote
Worker, changes account settings or connects the app to a domain.

## Plan, history and contribution

The [canonical roadmap](docs/roadmap-gpt-6-astra-2026-09-15.md), revision
**rxjs-flow migration r2 — Cloudflare/Hono**, records milestone dependencies and
acceptance. Read it with the [architecture contract](docs/dataflow-architecture.md)
and [working agreement](AGENTS.md). M09 is the final planned completion review;
further features and public deployment require a separate scope decision.

Use a dedicated branch and pull request. Record evidence before advancing;
merge, publication, release, remote resources and deployment require their own
authorization. `netxpert.ch` is owner-provided deployment context, not a claim
that this application is served there. Local SQLite persistence does not by
itself establish production security, backup or recovery readiness.

This repository continues the implementation originally developed in
[rxjs-stack](https://github.com/hansschenker/rxjs-stack). Its original history,
**Hans Schenker and Claude (Anthropic)** attribution and [MIT license](LICENSE)
remain. The [M00 evidence](docs/baseline-rxjs-flow-m00.md),
[historical README](docs/archive/README-rxjs-stack-2026-09-15.md), archived plans
and original [CHANGELOG](CHANGELOG.md) release entries preserve that provenance.
The separate `rxjs-fullstack` project is not an implementation source or target.

Package version `1.0.0` is retained as historical metadata. This application is
private for npm publication purposes; it declares no built npm library entry.
No new package release or tag is implied. Optional inherited Claude workflows,
Dependabot configuration and local permission settings remain archived for
separate review. A repository commit does not update the ChatGPT Project
reference copy automatically; [prepared-copy instructions](docs/m09/project-reference/README.md)
describe that separate step.
