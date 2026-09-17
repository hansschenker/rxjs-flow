# RxJS-Flow working agreement

Read before changes:

- `docs/roadmap-gpt-6-astra-2026-09-15.md` — **rxjs-flow migration r2 — Cloudflare/Hono**
- `docs/dataflow-architecture.md`
- `docs/runtime-cloudflare-hono.md`
- `docs/repository-audit-2026-09-15.md` and `docs/baseline-rxjs-flow-m00.md` as historical evidence

The development repository is `hansschenker/rxjs-flow`. Preserve the application,
original history and attribution. Do not modify `rxjs-stack` or `rxjs-fullstack`.
Selecting Hono in this plan does not import the separate project's code, Bun
assumptions or completed milestones.

M00 is accepted and closed: recovery PR #1 merged at
`27f8f2cbcc7ba68ff6bc1062ebf25cc46f363769`; closeout PR #2 merged at
`c9197b68591e390a0a3add4667e5dd23717d6b6e`. M01 is accepted/merged in PR #5 at
`188f21ff307ff7d2146d9f90b24e5ee5c7dfd99d`. M05a is accepted/merged in PR #6 at
`eeb8d2989884372fa42f4e321295aa7f3e8faa75`; see `docs/m05a/acceptance.md`.
M02 is accepted/merged in PR #7 at
`7374557b6d264a9bfa572526a4f71233fc3aa24e`; see `docs/m02/acceptance.md`.
M03 is accepted/merged in PR #8 at
`c64fda113b599ff9b0b21ae3e20aeff0c473a358`; see `docs/m03/acceptance.md`.
M04 is implemented; acceptance review/merge pending. See `docs/m04/acceptance.md`
and `docs/m04/minimal-sample.md` for owned scalar bindings, a stable shell and keyed
rows with child scopes. Rendering commits synchronously, preserving focus and
selection; `todo.view.tsx` owns rendering and the app root connects its streams.
M05b–M09 remain pending. M05b is next only after M04 acceptance and explicit
authorization.
Do not repeat the import or reopen M00 because the platform target changed.
The separate `m00/characterize-baseline` branch contains intentionally failing
probes; do not merge it. Map each failure to a verified fix or tested replacement.

Use a dedicated branch and pull request, with the actual current base verified.
No merge, implementation advancement, release, package publication, remote resource
creation, migration or deployment without the corresponding explicit authorization.
Plan revision does not start a milestone. Do not change `netxpert.ch` DNS, routes,
domains, secrets or account settings as a side effect of project work.

Preserve RxJS 7, TypeScript, custom JSX, typed contracts, Zod validation and HTTP/SSE.
Prefer named pure functions and function-based factories. A thin platform-required
Durable Object entry class may delegate to the functional core; do not introduce
application class hierarchies or rewrite third-party libraries to remove classes.

The r2 target is Hono HTTP integration on Cloudflare Workers, Vite plus the
Cloudflare Vite plugin, project-local Wrangler, and a minimal Durable Object
collection authority. M05a establishes only a local Hono/RxJS probe, generated
Worker types, builds and runtime tests; Todo migration, durable authority and
application live SSE integration remain planned.
The current Node HTTP application remains the migration baseline until equivalent
behavior is verified.
Keep its applicable lifecycle tests or explicitly document tested retirement.
Do not scaffold over the repository, adopt Hono JSX, or add another reactive engine.

Events, state, derived values, rendering and effects have explicit owned dataflow.
Effect results return to state; rendering never initiates network writes.
Make time, cancellation, sharing, activation and disposal explicit. Keep Hono
context/Worker bindings outside core reducers. Worker-global state is not authority;
request, live-response and logical collection lifetimes are distinct.

Recommended order after the reviewed plan:
M01 → M05a → M02 → M03 → M04 → M05b → M05c → M05d → M06 → M07 → M08 → M09.
M05 closes only when all four substeps pass. Refer to the canonical roadmap for
full tasks, dependencies and acceptance; do not create a competing plan here.

Record exact commits, commands, versions, test counts and limitations. Historical
CI is not current acceptance. Node 22.22.1 remains the recorded executable baseline;
verify toolchain compatibility in M05a rather than silently upgrading it now.
Test Workers behavior in the supported local Workers runtime, not only Node mocks.
Distinguish local verification, deployment readiness and actual deployed evidence.
Each completed milestone supplies a readable document or runnable checkpoint.

After an accepted plan update, refresh the ChatGPT Project reference copy with the
same filename/revision. Do not claim that a repository commit automatically updates
that Project copy. Archived r1 documents and inherited examples are historical,
not competing active instructions.
