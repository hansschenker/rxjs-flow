# Local Cloudflare/Hono foundation

> Historical M05a checkpoint. For the current Hono Todo API and page, use the
> [M05b development guide](../m05b/local-development.md).

M05a establishes a local Worker endpoint and the existing JSX asset build. The
Todo backend still runs on Node; its Hono migration belongs to M05b. No Cloudflare
account, login, domain, storage or remote binding is needed for this checkpoint.

## Install and verify

Use Node **22.22.1** from `.nvmrc`, then run in the repository root:

```bash
npm ci
npm run typecheck
npm test
npm run test:worker
npm run cf:typecheck
npm run build:worker
npm run smoke:worker
```

`typecheck` first generates `worker-configuration.d.ts` using the pinned project-local
Wrangler. The generated file is ignored and recreated from `wrangler.jsonc`; run
`npm run cf:typegen` after changing the configuration. `cf:typecheck` detects stale
generated types. Browser, Worker, Node/tooling and the two test environments have
separate TypeScript projects.

## Run the checkpoint

```bash
npm run dev:worker
```

Open [the foundation endpoint](http://127.0.0.1:5174/api/foundation). It returns:

```json
{"runtime":"workerd","message":"rxjs-flow foundation"}
```

The Hono route activates one finite RxJS operation for each request. The first
result settles the response and releases its subscription. An abort cancels the
operation; a one-second deadline bounds a source that never emits. This small probe
has no Todo store and is not the general request adapter planned for M05b.

The same dev server serves the existing custom-JSX assets at `/`. This proves asset
integration, **not Todo functionality on Workers**: `/api/todos` returns JSON 404
until backend migration. The inherited client HTTP decoder does not yet handle
non-2xx bodies correctly (M03); use the preserved Node workflow below for CRUD.

Preview the built output:

```bash
npm run build:worker
npm run preview:worker
```

The preview endpoint is [http://127.0.0.1:4174/api/foundation](http://127.0.0.1:4174/api/foundation).
Both dev and preview bind to loopback, with strict ports. The optional Worker
inspector is disabled so local verification needs neither a debugger nor network
interface enumeration. Automated smoke commands choose an available local port:

```bash
node scripts/smoke-worker.mjs --dev
npm run smoke:worker
```

They check the shell and JavaScript, typed API response, API 404 precedence under
browser-navigation headers and SPA fallback. Each command terminates its own server
and workerd processes. These are HTTP checks, not an interactive browser test.

## Preserved Node Todo workflow

In two terminals:

```bash
npm run dev:server
```

```bash
npm run dev:client
```

The Node API remains on port 3000 and the existing Vite client on 5173. Its Vite
proxy strips `/api` before forwarding to Node. The separate Worker configuration
**retains `/api`** for Hono. Neither configuration silently forwards Worker requests
to a running Node server.

## Routing and local configuration

| Path in the Worker dev/preview server | Owner and response |
|---|---|
| `/api/foundation` | Hono → typed RxJS operation → JSON 200 |
| `/api`, `/api/*` otherwise | Hono JSON 404, including `/api/todos` |
| `/` and built assets | Cloudflare/Vite static-asset integration |
| An unknown frontend path | Root HTML via configured SPA fallback |

`assets.run_worker_first` includes both `/api` and `/api/*`, preventing a navigation
request to an unknown API from becoming HTML. The plugin generates the asset
directory in `dist/rxjs_flow_foundation/wrangler.json`, pointing to `dist/client`.
Input configuration deliberately has no account ID, routes, domain, service/storage
bindings or migrations. `remoteBindings: false` and `persistState: false` keep this
checkpoint local and stateless. Compatibility date: **2026-09-16**, no compatibility
flags; Workers application types do not import Node globals.

The only application binding is the public `FOUNDATION_LABEL`. No named production
or staging environment is configured. An optional `.dev.vars` copied from
`.dev.vars.example` may override that label; keep the default for exact smoke results.
`secrets.required` is an explicit empty list, so ambient environment variables do
not become arbitrary Worker bindings. Tests assert the configured application
binding set. `.env*`, `.dev.vars*`, generated types and Wrangler state are ignored,
with explicit exceptions for non-secret examples.

Vite's `VITE_*` variables are public browser inputs: never put secrets in them.
The browser build rejects runtime imports of Node, server/Worker modules, Hono,
Wrangler and Cloudflare packages. Build tests verify that a synthetic private
environment value is absent while an explicitly public value is included. This
is a concrete boundary check, not a claim to detect every possible secret leak.

## Developer authentication, when needed later

These use the installed, pinned Wrangler from the project:

```bash
npx wrangler login
npx wrangler whoami
```

Wrangler 4.133.0 also supports `npx wrangler login --device` when a localhost OAuth
callback is unsuitable. Its help was checked; no login flow was executed here.
`whoami` verifies developer authentication/account membership; it was **not run**
against an account during M05a.

Developer OAuth is separate from future CI deployment credentials and from Todo
end-user authentication. This PR adds no deployment script/workflow, account
mutation or `netxpert.ch` configuration. Local test success does not authorize or
establish deployment. Keep any later credential/resource setup separately reviewed.

Official references checked for this implementation:
[Cloudflare Vite assets](https://developers.cloudflare.com/workers/vite-plugin/reference/static-assets/),
[Worker tests](https://developers.cloudflare.com/workers/testing/vitest-integration/write-your-first-test/),
[generated types](https://developers.cloudflare.com/workers/languages/typescript/),
[Wrangler authentication](https://developers.cloudflare.com/workers/wrangler/commands/general/).
