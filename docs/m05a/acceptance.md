# M05a — Cloudflare/Hono foundation acceptance

Date: 2026-09-17. Revision: **rxjs-flow migration r2 — Cloudflare/Hono**.
Status: implemented and locally verified; acceptance review/merge pending.
The [local workflow](local-development.md) is the runnable checkpoint guide.

## Provenance and scope

- Repository: `hansschenker/rxjs-flow`; branch: `m05a/cloudflare-foundation`.
- Starting commit: `188f21ff307ff7d2146d9f90b24e5ee5c7dfd99d`, verified merged PR #5.
  M01 is accepted. Its original evidence and source history remain preserved.
- Implementation commit: `3e29ed1775bad5b5ca15d6acd44822272caf76be`.
- [Execution records](execution.json) contain the implementation tree, exact
  commands, UTC timestamps, exit codes and selected output. Subsequent evidence
  changes are documentation-only; final PR-head CI is recorded in the PR.

The user explicitly authorized M05a after M01. This is one platform foundation
checkpoint, not M05 completion. No Todo handler, browser behavior, Node server,
existing route contract or state machine was migrated. There is no durable store,
SSE integration, deployed Worker or account/domain modification.

## Toolchain decision

| Component | Resolved version | Treatment |
|---|---|---|
| Node / npm locally | 22.22.1 / 11.9.0 | Existing recorded Node baseline retained |
| RxJS / TypeScript | 7.8.2 / 6.0.3 | Retained |
| Vite / Vitest / coverage | 8.0.12 / 4.1.6 / 4.1.6 | Retained; custom JSX uses the Vite 8 Oxc configuration |
| Hono | 4.13.8 | New exact runtime pin |
| Wrangler | 4.133.0 | New exact development pin |
| Cloudflare Vite plugin | 1.54.11 | New exact development pin; peers include Vite 8 |
| Cloudflare Vitest plugin | 1.1.11 | New exact development pin; peers include Vitest 4.1 |
| workerd | 1.20260916.1 | Resolved by the pinned official tooling |
| Miniflare | 5.20260916.0-alpha | Exact transitive dependency selected by those official packages |

Published engine/peer metadata was inspected with `npm view`; `npm ls` confirms
the actual compatible resolution. No RxJS/Node major upgrade or `@hono/cli` was
introduced. The current official test package is `@cloudflare/vitest-plugin`, with
`cloudflareTest()` and `cloudflare:workers`; older pool-package examples were not
copied. Direct existing dependencies stayed at their locked versions. Adding the
toolchain also resolved existing shared transitive entries `semver` 7.8.0 → 7.8.5
and `undici` 7.25.0 → 7.29.0; these changes are explicit in the lockfile. No unrelated
dependency PR was merged. This is compatibility evidence, not a new security audit.

Sources: [Cloudflare test configuration](https://developers.cloudflare.com/workers/testing/vitest-integration/configuration/),
[test APIs](https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/),
package metadata and installed package declarations/source for the resolved versions.

## Verified behavior

`src/worker/index.ts` registers inert Hono routes. A request to `/api/foundation`
activates an injected, typed RxJS operation using only the label capability. The
default operation emits one `FoundationResult`. `firstValueFrom` is confined to
the HTTP host boundary: first result unsubscribes; empty/error produces JSON 500;
request abort produces 499; a one-second timeout produces 504. Cancellation is
registered before source activation. Tests cover synchronous teardown, pending
cancellation, independent requests and recovery. These are the probe's declared
semantics, not a generic adapter or acceptance of all M05b transport requirements.

There is no mutable Worker-global Todo state. Application bindings are generated
from `wrangler.jsonc`; the production export satisfies `ExportedHandler<WorkerEnv>`.
Browser, Worker and Node production projects have separate ambient types. Inspection
of the actual TypeScript programs found no `@types/node` files in browser/Worker
programs; Worker also excludes browser `document`/`window`. Shared contracts contain
no platform bindings. Test environments are explicitly separate:

| Execution environment | Tests |
|---|---|
| Node | Retained server/shared tests and actual Vite boundary build tests |
| jsdom on Node | Retained client tests and inherited documentation examples |
| workerd | 16 foundation tests via the official Cloudflare plugin, including the configured production entry |
| Real local HTTP to dev/preview workerd | Shell/JavaScript, foundation JSON, API 404 precedence and frontend fallback |

The build boundary rejects direct, indirect, aliased and dynamic imports of server
code into the browser. Tests exercise real Vite builds, not mock plugin callbacks.
Type-only erased contracts remain usable and the Worker build may import Hono.
Synthetic private/public environment checks establish the intended exposure rule.

## Acceptance criteria

| M05a requirement | Evidence | Result |
|---|---|---|
| Clean install, typechecks and existing tests at recorded toolchain | Clean `npm ci` installs 153 Linux packages; all five TS projects pass; original 219 tests retained within 236 Node/DOM tests | Pass |
| Actual Worker-runtime test | `npm run test:worker`: 16 tests in workerd, including production entry invocation and owned teardown | Pass |
| Existing JSX assets build | Client output 29.24 kB JS; Worker output 103.38 kB; no scaffold or JSX replacement | Pass |
| Hono invokes a typed, owned RxJS operation | Probe tests plus real dev/preview `/api/foundation` JSON 200 | Pass |
| Built output can be previewed locally | HTTP smoke fetches built HTML/JS and API; SPA paths resolve while `/api`, `/api/missing`, `/api/todos` remain JSON 404 with navigation headers | Pass |
| Server-only imports excluded from browser | 17 actual Vite build boundary tests plus production build guard | Pass |
| Login/account status stated accurately | Local Wrangler login/whoami help verified; commands documented; no login or account check executed | Satisfied; remote authentication not needed |

Final totals: **236 tests / 24 Node/DOM files + 16 tests / 1 Worker file = 252 tests**.
The smoke tests additionally pass for both development and built preview.

## Commands and results

Commands run with Node 22.22.1, the same npm recorder used for M01, and the project
working directory. The JSON records preserve actual arguments and timestamps.

| Command/check | Result |
|---|---|
| Baseline `npm run typecheck` and `npm test` | Pass, original 219 tests / 23 files |
| `npm install --save-exact hono@4.13.8` | Pass |
| `npm install --save-dev --save-exact wrangler@4.133.0 @cloudflare/vite-plugin@1.54.11 @cloudflare/vitest-plugin@1.1.11` | Pass |
| Tests-first Worker run before entry existed | Expected exit 1: missing `./index`; runtime starts, no test executes |
| Tests-first browser guard with no-op implementation | Expected 11 failures / 3 passes |
| Additional alias-bypass regression | Expected 1 failure / 16 passes; resolved-file guard fixes it |
| Final `npm ci` | Pass; clean lockfile install |
| Remove ignored generated types, then `npm run typecheck` | Pass; generates types and checks client/Worker/Node/test projects |
| `npm run cf:typecheck` | Pass; generated types current |
| Final `npm test` | Pass, 236 / 24 files, including 17 build-boundary cases |
| Final `npm run test:worker` | Pass, 16 / 1 file in workerd |
| Final `npm run build:worker` | Pass, client and Worker output |
| `node scripts/smoke-worker.mjs --dev` | Pass, local development runtime HTTP |
| Final `npm run smoke:worker` | Pass, built preview runtime HTTP |
| `npx wrangler login --help` and `npx wrangler whoami --help` | Pass; CLI capability only, no authentication action |
| `git diff --check`, ignore checks, unchanged-baseline diff | Pass; client/Node code and existing shared routes unchanged |

Inspection also used `git fetch origin main`, `git status`, `git log`, `git show`,
`git diff`, `git rev-parse`, `rg`, package/source reads, `npm view`, `npm ls`, and
read-only GitHub PR verification. The dedicated branch was created from actual
merged main. Destination-only GitHub tree/commit/ref operations publish changes;
the tree is compared to `git write-tree`, then a fetch and equality-guarded
`git reset --soft` synchronize the local branch without discarding work. PR creation
and its exact final-head CI record complete publication. No merge is automatic.

## Resolved issue and limits

The first preview attempt failed before serving: the optional inspector selected a
port by calling `os.networkInterfaces`, which this workspace cannot enumerate
(`uv_interface_addresses`). Setting the documented `inspectorPort: false` option
removed that unnecessary dependency; subsequent dev and preview smoke tests pass.
No access-control or sandbox override was used. Wrangler proxy/Node experimental
and punycode warnings remain informational. All results report real executions.

No local M05a blocker remains. Tests and smoke ran on Linux; Windows/WSL instructions
use project-local tools but no separate Windows execution is claimed. The smoke
fetches assets and API responses; it does not execute the browser UI. The Worker
shell's Todo API is deliberately absent, and the retained client still has M03
HTTP-error-decoding limitations. Use the Node workflow for functioning Todo CRUD.

Worker tests invoke the production entry directly and exclude static-asset routing;
the separate real-HTTP smoke supplies that evidence. No authentication-protected
Todo route exists on this Worker yet; M05b must verify auth failures and compatibility
without HTML interception. M05c owns persistence, M05d SSE, M06 the live app loop.
These have not been advanced. The recommended next implementation is **M02** after
M05a acceptance/authorization, followed by M03–M04, then M05b–M05d.

Cloudflare OAuth, account membership, remote resources, DNS/routes, production
credentials and deployed behavior remain unverified and untouched. The accepted
r2 ChatGPT Project reference copy remains separately unverified; Git publication
does not synchronize that copy.
