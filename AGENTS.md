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
M04 is accepted and merged in PR #9 at `2b316a477600c91b3105c9e390949c29e90046d3`. See `docs/m04/acceptance.md`
and `docs/m04/minimal-sample.md` for owned scalar bindings, a stable shell and keyed
rows with child scopes. Rendering commits synchronously, preserving focus and
selection; `todo.view.tsx` owns rendering and the app root connects its streams.
M05b is accepted and merged in PR #10 at `1cfbaeca0cede3a08c90631e16cf6bdf2fa750c8`;
see `docs/m05b/acceptance.md`. M05c is accepted and merged in PR #11 at
`d5500da407611e7856e9e67481a08e15e530aece`. See `docs/m05c/acceptance.md` for
the durable collection and restart evidence. M05d is accepted and merged in
PR #12 at `540faec7086bb58223c5f475db91710ac0e7389b`; all four parent M05
substeps are accepted. See `docs/m05d/acceptance.md` for bounded owned SSE and
retained Node streaming. The owner authorized M06 from that verified merge.
M06 implements the versioned live-state loop in the Todo application;
acceptance review/merge is pending. See `docs/m06/acceptance.md` and
`docs/m06/local-development.md`. M07–M09 remain pending; begin M07 only after
M06 acceptance and its own authorization.
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
Worker types, builds and runtime tests. M05b adds finite Hono Todo HTTP and
request ownership with separate retained Node evidence. M05c adds a bounded
collection authority with attached SQLite storage and atomic state/metadata
commit. Development access is limited to the configured local collection;
deployable configuration stays disabled. M05d adds race-free committed-snapshot
registration, bounded live delivery and response-owned cancellation. M06 adds the
versioned `/todos/live` protocol, one app-owned connection, bounded RxJS-owned
reconnect and authoritative snapshot integration. The legacy `/todos/stream`
bare-array wire remains supported. HTTP mutation replies settle pending operation
status; accepted live snapshots alone replace collection content.
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
