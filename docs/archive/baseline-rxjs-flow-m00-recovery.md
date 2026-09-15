# M00 — import recovery and baseline evidence

Updated: 2026-09-15. Authority: `roadmap-gpt-6-astra-2026-09-15.md`, revision
**rxjs-flow migration r1**. **M00 is in progress, not complete.**

This record supersedes the earlier empty-repository report for current status.
That report is preserved in `archive/baseline-rxjs-flow-m00-before-import.md`.

## Recovery result and merge requirement

The original 13 source branches and `v1.0.0` tag now exist in `rxjs-flow` with
their original object IDs. Source branches use the destination prefix
`import/rxjs-stack/`. No dependency-update branch has been merged.

The destination initially had no commits. During import troubleshooting, the
documents and downloaded bare clone were committed as ordinary files in a new
root commit. This preserved the packed data, but did not import its commits as
Git ancestry. The subsequent PowerShell fetch/push imported the actual commits
under separate branches.

The recovery branch `m00/recover-import` joins both histories and restores the
application to the repository root. Its initial recovery commit is
`75899b4a91b41998283824d4eba026b1eca731fe`, with these ordered parents:

1. Destination initial commit: `978d1be715cb2d23b9c9a0c875d15cd9707721e7`.
2. Original documentation commit: `d701cb72f14293e96acac2cb163e6434e5fb0f54`.

The documentation commit has the audited application commit
`cbc91eefbccdeaf17221d06c75bdd237fe5e5499` as its sole parent. Thus both the
destination work and original application history are ancestors of the recovery
branch. Original commits, authors, messages and parent relationships are intact.

**The PR requires an ordinary merge commit, not squash or rebase.** Squashing or
rebasing its changes would not preserve the imported audited commit in `main`
ancestry. No merge into `main` is authorized or performed by this recovery.
Recheck both parent histories after an explicitly approved merge before marking
the roadmap's migration gate complete.

At recovery preparation, destination `main` remains
`978d1be715cb2d23b9c9a0c875d15cd9707721e7`. The exact final recovery head is
recorded in its PR and delivery report; this file does not claim that head is
already `main`.

## Imported reference mapping

The source snapshot was first inspected and cloned during this conversation on
2026-09-15. The destination references below were independently verified after
the user's PowerShell transfer. Comparison uses that recorded snapshot, not a
moving source repository.

| Source branch (destination prefix: `import/rxjs-stack/`) | Original and imported SHA |
|---|---|
| `main` | `cbc91eefbccdeaf17221d06c75bdd237fe5e5499` |
| `docs/rxjs-dataflow-plan-2026-09-15` | `d701cb72f14293e96acac2cb163e6434e5fb0f54` |
| `dependabot/github_actions/actions/checkout-7` | `7dcd80b5371119f69e40ed62554bf03adbd1b866` |
| `dependabot/github_actions/actions/setup-node-7` | `d8bd9db84ee35f6299dbac62b6c16b601ec08a36` |
| `dependabot/npm_and_yarn/hono-4.13.1` | `f0c62e30050d6309d7ea3483639068774854bc39` |
| `dependabot/npm_and_yarn/postcss-8.5.25` | `0bb2736fe98e8ef79ec000092b86dfa2fea17436` |
| `dependabot/npm_and_yarn/tsx-4.22.3` | `010a604dd14d2aa53dcbd9ac41d43be3d320dc82` |
| `dependabot/npm_and_yarn/types/node-25.9.1` | `194341a53aafae87a63951894688ccec39d62f60` |
| `dependabot/npm_and_yarn/undici-7.29.0` | `379e0ce36bd8b9c26d5c7b05bc1fef64c8e0f502` |
| `dependabot/npm_and_yarn/vite-8.0.14` | `79e0916e7465cda611da8520f8bf67ec1ca57f20` |
| `dependabot/npm_and_yarn/vite-8.0.16` | `269cbf71c35fa1cccf27d5824d1204b47e23046c` |
| `dependabot/npm_and_yarn/vitest-4.1.7` | `88ab20e7d44c5d3dd93f81b895c271a0deda8205` |
| `dependabot/npm_and_yarn/vitest/coverage-v8-4.1.7` | `7ca3d48f23e0c1b87ef0d71ed2f9ce80116d7daa` |

Tag `v1.0.0` remains `be083d91c1679c30abb1146ae4d00e7cdd9420ac`.
The original clone contained 94 commits across these refs, 82 reachable from
its `main`, and was not shallow. `git fsck --full` passed. The original PR #21
remains a source-repository review; no destination review number is inferred.

No `.gitattributes` or `.gitmodules` path was found among objects reachable from
the recorded source refs. No submodule gitlink was present at source main. These
are scoped checks, not an exhaustive search for orphaned LFS-pointer blobs.

## Working-tree changes

- Restore the original `src/`, JSX, Node HTTP, route contracts, configs, tests
  and MIT license. The entire `src` tree is still
  `6fdf2f7fc951b8fb7be29be2bb9614bf7ca36ad6`, matching the audited source.
- Remove 5,569 tracked `node_modules/` paths and the embedded
  `rxjs-flow-import.xFK66K/` directory from the current index. Both remain in
  earlier commits. Add an ignore rule for future local import evidence.
- Adopt the canonical migration-r1 roadmap and its supporting documents; retain
  older plans, the source README and the initial blocker report under `archive/`.
- Retarget active README, contribution guidance, package repository/bugs/homepage
  and package name to `rxjs-flow`. Keep version `1.0.0`; release entries retain
  historical labels. Lockfile changes are limited to the two root package names.
- Record Node `22.22.1` in `.nvmrc` and CI. Preserve the existing CI actions and
  install/typecheck/test commands; add explicit toolchain output.
- Keep five inherited Claude workflows, Dependabot configuration and local
  Claude permission settings as archived files for separate review. They were
  not active on the destination's initial main and are not newly activated by
  this recovery. No repository permissions, secrets or settings were changed.

`@hono/cli` is present as an inherited development dependency; no Hono import was
found in `src/` or the inspected build/test configs. It is retained pending the
M00 dependency review. No dependency version has been upgraded or removed here.

## Validation

Local recovery-validation toolchain: **Node v22.22.1, npm 11.9.0**, Linux.
The initial environment default was Node v24.19.0. The first npm-based Node 22
bootstrap did not yield a verified result; an output-resume call encountered an
automatic approval-review capacity error, not a safety rejection. A later
bounded bootstrap timed out (exit 124). Installing the architecture-specific
`node-linux-x64@22.22.1` package directly succeeded; its binary reported the exact
version above. No application check used the unverified bootstrap.

| Snapshot | Clean install | Typecheck | Tests |
|---|---|---|---|
| Imported application commit `cbc91eefbccdeaf17221d06c75bdd237fe5e5499`, before recovery housekeeping | Passed | Passed | **180 passed across 19 files** |
| Recovery working tree after housekeeping | Passed | Passed | **180 passed across 19 files** |

The first row validates an actual imported destination ref in an isolated
worktree. It is **recovery evidence**, not a claim that the original source
already appears in destination `main`. The second row tests the working tree
that is committed by this PR; only evidence/documentation is finalized afterward.
Source, test, compiler, Vite/Vitest configuration, index HTML and license bytes
were compared directly with the audited commit and are unchanged.

Warnings observed: the environment's npm proxy configuration and experimental
Node proxy adapter; Vitest also reports that configured oxc options take
precedence over the inherited esbuild JSX options. Warnings are recorded and
have not been hidden by changing runtime code or suppressing checks.

At the start of recovery, the destination had zero CI runs and no open PRs.
CI results for the final recovery head must be read from this destination's PR;
source CI success is not substituted. No build, browser end-to-end, real SSE
disconnect characterization, or production-start smoke test is claimed here.

## Commands actually executed

The source/destination inspection used authenticated read-only GitHub requests
for branches, refs, trees, commits, open PRs and destination workflow runs. The
history join used GitHub's tree/commit/ref operations on `rxjs-flow` only.

The initial destination clone and local history recovery used:

```bash
GIT_TERMINAL_PROMPT=0 timeout 55s git clone https://github.com/hansschenker/rxjs-flow.git rxjs-flow-recovery
mkdir -p rxjs-flow-import.xFK66K/history.git/refs
git --git-dir=rxjs-flow-import.xFK66K/history.git fsck --full
git --git-dir=rxjs-flow-import.xFK66K/history.git rev-list --count --all
git fetch --no-tags ./rxjs-flow-import.xFK66K/history.git 'refs/heads/*:refs/remotes/rxjs-stack/*' 'refs/tags/*:refs/tags/*'
git switch -c m00/recover-import
```

The empty `refs/` directory was missing in the ordinary-file copy of the bare
clone because Git does not track empty directories. It was recreated locally
before inspecting its packed refs; no stored commit object was altered.
The assistant's Git push dry runs failed with missing terminal authentication;
the user's successful PowerShell transfer was then independently verified via
the destination reference mapping above.

Node provisioning and original application validation used these commands from
`/workspace/scratch/69635aad2014` and its indicated worktrees:

```bash
timeout 40s npm exec --yes --package=node@22.22.1 -- node --version
timeout 55s npm install --prefix /workspace/scratch/69635aad2014/m00-node22 --ignore-scripts --no-audit --no-fund node-linux-x64@22.22.1
git worktree add --detach /workspace/scratch/69635aad2014/rxjs-flow-import-validation refs/remotes/rxjs-stack/main
/workspace/scratch/69635aad2014/m00-node22/node_modules/node-linux-x64/bin/node --version
env PATH=/workspace/scratch/69635aad2014/m00-node22/node_modules/node-linux-x64/bin:$PATH npm --version
env PATH=/workspace/scratch/69635aad2014/m00-node22/node_modules/node-linux-x64/bin:$PATH timeout 180s npm ci --no-fund
env PATH=/workspace/scratch/69635aad2014/m00-node22/node_modules/node-linux-x64/bin:$PATH npm run typecheck
env PATH=/workspace/scratch/69635aad2014/m00-node22/node_modules/node-linux-x64/bin:$PATH npm test
```

The clean install/typecheck/test commands were executed in both
`rxjs-flow-import-validation` and `rxjs-flow-recovery`. Recovery housekeeping
used these Git operations plus the documented metadata/doc edits:

```bash
GIT_TERMINAL_PROMPT=0 timeout 45s git fetch origin refs/heads/m00/recover-import
git merge --ff-only origin/m00/recover-import
git rm -r --cached -q node_modules rxjs-flow-import.xFK66K
git mv baseline-rxjs-flow-m00.md docs/archive/baseline-rxjs-flow-m00-before-import.md
git mv import-rxjs-flow.sh docs/archive/import-rxjs-flow-before-recovery.sh
git mv .github/dependabot.yml docs/archive/dependabot-before-recovery.yml
git mv .claude/settings.local.json docs/archive/claude-settings.local.json
git diff --exit-code refs/remotes/rxjs-stack/main -- src tsconfig.json vite.config.ts vitest.config.ts index.html LICENSE
```

Each `.github/workflows/claude-*.yml` file was moved with `git mv` into
`docs/archive/workflows/`. The local fast-forward above updates only the
dedicated recovery checkout; it is not a merge into destination `main`.
A structural JSON comparison verified that dependency/lockfile content is
unchanged except package names, and `git ls-files` verified both generated
directories are absent from the index.

## M00 acceptance status and remaining work

| Acceptance criterion | Current status |
|---|---|
| Destination identity and imported history verified | Refs verified; main ancestry still awaits an approved recovery merge. |
| Audited commit and documentation provenance mapped | Verified in imported refs and recovery parents. |
| Exact destination baseline and differences recorded | Initial destination and source commits recorded; recovery changes enumerated; post-merge main must still be recorded. |
| Clean-checkout commands have results | Node 22 recovery checks recorded above; post-merge migration-gate status remains pending. |
| Remaining failures have reproducible cases and owners | Not complete; characterization table below remains M00 work. |
| Generated dependencies untracked at working head | Verified in the recovery index; main still awaits the PR. |
| Active document links target rxjs-flow | Canonical documents and active guidance updated on the recovery branch. |
| Current branch and destination CI explicit | `m00/recover-import`; destination PR/CI must be assessed at the final head. |

Required characterization still pending: non-2xx client responses and failed
DELETE (M03 fixes); synchronous startup results (M02, with M01 ownership);
root disposal (M01); malformed route parameters, synchronous request-handler
throws and real SSE disconnect (M05). Verify each against the recovered code,
add/reuse reproducible cases on a temporary destination branch, and record
already-fixed behavior rather than assuming all historical concerns persist.

The dependency-update/security review and the client-build/server-start smoke
strategy decision remain M00 tasks. Do not mark M00 complete, proceed to M01,
merge dependency branches, publish a package or deploy based on this recovery.
