# RxJS-Flow roadmap

The active planning document is
[roadmap-gpt-6-astra-2026-09-15.md](roadmap-gpt-6-astra-2026-09-15.md),
revision **rxjs-flow migration r2 — Cloudflare/Hono**, dated 2026-09-17.

Read it with the [architecture contract](dataflow-architecture.md),
[Cloudflare/Hono runtime decision](runtime-cloudflare-hono.md),
[historical source audit](repository-audit-2026-09-15.md), and
[M00 baseline evidence](baseline-rxjs-flow-m00.md).

M00 is accepted/closed at `c9197b68591e390a0a3add4667e5dd23717d6b6e` (PR #2).
M01 is accepted/merged in PR #5 at `188f21f`; M05a in PR #6 at `eeb8d29`.
M02 is [accepted/merged in PR #7](m02/acceptance.md) at `7374557`.
M03 is [accepted/merged in PR #8](m03/acceptance.md) at `c64fda1`.
M04 is [accepted/merged in PR #9](m04/acceptance.md) at `2b316a477600c91b3105c9e390949c29e90046d3`.
Its stable shell, owned scalar bindings and keyed rows commit synchronously and
preserve focus and selection; see the [minimal binding sample](m04/minimal-sample.md).
M05b is [accepted/merged in PR #10](m05b/acceptance.md) at `1cfbaeca0cede3a08c90631e16cf6bdf2fa750c8`.
M05c is [accepted/merged in PR #11](m05c/acceptance.md) at
`d5500da407611e7856e9e67481a08e15e530aece`.
The [local Hono Todo page](m05c/local-development.md) uses attached SQLite storage
and preserves committed state across runtime restarts. The built Worker leaves
Todo access disabled; local execution of the built artifact requires an explicit
Wrangler command. M05d implements race-free authority registration and bounded,
owned SSE; [acceptance review/merge is pending](m05d/acceptance.md). The
[live checkpoint](m05d/local-development.md) exercises independent consumer
disconnect/reconnect. M06–M09 remain pending, including the versioned public live
protocol and Todo application integration in M06.

Recommended order: M01 → M05a → M02 → M03 → M04 → M05b → M05c → M05d → M06 → M07
→ M08 → M09. M05a establishes the platform/build path early. M05 is complete only
when all four substeps pass; starting implementation is not implied by this revision.

The [unmodified r1 roadmap](archive/roadmap-rxjs-flow-migration-r1-2026-09-15.md)
and other [archived records](archive/) preserve provenance. They are not competing
active plans. Existing evidence remains valid for its recorded baseline; only the
future Node-only target is superseded. The Project reference copy must be refreshed
separately after the accepted revision; a GitHub commit does not update it automatically.
