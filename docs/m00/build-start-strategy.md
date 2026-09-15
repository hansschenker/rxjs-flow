# M00 client build and server start strategy

Decision date: 2026-09-15. Node **22.22.1**. The M00 task is to select and probe
the build/start direction. Supported production scripts and the combined
static/API smoke test remain M09 delivery work after the lifetime fixes.

## Probes executed

From the repository root after the M00 CLI removal:

```bash
npm exec -- vite build
python docs/m00/server-smoke.py --import tsx src/server/main.ts
npm exec -- esbuild src/server/main.ts --bundle --platform=node --target=node22 --format=esm --packages=external --outfile=build/m00-probe/server.mjs
python docs/m00/server-smoke.py build/m00-probe/server.mjs
```

All four commands passed. Vite compiled 239 modules and produced a client JS
asset of approximately 28.79 kB. The esbuild probe produced a 13.9 kB ESM server
entry, with npm packages external. Both source and emitted server returned
`200 {"status":"ok"}` at `/health` and a valid Todo list at `/todos`.

The [smoke harness](server-smoke.py) uses Python 3 on Linux/WSL to launch the
selected Node process, reserve/check the existing port 3000, poll HTTP readiness
with a five-second limit, read both responses, and terminate only the process
it launched. It is preserved as an M00 evidence harness, not a new production
runtime dependency or public app lifecycle API. These probes were executed
locally; CI currently runs install/typecheck/tests, not these probes.

The original store contains one seeded Todo. An early harness assertion that
the list would be empty was incorrect; it was replaced with status/list/field
checks. A still earlier attempt overlapped `npm ci` and failed in harness
cleanup after the child exited. Both invalid attempts and the later successful
commands are recorded in [commands.json](commands.json). They are not treated
as application regressions or successful smoke evidence.

## Delivery choice

1. Keep Vite for the browser build. M09 should expose `build:client` and check
   the produced HTML/JS in a browser test.
2. Keep Node HTTP for the server. Use a small esbuild ESM entry build targeting
   Node 22, with RxJS and Zod resolved as ordinary runtime npm dependencies.
   The successful probe uses esbuild already present through tsx. Before making
   it a supported script, declare the chosen patched esbuild version directly
   as a dev dependency; do not rely indefinitely on a transitive executable.
3. Expose `build:server`, `build`, and `start:server` in M09. Startup should use
   `node` on the emitted server entry, with explicit readiness/error reporting
   and signal shutdown supplied by M05. No monorepo, alternative HTTP framework,
   publishing setup, or additional package manager is needed.
4. Use same-origin static hosting plus an explicit reverse proxy for `/api/*`
   to the Node server, stripping `/api` as the current development proxy does.
   This is the chosen deployment contract to implement and test later, not an
   already configured deployment. Vite's development proxy is not a production
   hosting configuration.
5. Add a Node-only smoke runner in M09 that starts the built arrangement, reads
   a client asset, performs a real CRUD request through `/api`, then shuts down
   and verifies that the port and resources are released. Keep that integrated
   smoke distinct from the two separate process/HTTP probes recorded here.

## Limits

No full browser end-to-end result, combined static/API deployment, production
hosting, or graceful app-stop guarantee is claimed. The probe ends the child
with an OS signal; the M00 characterization independently demonstrates that
the current `app.stop()` does not dispose live SSE subscriptions. Fix that in
M05 before treating the production start/stop story as complete. Generated
`dist/` and `build/` outputs remain ignored and untracked.

Evidence: [client build](final-client-build.txt),
[server build](server-build.txt), [source startup](server-source-smoke-final.txt),
[emitted startup](server-built-smoke.txt).
