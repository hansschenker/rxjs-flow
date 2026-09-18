# M05b — Try the Todo page through Hono

Revision: **rxjs-flow migration r2 — Cloudflare/Hono**. This checkpoint runs the
existing M04 page against Hono in the local Cloudflare Workers runtime. RxJS 7,
TypeScript, the shared API contracts and the custom JSX renderer are retained.

## Run the checkpoint

Use Node **22.22.1**. While the milestone PR is being reviewed:

```bash
git fetch origin
git switch m05b/http-ownership
npm ci
npm run dev:worker
```

After the PR is merged, use updated `main` instead. Open
**http://localhost:5174**. This command serves both the browser page and the Hono
API; the Node backend on port 3000 is not needed for this mode. Stop with Ctrl+C.

1. Add a Todo, toggle its checkbox and refresh the page.
2. In Chrome Network, select the `todos` request. Its URL is
   `http://localhost:5174/api/todos`; Response contains the current Todo array.
3. Delete the Todo. The API returns an empty HTTP 204 response.
4. Stop and restart `dev:worker`. The local sample resets to its seed.

The local development configuration explicitly enables `LOCAL_TODO_DEMO`. Its
in-memory store belongs to this local demo and lasts across requests in that
running instance. It is neither a database nor shared state across Worker
instances. Durable collection authority and restart recovery belong to M05c.
The production configuration leaves this capability disabled.

## Observe validation and recovery

From another terminal while `dev:worker` runs:

```bash
curl -i http://localhost:5174/api/todos
curl -i -X POST http://localhost:5174/api/todos -H 'Content-Type: application/json' --data '{'
curl -i -X POST http://localhost:5174/api/todos -H 'Content-Type: application/json' --data '{"title":""}'
curl -i http://localhost:5174/api/todos
```

Expected statuses: **200, 400, 422, 200**. Bad JSON and a rejected title do not
stop the server. Requests carry ordinary JSON; Observables remain inside their
own runtime.

## What owns the request?

Hono matches a registered route and extracts method, path, parameters, query,
headers and a body bounded to 1 MiB. A request operation owns body decoding,
validation, middleware, the server Effect, and finite response conversion. The
Effect still maps a request stream into a response-description stream.

Construction describes this execution. `start()` subscribes once; observing the
result does not execute it again. A successful finite handler must emit exactly
one response and complete. Empty or multiple results produce 500; an operation
that has not settled within the absolute 10-second deadline produces 504.
The host's abort signal cancels that request's work. Other requests keep running.
A completed mutation is not rolled back by a later disconnect.

The request result and an SSE response body have separate lifetimes. Worker live
streaming remains M05d and returns a defined 501 at this checkpoint. The browser
continues to use finite HTTP refreshes.

## Build and retained Node mode

```bash
npm run build:worker
npm run preview:worker
```

Open **http://localhost:4174**. The built assets and foundation endpoint run, but
`/api/todos` deliberately returns **503: Todo storage is not configured**. The
build does not silently turn development memory into deployed authority. M05c
will supply the storage capability. No deployment or Cloudflare login is needed
for these local checks.

The retained Node mode remains available in two terminals:

```bash
npm run dev:server
npm run dev:client
```

Its page remains **http://localhost:5173**, proxied to the Node API on port 3000.
This mode also stores Todos in memory. See the [acceptance and compatibility
record](acceptance.md) for the checks and deliberate API migrations.
