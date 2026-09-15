# RxJS-Flow

[![CI](https://github.com/hansschenker/rxjs-flow/actions/workflows/ci.yml/badge.svg)](https://github.com/hansschenker/rxjs-flow/actions/workflows/ci.yml)

A TypeScript Todo application built on **RxJS 7**, custom JSX, and Node HTTP.
This repository continues the implementation originally developed in
[rxjs-stack](https://github.com/hansschenker/rxjs-stack).

**Current status: the import is merged; M00 baseline evidence is under review.**
The original application and Git history are present on `main`. Baseline tests
pass; separate characterization records the remaining runtime failures and
their milestone owners. The complete live-state loop remains planned work.

## Project documents

- [Canonical roadmap — rxjs-flow migration r1](docs/roadmap-gpt-6-astra-2026-09-15.md)
- [Dataflow architecture contract](docs/dataflow-architecture.md)
- [M00 baseline and recovery evidence](docs/baseline-rxjs-flow-m00.md)
- [Historical source audit](docs/repository-audit-2026-09-15.md)

## Existing foundation and planned work

| Area | Existing implementation | Work still planned |
|---|---|---|
| Server | Observable HTTP source, routes, middleware, auth wrapper, Zod validation | Request isolation and explicit response/application ownership (M05) |
| Client | Typed finite-route client, pure Todo reducer, custom JSX and CRUD wiring | Owned startup/disposal, instance state, effect-result feedback and targeted rendering (M01–M04) |
| Live updates | Server SSE route and client EventSource adapter | Response-disconnect correctness and an integrated, validated live-state loop (M05–M06) |
| Reference app | In-memory Todo application | Complete forms, recovery behavior and browser integration evidence (M07–M09) |

The intended flow is events → state → derived values → rendering, with external
effects returning typed results to state. The current implementation is the
starting point for that contract. Rendering must not initiate network writes in
the completed design.

## Run the development application

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

The API uses port 3000. Vite serves the browser client and proxies `/api/*` to
the API. The server store is in memory; restarting the server loses Todos.
Production build/start delivery remains roadmap work. The
[M00 build/start decision and probes](docs/m00/build-start-strategy.md) record
the selected direction and current limits.

## Scope and contribution

Use a dedicated branch and pull request. Work on the current milestone only;
record its acceptance evidence before advancing. Do not merge, publish or deploy
without explicit authorization. The historical `rxjs-stack` and separate
`rxjs-fullstack` repositories are not development targets.

Inherited optional Claude workflows, Dependabot configuration and local Claude
permission settings are retained under `docs/archive/` for separate review.
They are not activated by this recovery. The inherited install/typecheck/test
CI is the active validation workflow. Repository settings and secrets were not
copied or changed.

The original work by **Hans Schenker and Claude (Anthropic)** retains its commit
authorship and [MIT license](LICENSE). The
[historical README](docs/archive/README-rxjs-stack-2026-09-15.md) and original
release entries in [CHANGELOG](CHANGELOG.md) preserve that provenance.
Package version `1.0.0` is retained; milestone completion is tracked separately.
