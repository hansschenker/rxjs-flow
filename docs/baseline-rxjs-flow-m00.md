# M00 — verified import, baseline, and characterization

Updated: 2026-09-15. Design authority: **rxjs-flow migration r1**.
**M00 execution and acceptance evidence are recorded; the closeout change is
under review. No M01 implementation is included or authorized by this record.**

## Exact history and working snapshots

| Role | Commit |
|---|---|
| Destination before recovery | `978d1be715cb2d23b9c9a0c875d15cd9707721e7` |
| Audited original application | `cbc91eefbccdeaf17221d06c75bdd237fe5e5499` |
| Original documentation provenance | `d701cb72f14293e96acac2cb163e6434e5fb0f54` |
| Reviewed recovery PR #1 head | `d11aa173ff4bd7b44df1722796d57309149c2aee` |
| Approved recovery merge; M00 destination baseline | **`27f8f2cbcc7ba68ff6bc1062ebf25cc46f363769`** |
| Isolated characterization commit | `5640870a1f5b0cc92946b42e8dba261fcd0eacb6` |
| Post-baseline housekeeping | `37735b6ef4b34d4b251514a9ab9161f6ff6ea601` |

The user explicitly approved merging [PR #1](https://github.com/hansschenker/rxjs-flow/pull/1).
It was merged with the ordinary merge method and expected head `d11aa173...`.
The resulting `main` commit has ordered parents `978d1be...` and `d11aa173...`.
`git merge-base --is-ancestor` passed separately for the destination root,
audited application commit, and original documentation commit against that
merged baseline. **The migration gate is satisfied on destination main.**

All 13 imported branch tips and tag `v1.0.0` were previously compared with the
recorded source snapshot. The full SHA mapping, 94-commit/all-refs and 82-commit
original-main counts, `git fsck --full` result, and scoped LFS/submodule checks
are preserved in the [recovery record](archive/baseline-rxjs-flow-m00-recovery.md).
Source PR `rxjs-stack#21` remains historical documentation provenance. No
source repository, source PR, source setting, or dependency branch was changed.

The working repository's fetch and push URL is
`https://github.com/hansschenker/rxjs-flow.git`. Work continues on
`m00/baseline-evidence`. Characterization is isolated on
`m00/characterize-baseline`; its deliberately failing tests must not be merged
into `main`. No force push or reference deletion was used.

## Changes after the baseline

The merged baseline already contains the canonical documents and active
repository metadata, preserves the original license/authorship, and removes
tracked `node_modules` and the embedded bare clone from the current tree.

Post-baseline housekeeping removes the unused `@hono/cli` development dependency
after a usage and dependency-path review. Its 31 exclusive lock entries are
removed; every retained lock entry is unchanged. No dependency version is
upgraded. The page title is corrected from `rxjs-full Todos` to `rxjs-flow Todos`.
Package version remains **1.0.0** and RxJS remains **7.8.2**.

The production source tree remains **`6fdf2f7fc951b8fb7be29be2bb9614bf7ca36ad6`**,
identical to the audited source. Existing tests, compiler/build/test
configuration, and license are unchanged. M00 adds evidence/documentation and
an archived smoke harness; all failing characterization tests are on the
separate branch. Generated dependencies, `dist/`, and `build/` are untracked.

## Clean install and test evidence

Local environment: Linux, **Node v22.22.1 / npm 11.9.0**; Python **3.12** is used
only by the evidence capture and optional smoke harness. The toolchain binary
was verified directly. Shell validation used this PATH prefix:

```bash
env PATH=/workspace/scratch/69635aad2014/m00-node22/node_modules/node-linux-x64/bin:$PATH npm run typecheck
```

The same prefix was used for the other npm/Node commands. In a user checkout,
select `.nvmrc` with a Node version manager and then run the ordinary commands.

| Snapshot | Command | Exit | Result |
|---|---|---:|---|
| Merged baseline `27f8f2c` before further changes | `npm ci --no-fund` | 0 | 120 installed packages; clean dependency installation |
| Same baseline | `npm run typecheck` | 0 | Passed |
| Same baseline | `npm test` | 0 | **180 tests / 19 files passed** |
| Housekeeping tree committed at `37735b6` | `npm ci --no-fund` | 0 | 114 installed packages |
| Same housekeeping tree | `npm run typecheck` | 0 | Passed |
| Same housekeeping tree | `npm test` | 0 | **180 tests / 19 files passed** |
| Characterization tree committed at `5640870` | `npm run typecheck` | 0 | Probe code is type-correct |
| Same characterization tree | `npm test -- src/m00` | 1 | **15 failed / 5 passed**, intentionally demonstrating the gaps below |

The captured [commands and timestamps](m00/commands.json),
[baseline test output](m00/baseline-tests.txt),
[post-housekeeping test output](m00/after-housekeeping-tests.txt), and
[characterization output](m00/characterization-tests.txt) retain the results.
The initial post-merge `npm ci` ran directly in the shell and is recorded in the
table above; the JSON ledger contains the subsequently wrapped validation calls.
Document-only closeout edits follow these runtime checks; destination PR CI
checks the final submitted head.

Warnings remain visible: npm proxy configuration, the environment's experimental
Node proxy adapter, and Vite/Vitest's oxc/esbuild JSX-option warning. No warning
suppression or runtime change was used to obtain a passing suite.

## Reproducible concerns and milestone owners

The probe branch adds three test files to the merged baseline and changes no
production code, configuration, or dependencies. Reproduce in an isolated
checkout with Node 22.22.1:

```bash
git clone https://github.com/hansschenker/rxjs-flow.git rxjs-flow-m00-probes
cd rxjs-flow-m00-probes
git switch --detach 5640870a1f5b0cc92946b42e8dba261fcd0eacb6
npm ci
npm run typecheck
npm test -- src/m00
```

The last command is expected to exit **1** at this commit. These commands are
reproduction instructions; the execution ledger records the actual worktree
commands used during M00. No intentionally failing baseline is merged.

| Concern | Observed behavior / reproduction | Fix owner |
|---|---|---|
| Non-2xx client responses | GET 400, 401, 404, 409, 422, 500, 503 emit the JSON error body through the success channel; seven desired rejection assertions fail. | M03 |
| Failed DELETE | DELETE 404 and 500 emit `undefined` as successful completion; two rejection assertions fail. | M03 |
| Synchronous startup feedback | A service emitting Todos synchronously is subscribed before state ownership exists; the resulting Todo is absent from the rendered list. | M02, with M01 ownership |
| Root disposal | The entry module exposes no construction/disposal function. A detached former form still invokes create when dispatched a submit event. The exported-boundary assertion fails; the detached-listener observation passes. | M01 |
| Malformed route parameter | A real request to `/item/%ZZ` closes the root subscription. The offending request reaches its bounded 500 ms deadline and the following `/ok` connection is refused. | M05 |
| Synchronous handler construction throw | A real `/throw` request has the same root shutdown and failed subsequent request. | M05 |
| Real SSE disconnect | The GET request closes while the response remains live and delivers a second event. After real response closure, the stream still has one active subscription and zero finalizations. | M05 |
| Application stop with SSE | After `app.stop()`, the root subscription is closed but the live stream remains active and the response has not closed. | M05 |

The API probes use real `Response` objects with a mocked transport source. They
do not claim to test transport abort/body-consumption cancellation. The UI probes
use jsdom and synchronous service sources. The exported-boundary assertion
detects a missing seam; it does not prove a future implementation disposes
resources merely because it exports a function. Detaching DOM is an observation,
not a requirement for automatic cleanup without an explicit disposal call.

Server probes use actual Node HTTP sockets and the repository's `createApp`,
router, bootstrap and HTTP adapter. A test-only spy observes the actual server
handle to discover an ephemeral port and close sockets during cleanup. There
are no mocked request-close events. SSE assertions are ordered by real data and
close events, with one event-loop turn to observe teardown. The 500 ms request
deadline bounds a hang; it is not a performance requirement. Fixture cleanup
explicitly completes test sources and closes test sockets after observation.

Five controls/observations pass: valid DELETE 204, malformed JSON rejection,
transport-error propagation, detached-form listener behavior, and a route error
emitted *inside* its returned stream followed by a successful real request.
The existing 180-test suite also retains malformed/oversized JSON and missing
Todo response tests. Those behaviors are already implemented; M00 does not
recreate them as unfixed bugs.

## Dependency and build review

The [dependency review](m00/dependency-review.md) maps the destination's absent
dependency PRs to the 11 original source PRs and imported lockfiles. Several
imported proposals are behind current advisory fixes; none was automatically
merged or recreated. The Hono CLI removal is independently committed.

Full npm audit findings decreased **10 → 8** (now 1 low, 3 moderate, 4 high).
All eight remaining affected package entries are in development tooling.
Production-only npm audit reports **0**. A dedicated tested tooling-security
update remains unresolved; baseline acceptance does not certify safe deployment.

The [build/start strategy](m00/build-start-strategy.md) selects Vite for the
client and a minimal Node 22 ESM server build, with explicit runtime packages.
Client build, server build, source startup, and emitted startup probes passed.
The future combined deployment uses same-origin static hosting plus `/api`
reverse proxying. Supported scripts, browser proof, graceful shutdown, and a
combined static/API smoke test remain M05/M09 work. No deployment occurred.

## Git and destination CI commands/results

Core Git commands actually used after approval:

```bash
GIT_TERMINAL_PROMPT=0 timeout 45s git fetch origin main
git switch -c m00/baseline-evidence origin/main
git rev-parse HEAD HEAD:src
git show --no-patch --format='%H%n%P%n%s' HEAD
git merge-base --is-ancestor cbc91eefbccdeaf17221d06c75bdd237fe5e5499 HEAD
git merge-base --is-ancestor d701cb72f14293e96acac2cb163e6434e5fb0f54 HEAD
git merge-base --is-ancestor 978d1be715cb2d23b9c9a0c875d15cd9707721e7 HEAD
git ls-files node_modules 'rxjs-flow-import.*'
git worktree add -b m00/characterize-baseline /workspace/scratch/69635aad2014/rxjs-flow-characterization HEAD
git diff --exit-code HEAD -- src/client src/server src/shared package.json package-lock.json
git diff --cached --check
```

The source/dependency checks used `git show <imported-ref>:package-lock.json`,
structural JSON comparison, `rg`, `npm explain @hono/cli`, `npm explain undici`,
and `npm explain nanoid`. GitHub reads inspected destination/source PRs and
destination CI. GitHub tree/commit operations wrote only destination branches;
their tree IDs were checked against local `git write-tree` before publication.
A new-branch attempt with the update-ref endpoint returned 422; the create-branch
endpoint then succeeded. This did not change an existing reference.

After publishing each dedicated branch, fetching it and an index-tree equality
check permit `git reset --soft origin/<branch>` to synchronize the local branch
pointer. This preserves the already verified index/worktree; no hard reset was
used. This report replaces the earlier active recovery record, which remains
archived without changing the evidence it originally recorded.

Destination CI evidence:

- [Recovery PR run 34946462569](https://github.com/hansschenker/rxjs-flow/actions/runs/34946462569): passed on the PR preview merge for head `d11aa173...`, Node 22.22.1 / npm 10.9.4, 180 tests / 19 files.
- [Merged-main run 34947014904](https://github.com/hansschenker/rxjs-flow/actions/runs/34947014904): **success** at baseline `27f8f2cb...`.
- The closeout PR for `m00/baseline-evidence` records its exact final head and final CI result in its description; that result is checked independently from the two earlier runs.

Only the inherited install/typecheck/test CI is active. Optional Claude and
Dependabot configurations remain archived. The main branch API reported no
branch protection; this work did not change repository settings, required checks,
secrets, or optional automation. CodeRabbit skipped the large recovery review
because of file-count/capacity limits; that was not a review approval.

## Acceptance assessment

| M00 acceptance criterion | Evidence/status |
|---|---|
| Destination identity and imported history verified | Satisfied on merged `main`; both historical lineages retained. |
| Audited commit and documentation provenance mapped | Exact commits and all intended imported refs recorded. |
| Exact destination baseline and differences recorded | `27f8f2c` baseline, `37735b6` housekeeping, source-tree identity, and closeout PR head recorded. |
| Clean-checkout commands have recorded results | Baseline and post-housekeeping clean installs, typechecks and 180-test results recorded. |
| Remaining failures have reproducible cases and owners | Separate immutable probe commit, 15 failing assertions / 5 passing controls, owners M01/M02/M03/M05. |
| Generated dependencies are not tracked | No `node_modules`, embedded import clone, `dist`, or `build` entries at the working head. |
| Active document links consistently target rxjs-flow | Canonical roadmap/index, README, agent guidance, package metadata and page title reconciled; historical source links retain attribution. |
| Current branch and destination CI explicit | Baseline main CI success recorded; closeout branch and its PR carry final-head review/CI evidence. |

There is **no remaining import or execution-environment blocker**. Runtime
failures and development dependency findings above are deliberately recorded
open work, with ownership and reproducible evidence. The closeout PR still
requires review/merge; user approval to merge recovery PR #1 is not treated as
approval to merge another PR. Stay within M00 until closeout is accepted, and
do not begin M01 automatically. No release, package publication, or deployment
is authorized or performed.
