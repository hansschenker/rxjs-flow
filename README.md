# RxJS-Flow

[![CI](https://github.com/hansschenker/rxjs-flow/actions/workflows/ci.yml/badge.svg)](https://github.com/hansschenker/rxjs-flow/actions/workflows/ci.yml)

An **RxJS 7 + TypeScript application-dataflow foundation**, demonstrated by a
custom-JSX Todo application. This repository continues the implementation
originally developed in [rxjs-stack](https://github.com/hansschenker/rxjs-stack).

**Implementation status, 2026-09-17: M00 is accepted and closed.** PR #2 merged at
[`c9197b6`](https://github.com/hansschenker/rxjs-flow/commit/c9197b68591e390a0a3add4667e5dd23717d6b6e).
M01–M09 remain pending. The executable baseline still uses **Node HTTP and an
in-memory store**; the complete owned/live-state loop is not yet implemented.
M00's dated test results and separate failing characterization remain evidence,
not a claim that every planned behavior works.

**Planning revision: rxjs-flow migration r2 — Cloudflare/Hono.** The selected target
uses Hono for HTTP integration, Cloudflare Workers for execution, a minimal Durable
Object authority for shared Todo state, Vite for builds and Wrangler for Cloudflare
operations. These integrations are planned work; this revision changes documents,
not runtime code, dependencies, deployment configuration or domain settings.

## Project documents

- [Canonical roadmap — migration r2](docs/roadmap-gpt-6-astra-2026-09-15.md)
- [Dataflow architecture contract](docs/dataflow-architecture.md)
- [Cloudflare/Hono runtime decision](docs/runtime-cloudflare-hono.md)
- [M00 baseline and recovery evidence](docs/baseline-rxjs-flow-m00.md)
- [Historical source audit](docs/repository-audit-2026-09-15.md)

## Existing foundation and planned work

| Area | Existing implementation | Work still planned |
|---|---|---|
| Client | Typed finite-route client, pure reducer, custom JSX and CRUD wiring | Owned startup/disposal, instance state, effect feedback and targeted rendering (M01–M04) |
| HTTP server | Node Observable HTTP source, routes, middleware, auth and Zod validation | Hono/Workers foundation and compatibility-tested request ownership (M05a–M05b) |
| Shared state | In-memory Node Todo store | Logical collection authority, minimal durable commit/recovery and ordering metadata (M05c) |
| Live updates | Node SSE route and client EventSource adapter | Owned bounded delivery, validated snapshots and reconnect semantics (M05d–M06) |
| Reference app/delivery | Existing Todo application and separate development processes | Complete browser loop, platform tests/traces and documented Cloudflare-ready build (M07–M09) |

The intended flow is events → state → derived values → rendering, with external
operations returning typed results to state. Rendering must not initiate network
writes. The platform boundary changes; the RxJS model and custom renderer remain.

The recommended sequence is M01 → M05a → M02 → M03 → M04 → M05b → M05c → M05d →
M06 → M07 → M08 → M09. M00 stays closed; starting the next milestone requires its
own authorization. No SSR, Hono JSX, browser router or custom CLI is required for
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
runtime decision. M05a will establish project-local Wrangler authentication,
generated Worker types, Vite/Cloudflare development/build/preview and compatible
runtime tests. Do not treat Wrangler commands as configured repository scripts yet.

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
activated by this revision. The inherited install/typecheck/test CI remains the
validation workflow; no deployment workflow or secrets are added here.

The original work by **Hans Schenker and Claude (Anthropic)** retains its commit
authorship and [MIT license](LICENSE). The
[historical README](docs/archive/README-rxjs-stack-2026-09-15.md), archived r1 plan,
and original entries in [CHANGELOG](CHANGELOG.md) preserve that provenance.
Package version `1.0.0` is retained; milestone completion is tracked separately.
