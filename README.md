# RxJS-Flow

[![CI](https://github.com/hansschenker/rxjs-flow/actions/workflows/ci.yml/badge.svg)](https://github.com/hansschenker/rxjs-flow/actions/workflows/ci.yml)

An **RxJS 7 + TypeScript application-dataflow foundation**, demonstrated by a
custom-JSX Todo application. This repository continues the implementation
originally developed in [rxjs-stack](https://github.com/hansschenker/rxjs-stack).

**Implementation status, 2026-09-20: M00 is accepted and closed.** PR #2 merged at
[`c9197b6`](https://github.com/hansschenker/rxjs-flow/commit/c9197b68591e390a0a3add4667e5dd23717d6b6e).
M01 is accepted and merged in PR #5 at `188f21f`; M05a in PR #6 at `eeb8d29`.
M02's [instance-owned state and coherent derived streams](docs/m02/acceptance.md)
are accepted and merged in PR #7 at `7374557`.
M03's [owned effects and validated HTTP outcomes](docs/m03/acceptance.md)
are accepted and merged in PR #8 at `c64fda1`.
M04's [owned, targeted DOM rendering](docs/m04/acceptance.md) is accepted and
merged in PR #9 at `2b316a4`. See the [minimal binding sample](docs/m04/minimal-sample.md).
M05b's [HTTP compatibility and request ownership](docs/m05b/acceptance.md) is
accepted and merged in PR #10 at `1cfbaec`.
M05c's [durable Todo authority](docs/m05c/acceptance.md) is accepted and merged in
PR #11 at `d5500da`. M05d's [bounded, owned live delivery](docs/m05d/acceptance.md)
is accepted and merged in PR #12 at `540faec`; parent M05 is complete.
M06's [typed live synchronization and recovery](docs/m06/acceptance.md) is
accepted and merged in PR #13 at `36d644f`.
M07's [reference-app completion](docs/m07/acceptance.md) is explicitly authorized
and implemented; acceptance review/merge is pending. [Run the reference Todo application](docs/m07/local-development.md).
The reference application adds All/Active/Completed filters, pure title validation
and draft revision tracking so a late reply preserves newer typing. It exposes
recoverable operation feedback and verifies explicit unmount/remount in both
development and built browser/Worker modes. **968 tests pass**, with two actual
browser contexts confirming forms, live updates, failure recovery and cleanup.
The Todo application receives committed snapshots live, shares one connection
per mounted app and reconnects under a bounded policy. Changes from another
caller appear without Refresh. The local Workers runtime stores the configured
collection in attached SQLite storage, so saved Todos and their ordering identity
survive a runtime restart. The retained Node sample uses separate memory.
M00's dated test results and separate failing characterization remain evidence,
not a claim that every planned behavior works.

**Planning revision: rxjs-flow migration r2 — Cloudflare/Hono.** The selected target
uses Hono for HTTP integration, Cloudflare Workers for execution, a minimal Durable
Object authority for shared Todo state, Vite for builds and Wrangler for Cloudflare
operations. M05a supplies project-local Wrangler, Vite/Workers builds and a typed
Hono/RxJS probe. M05b adds finite Todo HTTP compatibility and request ownership;
M05c adds bounded authority operations, atomic persistence and reconstruction.
M05d adds atomic snapshot registration, bounded SSE delivery and cancellation.
M06 connects versioned snapshots to application state, rejects obsolete values
and exposes connection/recovery status. M07 completes the reference application;
M08–M09 remain pending. No deployed Worker
or domain configuration is claimed.

## Project documents

- [Canonical roadmap — migration r2](docs/roadmap-gpt-6-astra-2026-09-15.md)
- [Dataflow architecture contract](docs/dataflow-architecture.md)
- [Cloudflare/Hono runtime decision](docs/runtime-cloudflare-hono.md)
- [M00 baseline and recovery evidence](docs/baseline-rxjs-flow-m00.md)
- [M01 browser lifetime acceptance](docs/m01/acceptance.md)
- [M02 state, transition examples and acceptance](docs/m02/acceptance.md)
- [M03 effect policies, HTTP outcomes and acceptance](docs/m03/acceptance.md)
- [M04 targeted DOM rendering and acceptance](docs/m04/acceptance.md)
- [M04 minimal binding sample](docs/m04/minimal-sample.md)
- [M05a acceptance and test evidence](docs/m05a/acceptance.md)
- [M05b acceptance and route compatibility](docs/m05b/acceptance.md)
- [M05c durable authority and restart/failure acceptance](docs/m05c/acceptance.md)
- [M05d live ownership, resource limits and acceptance](docs/m05d/acceptance.md)
- [M06 live synchronization, protocol and acceptance](docs/m06/acceptance.md)
- [M07 reference application and form acceptance](docs/m07/acceptance.md)
- [Run the complete reference application](docs/m07/local-development.md)
- [M06 two-page live synchronization checkpoint](docs/m06/local-development.md)
- [M05d legacy transport checkpoint](docs/m05d/local-development.md)
- [Persistent local Todo page and restart checks](docs/m05c/local-development.md)
- [Historical M05a foundation guide](docs/m05a/local-development.md)
- [Historical source audit](docs/repository-audit-2026-09-15.md)

## Existing foundation and planned work

| Area | Existing implementation | Work still planned |
|---|---|---|
| Client | Instance-owned state/effects, captured draft revisions, pure validation, local filters, recoverable operations and targeted custom-JSX rendering | M07 acceptance review; temporal traces (M08) |
| HTTP server | Owned finite Todo operations and bounded live responses through Hono/workerd and the retained Node adapter | Final runtime-support review (M09) |
| Shared state | Configured Durable Object collection, atomic persistence/reconstruction and race-free live registration; separate in-memory Node/test histories | Broader temporal/adversarial evidence (M08) |
| Live updates | Accepted M06 protocol, one app-owned connection, stale/duplicate protection, bounded reconnect and explicit manual recovery | Wider trace evidence (M08) |
| Reference app/delivery | Complete Todo UI verified in two native browser contexts through both development and built local Worker; form/filter/failure/restart and explicit remount evidence | M07 acceptance; traces (M08) and documented delivery review (M09) |

The intended flow is events → state → derived values → rendering, with external
operations returning typed results to state. Rendering must not initiate network
writes. The platform boundary changes; the RxJS model and custom renderer remain.
`todo.view.tsx` owns rendering while the app root connects its streams. Synchronous
bindings update the relevant DOM values; keyed rows retain their nodes and child
scopes across updates, preserve focus and selection, and release ownership on removal.

The recommended sequence is M01 → M05a → M02 → M03 → M04 → M05b → M05c → M05d →
M06 → M07 → M08 → M09. M00 stays closed; M06 is accepted and merged.
M07 was explicitly authorized from its verified merge. M08 remains a later milestone. No SSR, Hono JSX, browser router or custom CLI is required for
this completion target.

## Run the existing development application

Use Node **22.22.1** (also recorded in `.nvmrc`):

```bash
git clone https://github.com/hansschenker/rxjs-flow.git
cd rxjs-flow
npm ci
npm run typecheck
npm test
```

Run the server and client in separate terminals:

```bash
npm run dev:server
```

```bash
npm run dev:client
```

The API uses port 3000. Vite serves the browser client and proxies `/api/*` to the
Node API. The current store is in memory; restarting that server loses Todos.
These commands remain the baseline workflow until implementation changes them.

The [M00 build/start probes](docs/m00/build-start-strategy.md) remain historical
Node evidence. Their future Node-only delivery choice is superseded by the r2
runtime decision. The [M05a guide](docs/m05a/local-development.md) documents the
installed tools, generated Worker types, local development/build/preview, and
optional developer authentication. Local verification needs no account login.

To run the Todo page and Hono API together in the local Workers runtime:

```bash
npm run dev:worker
```

Open **http://localhost:5174** for the Todo page. Saved Todos persist in the local
Workers runtime's SQLite storage under `.wrangler/state`. Stop and restart the
command from the same checkout to see the same collection. The [M05c guide](docs/m05c/local-development.md)
explains the two-caller and restart checkpoints. `npm run smoke:worker -- --dev`
checks actual local Todo HTTP behavior; `node scripts/m05c-checkpoint.mjs` also
restarts the local runtime using an isolated temporary database.
Open **http://localhost:5174/m05d-live.html** for two live consumers with independent
Connect/Disconnect controls. The [M05d guide](docs/m05d/local-development.md)
explains the legacy checkpoint and response-lifetime evidence. The Todo page now
uses `/api/todos/live`; open it in two tabs for the [M06 synchronization and
reconnect checkpoint](docs/m06/local-development.md).
The built configuration leaves Todo access disabled (503); the guide documents
an explicit local Wrangler command. Local persistence does not deploy a service.

## Scope and contribution

Use a dedicated branch and pull request. Work on the authorized milestone only
and record acceptance evidence before advancing. Do not merge, publish, deploy,
create remote resources or change domain/account configuration without explicit
authorization. The owner's existing `netxpert.ch` Cloudflare work is deployment
context, not a claim that rxjs-flow is bound to or served from that domain.

Keep local runtime verification, deployable-artifact readiness and actual deployed
verification separate. Minimal persistence is not comprehensive production readiness.
The historical `rxjs-stack` and separate `rxjs-fullstack` repositories are not
implementation targets; no code/history replacement is part of this direction.

Inherited optional Claude workflows, Dependabot configuration and local Claude
permission settings remain under `docs/archive/` for separate review. They are not
activated by this revision. CI now checks separate Node/DOM and workerd tests, generated types, browser/Worker
builds, local preview and development Todo HTTP. No deployment workflow or secrets are added here.

The original work by **Hans Schenker and Claude (Anthropic)** retains its commit
authorship and [MIT license](LICENSE). The
[historical README](docs/archive/README-rxjs-stack-2026-09-15.md), archived r1 plan,
and original entries in [CHANGELOG](CHANGELOG.md) preserve that provenance.
Package version `1.0.0` is retained; milestone completion is tracked separately.
