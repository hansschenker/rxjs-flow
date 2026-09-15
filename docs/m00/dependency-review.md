# M00 dependency review — 2026-09-15

Baseline: `27f8f2cbcc7ba68ff6bc1062ebf25cc46f363769` in `hansschenker/rxjs-flow`.
Housekeeping: `37735b6ef4b34d4b251514a9ab9161f6ff6ea601`.
This is a recorded dependency review, not a security clearance or a dependency
upgrade. Application source and all retained locked package entries are unchanged.

## Installed graph and audit

The runtime graph contains RxJS **7.8.2**, tslib **2.8.1**, and Zod **4.4.3**.
Node is **22.22.1**. The lockfile has `@types/node` **25.7.0**, which does not
establish Node 25 runtime support; aligning types with Node 22 is follow-up work.

`npm audit --json` returned exit 1 at both snapshots:

| Snapshot | Low | Moderate | High | Total affected package entries |
|---|---:|---:|---:|---:|
| Merged baseline | 1 | 4 | 5 | 10 |
| After removing unused Hono CLI | 1 | 3 | 4 | 8 |

These are npm's counts of affected package entries, not counts of unique
advisories or proof that every advisory is exploitable through this application.
`npm audit --omit=dev --json` returned exit 0 with **zero reported findings**.
This does not cover the Node binary, unreported vulnerabilities, or application
logic. The reviewed findings remain relevant to development/test tooling.

Raw evidence: [baseline audit](baseline-audit.json),
[post-housekeeping audit](after-housekeeping-audit.json),
[production-only audit](production-audit.json).

## Hono CLI decision

The inherited `@hono/cli@0.1.10` is a root development dependency. Inspection of
scripts, source, build/test configuration, and active documentation found no
usage. The app uses Node HTTP; it does not use a Hono server. `npm explain`
confirmed the CLI's dependency path. Remove it with:

```bash
npm uninstall --save-dev @hono/cli --ignore-scripts --no-audit --no-fund
```

The removal deletes 31 exclusive lockfile entries (including optional platform
binaries); six installed Linux packages were removed. A structural comparison
confirmed that **every retained package entry is byte-for-byte equivalent as
JSON data**, with no version/integrity/resolution changes. The root development
dependency map only loses `@hono/cli`. The original entries remain in Git history.

Clean install, typecheck, 180 tests, client compilation, source server startup,
and emitted server startup pass after this removal. No `npm audit fix` was run.

## Source PRs and imported branches

The destination had **no open dependency PRs** when read after recovery PR #1
merged. The source had the 11 dependency PRs below plus documentation PR #21.
Their IDs and review context belong to `rxjs-stack`, not `rxjs-flow`. All source
reads were read-only. Imported branch tips are mapped in the archived recovery
record; none is an ancestor added by a dependency merge in this work.

The following decisions compare actual imported lockfiles with the audited
lockfile and the current npm advisory results. None of these proposed version
updates is already installed in the M00 baseline.

| Source PR | Imported proposal | Review decision |
|---|---|---|
| [#20](https://github.com/hansschenker/rxjs-stack/pull/20) | Hono 4.12.18 → 4.13.1 | Unused dependency removed with the CLI. The proposed Hono version is also behind the audit's current fixed range. Do not import the branch. |
| [#19](https://github.com/hansschenker/rxjs-stack/pull/19) | undici 7.25.0 → 7.29.0 | Used by jsdom, not the app's Node HTTP server. Candidate for a separate tested tooling update; matches the current audit's 7.x fixed boundary. |
| [#18](https://github.com/hansschenker/rxjs-stack/pull/18) | PostCSS 8.5.14 → 8.5.25; nanoid 3.3.12 → 3.3.16 | PostCSS proposal addresses the recorded PostCSS range, but bundled nanoid 3.3.16 remains affected; review/update the graph together. |
| [#12](https://github.com/hansschenker/rxjs-stack/pull/12) | Vite 8.0.12 → 8.0.16 | Candidate for the Vite advisories. Its lockfile still has PostCSS 8.5.15, so this branch alone does not clear the tooling audit. |
| [#9](https://github.com/hansschenker/rxjs-stack/pull/9) | Vite 8.0.12 → 8.0.14 | Superseded by #12 and still affected; do not use as the security fix. |
| [#7](https://github.com/hansschenker/rxjs-stack/pull/7), [#10](https://github.com/hansschenker/rxjs-stack/pull/10) | Vitest/coverage 4.1.6 → 4.1.7 | Both lockfiles update the coupled Vitest packages together. Version 4.1.7 remains within the current affected range below 4.1.11. |
| [#6](https://github.com/hansschenker/rxjs-stack/pull/6) | tsx 4.21.0 → 4.22.3; esbuild 0.27.7 → 0.28.0 | The proposed esbuild version remains affected below 0.28.1. A fresh combined review is needed. |
| [#8](https://github.com/hansschenker/rxjs-stack/pull/8) | Node types 25.7.0 → 25.9.1 | Does not align types with the chosen Node 22 runtime. Review alignment separately. |
| [#15](https://github.com/hansschenker/rxjs-stack/pull/15), [#16](https://github.com/hansschenker/rxjs-stack/pull/16) | checkout/setup-node v6 → v7 | Separate major action updates; retain v6 for this measured baseline. Destination CI on v6 passed. |

## Remaining security follow-up

Use a dedicated dependency PR with a new lockfile audit, Node 22 clean install,
typecheck, the existing suite, and build/start smoke checks. Keep the RxJS 7
runtime baseline. Re-read advisories before selecting exact versions; these are
the fixed boundaries reported at this inspection, not tested upgrade claims:

| Remaining packages | Installed | Candidate boundary from this audit | Dependency path |
|---|---|---|---|
| Vite | 8.0.12 | 8.0.16 | Root tooling |
| PostCSS | 8.5.14 | Imported 8.5.25 is beyond the affected range | Vite |
| nanoid | 3.3.12 | 3.3.18 | PostCSS |
| undici | 7.25.0 | 7.29.0 | jsdom |
| Vitest, coverage-v8, mocker | 4.1.6 | 4.1.11, with mutually compatible package versions | Test tooling |
| esbuild | 0.27.7 | 0.28.1 | tsx |

The [Vite maintainer advisory](https://github.com/vitejs/vite/security/advisories/GHSA-fx2h-pf6j-xcff)
describes a Windows development-server file-access issue and identifies 8.0.16
as patched. This project currently has no `--host` flag in its dev script; do
not interpret that as eliminating all tooling findings.
The [Vitest advisory](https://github.com/advisories/GHSA-82fw-gwwq-j7x9) and
[nanoid advisory](https://github.com/advisories/GHSA-2v37-7h3g-55p8) explain why
the older imported updates are insufficient. All other advisory identifiers,
affected ranges and npm severity classifications are preserved in the JSON.

Dependency/security review is complete for M00's baseline acceptance. The eight
remaining development findings are unresolved work for the next dedicated
security dependency change; they are not silently accepted as safe and do not
authorize deployment or package publication.
