# RxJS-Flow roadmap

The active planning document is
[roadmap-gpt-6-astra-2026-09-15.md](roadmap-gpt-6-astra-2026-09-15.md),
revision **rxjs-flow migration r2 — Cloudflare/Hono**, dated 2026-09-17.

Read it with the [architecture contract](dataflow-architecture.md),
[Cloudflare/Hono runtime decision](runtime-cloudflare-hono.md),
[historical source audit](repository-audit-2026-09-15.md), and
[M00 baseline evidence](baseline-rxjs-flow-m00.md).

M00 is accepted/closed at `c9197b68591e390a0a3add4667e5dd23717d6b6e` (PR #2).
M01–M09 remain pending. The implementation still uses Node HTTP; Hono, Workers,
Wrangler integration and durable authority are selected targets, not completed work.

Recommended order: M01 → M05a → M02 → M03 → M04 → M05b → M05c → M05d → M06 → M07
→ M08 → M09. M05a establishes the platform/build path early. M05 is complete only
when all four substeps pass; starting implementation is not implied by this revision.

The [unmodified r1 roadmap](archive/roadmap-rxjs-flow-migration-r1-2026-09-15.md)
and other [archived records](archive/) preserve provenance. They are not competing
active plans. Existing evidence remains valid for its recorded baseline; only the
future Node-only target is superseded. The Project reference copy must be refreshed
separately after the accepted revision; a GitHub commit does not update it automatically.
