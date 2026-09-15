# RxJS-Flow M00 baseline record — blocked at the import gate

Date: 2026-09-15. Evidence collected in this session; timestamp recorded at 06:21:09 UTC.

**Milestone status: BLOCKED / NOT COMPLETE.**

Authority: `roadmap-gpt-6-astra-2026-09-15.md`, revision **rxjs-flow migration r1**, read in full with `dataflow-architecture.md` and `repository-audit-2026-09-15.md` from the project's uploaded files.

The destination [hansschenker/rxjs-flow](https://github.com/hansschenker/rxjs-flow) is accessible but empty. GitHub returned no branches, and its commits endpoint returned HTTP 409 with `Git Repository is empty.` A local `git ls-remote` completed successfully with no advertised references. There is no imported application, destination starting commit, or main ancestry to validate.

Section 0, migration gate item 1, explicitly requires reporting M00 blocked if the destination is empty or the intended history is missing. M00's baseline execution and housekeeping tasks follow that gate. Accordingly, no import, scaffold, runtime change, repository commit, or pull request was created. M01 was not started.

## Starting identity and provenance

| Item | Observed result |
|---|---|
| Development destination | `hansschenker/rxjs-flow`, repository ID `1201001703`; accessible, public, not archived or disabled |
| Configured default branch name | `main`; this metadata does not establish that the branch exists |
| Destination branches | Empty list |
| Destination starting commit / current main commit | **None — repository empty** |
| Import snapshot / imported reference mapping | **None established** |
| Local working branch / push target | No application checkout or branch created; no push attempted |
| Source main observed during this session | `cbc91eefbccdeaf17221d06c75bdd237fe5e5499` |
| Source audited commit | Same commit; its existence in `rxjs-stack` was verified independently |
| Source documentation commit | `d701cb72f14293e96acac2cb163e6434e5fb0f54`; verified in `rxjs-stack`, with the audited commit as its sole parent |
| Historical documentation review | [rxjs-stack PR #21](https://github.com/hansschenker/rxjs-stack/pull/21), open and unmerged; head is the documentation commit above |
| Destination CI runs | `total_count: 0`, empty run list |
| Destination open PRs | Empty list; no open dependency-update PRs present |
| M00 result commit / PR | None; no existing destination commit can serve as the PR base |

The [audited source commit](https://github.com/hansschenker/rxjs-stack/commit/cbc91eefbccdeaf17221d06c75bdd237fe5e5499) and [documentation commit](https://github.com/hansschenker/rxjs-stack/commit/d701cb72f14293e96acac2cb163e6434e5fb0f54) remain historical provenance. Their existence in the source is not evidence of an import into the destination. A complete source reference inventory, source ancestry traversal, LFS/submodule inspection, and source-to-destination tree comparison were not performed after the gate failed.

## Acceptance criteria

| M00 acceptance criterion | Status | Evidence or remaining work |
|---|---|---|
| Destination identity and imported history verified | **Blocked** | Identity verified; no destination history exists. |
| Audited commit and documentation provenance mapped | **Partial** | Both source commits and their direct parent relationship verified; destination mapping absent. |
| Exact destination baseline and differences recorded | **Blocked** | Starting commit explicitly recorded as none; no application tree available for comparison. |
| Clean-checkout commands have recorded results | **Blocked** | No install, typecheck, or test execution possible against a destination commit. See execution record below. |
| Remaining failures have reproducible cases and milestone owners | **Blocked** | Historical cases and owners listed below; no destination cases executed or added. |
| Generated dependencies are not tracked at working head | **Unverified** | There is no working head. An empty repository does not satisfy this baseline requirement. |
| Active document links consistently target rxjs-flow | **Partial** | Uploaded roadmap and architecture identify rxjs-flow; canonical repository documents, README links, and roadmap index cannot be verified or updated yet. |
| Current branch and destination CI status explicit | **Recorded** | No branch exists; zero destination CI runs. This is not a CI pass. |

**M00 remains incomplete.** No historical test count or source CI success has been reused as current destination evidence.

## Execution record

Application commands and local environment:

| Command | Actual result |
|---|---|
| `git --version` | Exit 0; `git version 2.51.1` |
| `command -v gh` | Exit 1; GitHub CLI was not found on PATH. The following `&&`-chained Node/npm version checks in that first command did not execute. |
| `node --version` | Executed separately afterward; `v24.19.0` |
| `npm --version` | Executed separately afterward; `11.9.0`; warning about unknown environment config `http-proxy` |
| `git ls-remote https://github.com/hansschenker/rxjs-flow.git` | Exit 0; no output, so no references advertised |
| `npm ci` | **Not executed** — import gate failed |
| `npm run typecheck` | **Not executed** — import gate failed |
| `npm test` | **Not executed** — import gate failed; no test count available |
| Client build / server build and start smoke checks | **Not executed or configured** — no imported scripts/configuration to inspect |

The observed default Node version is 24, not the roadmap's required Node 22. No Node 22 toolchain was selected or tested. Node 22 availability remains unverified; this session does not establish a separate inability to provision it. Before resuming baseline execution, choose and record an exact Node 22 version and npm version.

Other inspection commands actually executed from `/workspace/scratch/69635aad2014`:

```bash
pwd && rg --files -g 'AGENTS.md' -g '*roadmap*' -g '*architecture*' -g '*audit*' -g '!node_modules' -g '!vendor' .
git --version && command -v gh && node --version && npm --version
node --version
npm --version
git ls-remote https://github.com/hansschenker/rxjs-flow.git
cat project-inputs/rxjs-flow/roadmap-gpt-6-astra-2026-09-15.md
cat project-inputs/rxjs-flow/dataflow-architecture.md project-inputs/rxjs-flow/repository-audit-2026-09-15.md
ps -eo pid,etime,args | rg 'git ls-remote https://github.com/hansschenker/rxjs-flow.git|git-remote-https origin https://github.com/hansschenker/rxjs-flow.git'
date -u +%Y-%m-%dT%H:%M:%SZ
sha256sum project-inputs/rxjs-flow/roadmap-gpt-6-astra-2026-09-15.md project-inputs/rxjs-flow/dataflow-architecture.md project-inputs/rxjs-flow/repository-audit-2026-09-15.md
```

The initial local file search found no matching files and exited 1. The uploaded documents were subsequently retrieved and read successfully. The process listing was only a diagnostic while the Git reference query was pending; the reference query's eventual exit status is recorded above.

## Remote read evidence

These were authenticated, read-only GitHub requests, not shell commands. Paths below are relative to `https://api.github.com/repos/`.

| Requested path | Actual outcome |
|---|---|
| `hansschenker/rxjs-flow` | Repository metadata returned; default branch name `main`, size 0 |
| `hansschenker/rxjs-flow/branches?per_page=100` | `[]` |
| `hansschenker/rxjs-flow/commits?per_page=5` | HTTP 409, `Git Repository is empty.` |
| `hansschenker/rxjs-flow/actions/runs?per_page=5` | Zero workflow runs |
| `hansschenker/rxjs-flow/pulls?state=open&per_page=100` | `[]` |
| `hansschenker/rxjs-stack/commits/cbc91eefbccdeaf17221d06c75bdd237fe5e5499` | Audited commit returned |
| `hansschenker/rxjs-stack/git/commits/d701cb72f14293e96acac2cb163e6434e5fb0f54` | Documentation commit returned; sole parent is audited commit |
| `hansschenker/rxjs-stack/branches/main` | Current source main matches audited commit |
| `hansschenker/rxjs-stack/pulls/21` | Open, unmerged; head documentation commit, base audited commit |
| `hansschenker/rxjs-stack/branches/docs%2Frxjs-dataflow-plan-2026-09-15` | Request interface rejected encoded repository path; direct branch lookup not verified |
| `hansschenker/rxjs-flow/tags?per_page=100` | Request interface rejected unsupported endpoint; no separate REST tag listing obtained |
| `hansschenker/rxjs-flow/actions/workflows?per_page=100` | Request interface rejected unsupported endpoint; workflow inventory not independently retrieved |

No repository settings were changed. Settings beyond the returned general repository metadata, including detailed Actions permissions and repository rules, remain unverified. Endpoint rejections above were read limitations, not approval requests or evidence of failing application behavior. The successful Git reference listing independently advertised no branches or tags.

## Characterization work awaiting the import

These are roadmap requirements derived from the historical audit, **not newly reproduced destination failures**.

| Case | Fix owner after M00 characterization |
|---|---|
| Non-2xx finite client responses | M03 |
| Failed DELETE must not report success | M03 |
| Synchronous startup result must reach state | M02, with M01 startup ownership |
| Root disposal and no updates after disposal | M01 |
| Malformed route parameters / percent encoding | M05 |
| Synchronous request-handler throws must not stop later requests | M05 |
| Real SSE disconnect must release the live response subscription | M05 |

After import, first inspect existing tests and current code. Add or reuse characterization cases on a temporary destination branch; record already-fixed behavior instead of assuming the historical concerns persist. Keep later runtime fixes out of M00. Defer the client build/server smoke strategy decision until the imported package scripts and configuration can be inspected.

## Required next action

Import the intended source Git history into `hansschenker/rxjs-flow`, preserving commit identity and parentage. The observed source main and separate documentation head above provide provenance anchors; they do not define or claim a completed all-branches/tags copy. Record the chosen source reference snapshot when the import is performed. Do not replace history with a file-only snapshot, overwrite newer destination work, merge the historical source PR, or modify either source repository.

Then resume **M00**, recheck the live destination, verify ancestry and relevant references, inspect any LFS/submodule requirements, and create a dedicated destination branch. Run the pre-change baseline under Node 22, complete M00 housekeeping/documentation/characterization, rerun relevant checks, and present a PR with exact commits and results. No progression to M01 is implied.

This standalone report is intended for `docs/baseline-rxjs-flow-m00.md` after import. It has not been committed to the empty repository, and it does not alter the uploaded roadmap's milestone status.

## Uploaded input fingerprints

| File | SHA-256 |
|---|---|
| `roadmap-gpt-6-astra-2026-09-15.md` | `204aa0b32f2669f48ad4c782f95d5b223cc2d9b3b063bd800cd90b68363958b9` |
| `dataflow-architecture.md` | `cc72657ba14aeaf3c2a55d93527da9f8d3ce336c0a7bcd1e2ae745c3004255d9` |
| `repository-audit-2026-09-15.md` | `11b944f4d491ff165b1e1df972969aa1ab3b6f2b96c3690831a4f240f224bb9c` |
