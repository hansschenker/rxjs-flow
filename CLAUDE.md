# CLAUDE.md

Development target: `hansschenker/rxjs-flow`. Read [AGENTS.md](AGENTS.md), the
[canonical roadmap](docs/roadmap-gpt-6-astra-2026-09-15.md) (**rxjs-flow migration r2 — Cloudflare/Hono**),
[architecture contract](docs/dataflow-architecture.md), and
[runtime decision](docs/runtime-cloudflare-hono.md) before changes.

M00 is accepted/closed at `c9197b68591e390a0a3add4667e5dd23717d6b6e` (PR #2).
M01 is accepted/merged in PR #5 at `188f21ff307ff7d2146d9f90b24e5ee5c7dfd99d`.
M05a is accepted/merged in PR #6 at `eeb8d2989884372fa42f4e321295aa7f3e8faa75`.
M02 is accepted/merged in PR #7 at `7374557b6d264a9bfa572526a4f71233fc3aa24e`;
see its [state and transition acceptance](docs/m02/acceptance.md).
M03 is [accepted/merged in PR #8](docs/m03/acceptance.md) at
`c64fda113b599ff9b0b21ae3e20aeff0c473a358`.
M04 is [accepted/merged in PR #9](docs/m04/acceptance.md) at `2b316a477600c91b3105c9e390949c29e90046d3`.
The [minimal binding sample](docs/m04/minimal-sample.md) explains the rendering contract.
M05b is [accepted/merged in PR #10](docs/m05b/acceptance.md) at `1cfbaeca0cede3a08c90631e16cf6bdf2fa750c8`.
M05c is [accepted/merged in PR #11](docs/m05c/acceptance.md) at
`d5500da407611e7856e9e67481a08e15e530aece`. M05d is
[accepted/merged in PR #12](docs/m05d/acceptance.md) at
`540faec7086bb58223c5f475db91710ac0e7389b`; parent M05 is complete. M06 was
explicitly authorized from that merge and is now
[accepted/merged in PR #13](docs/m06/acceptance.md) at
`36d644f529d5660506d6f2aa90e90af562d01440`.
[Two Todo pages](docs/m06/local-development.md) receive committed snapshots
without Refresh, with one owned connection per app and bounded reconnect.
M07 reference-app completion is implemented and locally verified;
acceptance review/merge is pending;
see [M07 acceptance](docs/m07/acceptance.md) and the
[complete local reference-app guide](docs/m07/local-development.md).
M08–M09 remain pending. Use a dedicated branch and PR; do not start a milestone,
merge, publish, deploy, create remote resources or change `netxpert.ch` without
appropriate explicit authorization. `rxjs-stack` and `rxjs-fullstack` are historical/
separate repositories, not implementation targets.

The r2 target is RxJS 7 + TypeScript + existing custom JSX, Hono HTTP integration
on Cloudflare Workers, Vite/Cloudflare build tooling, project-local Wrangler, and
a minimal Durable Object authority. M05a now provides the local platform foundation;
M05b adds owned finite Todo HTTP; M05c adds bounded collection authority, attached
SQLite persistence and reconstruction. M05d adds race-free authority registration
and bounded response-owned live delivery. M06 adds the versioned `/todos/live`
protocol, authoritative application snapshots and one bounded RxJS reconnect
owner. Legacy `/todos/stream` arrays remain unchanged. HTTP mutation replies
settle pending status; snapshots alone replace collection content. Keep Node
as the baseline during the tested transition. Hono does not replace our renderer.
Do not use mutable Worker-global state as authority or pass Hono context into reducers.

M07 starts from the verified M06 merge after the owner's explicit authorization.
M08 requires M07 acceptance and its own authorization, as specified in the roadmap. No permanent Node-only constraint or
instruction to reopen M00 is in force. Do not merge the intentionally failing
`m00/characterize-baseline` probes.

## Existing Node baseline reference

The commands and examples below describe the current Node baseline and client
checkpoints. Module-global client state and positional replay defaults were replaced
in M02. M03 extracts owned effects, validates HTTP responses with Zod and requires
a decoder for generic SSE values. M04 adds owned scalar bindings and keyed DOM rows
under a stable shell, with synchronous commits that preserve focus and selection.
M06 adds versioned live state with explicit connection identity, cancellation,
sharing and recovery. Preserve tested behavior while changing its ownership. The unmodified earlier guide is archived at
[CLAUDE-before-cloudflare-r2-2026-09-17.md](docs/archive/CLAUDE-before-cloudflare-r2-2026-09-17.md).
Existing `src/claude-md.test.ts` examples remain baseline tests.

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development (run concurrently in two terminals)
npm run dev:server   # API server on port 3000 via tsx watch
npm run dev:client   # Vite dev server on port 5173

# Quality checks
npm test             # Vitest run (all tests)
npm run test:watch   # Vitest interactive watch mode
npm run typecheck    # tsc --noEmit strict check

# Run a single test file
npx vitest run src/server/core/router.test.ts
```

Vite proxies `/api/*` → `http://localhost:3000/*`, so the client and server can run independently.

## Baseline architecture

The current implementation is a TypeScript app with custom JSX and Node HTTP.
Its server `Effect` composes streams; pure domain functions need not return streams.
The r2 platform migration must preserve or explicitly adapt these contracts.

### Core type contracts (`src/server/core/types.ts`)

```typescript
type Effect<TRequest>     = (req$: Observable<TRequest>)  => Observable<HttpResponse>;
type Middleware<TRequest> = OperatorFunction<TRequest, TRequest>;
```

The baseline router and route handlers use the server `Effect` contract. Its
RxJS middleware uses `OperatorFunction`; this is distinct from Hono middleware.

### Server layers

| File | Responsibility |
|---|---|
| `src/server/core/http.ts` | Node.js `http.Server` wrapped as an `Observable<RequestEvent>` |
| `src/server/core/bootstrap.ts` | Wires server + global middleware + router |
| `src/server/core/middleware.ts` | `logger()`, `requestId()`, `cors()`, `requireAuth()` — `Middleware` operators and Effect wrappers |
| `src/server/core/router.ts` | Pattern-matching `createRouter`; `get/post/put/del/group/handle` helpers |
| `src/server/core/app.ts` | `createApp()` — injectable services, lifecycle hooks, `/health` + `/ready`, `cors?` and `auth?` options |
| `src/server/core/validator.ts` | `validateBody / validateParams / validateQuery` — Zod narrowing operators |
| `src/server/core/errors.ts` | `HttpError` hierarchy; `errorResponse()` maps any thrown error to a response |
| `src/server/core/response.ts` | `json / created / noContent / redirect` helpers |
| `src/server/core/testing.ts` | `runEffect / runRequest` (in-memory) and `createHttpTestClient` (live HTTP) |
| `src/server/todos/` | Concrete CRUD: bounded memory/durable authorities, Zod validation, pure transitions and effects |

Effects retrieve their `TodoStore` from `req.context.services`, so the store is injectable and unit-testable without HTTP.

`cors()` returns an Effect wrapper `(effect: Effect) => Effect`. Pass it via `AppOptions.cors` — it intercepts `OPTIONS` preflight (returns 204 immediately) and injects CORS headers on all other responses:

```typescript
createApp(routes, {
	middlewares: [requestId(), logger()],
	cors: cors({ origins: ['http://localhost:5173'], credentials: true }),
});
```

`createApp` returns an `App` object with a `router: Effect` field — the fully-wired router (cors-wrapped if configured). Use it directly in tests without starting an HTTP server:

```typescript
const app = createApp(routes, { cors: cors() });
const res = await firstValueFrom(app.router(of(createTestRequest({ method: 'OPTIONS', url: '/todos' }))));
expect(res.status).toBe(204);
```

`requireAuth(verify, options?)` protects the app with a bring-your-own verifier. It reads `Authorization: Bearer <token>`, calls `verify`, and stores the result at `req.requestContext.state.user`. Returns 401 directly on missing/invalid tokens. `/health` and `/ready` are excluded by default:

```typescript
createApp(routes, {
	cors: cors(),
	auth: requireAuth(
		async token => {
			// decode / validate however you like — throw to reject
			const payload = await myJwtVerify(token);
			return payload;                    // stored as req.requestContext.state.user
		},
		{ exclude: ['/login', '/health', '/ready'] },  // replaces defaults — include /health and /ready to keep them
	),
});
```

Access claims inside a route effect:

```typescript
get('/profile', req$ => req$.pipe(
	map(req => {
		const user = req.requestContext.state.user as { id: string };
		return json({ id: user.id });
	}),
))
```

### Shared route contracts (`src/shared/routes.ts`)

The single source of truth for every endpoint. One `RouteContract` declaration covers
method, path template, body type, query type, response type and `responseBody`
metadata: `json` with a Zod schema, `empty` with status 204, or `stream`.

```typescript
// Derive types from the contract
type TodoParams  = RouteParams<typeof routes.todos.update.path>; // { id: string }
type CreateBody  = RouteBody<typeof routes.todos.create>;        // CreateTodoBody
type CreateResult = RouteResponse<typeof routes.todos.create>;   // Todo

// Build type-safe URLs
apiPath(routes.todos.update.path, { id: '42' }); // /api/todos/42

// Response handling follows the contract, including DELETE's empty 204.
routes.todos.list.responseBody;   // { kind: 'json', schema: todoListSchema }
routes.todos.remove.responseBody; // { kind: 'empty', status: 204 }
routes.todos.stream.responseBody; // { kind: 'stream' }
```

In the Node baseline, adding an endpoint means one entry in `src/shared/routes.ts`
and a `handle(contract, effect)` in the server router; the typed client uses that
contract. M05b verifies the corresponding Hono mapping without duplicating the
contract. M05c injects a finite Todo repository capability; the same pure transitions
serve the retained memory adapter and the durable collection authority. Type inference never replaces runtime validation of external input.

### Client (`src/client/`)

| File | Responsibility |
|---|---|
| `src/client/h.ts` | Custom JSX factory (`h`) — no React |
| `src/client/todo.state.ts` | Readonly state, typed intents/facts and pure reducer |
| `src/client/todo.model.ts` / `todo.selectors.ts` | Instance factory; coherent view model and explicit equality |
| `src/client/runtime/program.ts` | Root-owned `scan`, state replay, FIFO ingress and transition records |
| `src/client/todo.intents.ts` | Pure transition-to-intent interpretation and correlated result facts |
| `src/client/todo.effects.ts` | Latest-read cancellation, create admission and one bounded FIFO mutation queue |
| `src/client/todo.service.ts` | Inert `createTodoService({ fetch })` factory and typed compatibility wrappers |
| `src/client/api.ts` | Cold typed HTTP methods, response validation, structured failures and fetch/body cancellation |
| `src/client/sse.ts` | Subscription-owned EventSource adapter with a required decoder from `unknown` |
| `src/client/dom/bindings.ts` | Scope-owned text, property, attribute, class and conditional-content sinks |
| `src/client/dom/keyed-list.ts` | Stable keyed rows, each with a child scope; targeted updates and removal cleanup |
| `src/client/components/todo-item.tsx` | Stable row construction, row bindings and typed DOM intents |
| `src/client/todo.view.tsx` | Stable shell lookup and synchronous bindings from coherent projections of owned state |
| `src/client/todo.program.ts` | Inert Todo feature program; owns model, DOM sources, view/effect wiring and disposal |
| `src/client/main.tsx` | Construction/mount/disposal entry and compatible `createTodoApp` export |
| `src/client/browser.ts` | Executable browser entry with module-owned application handle and mount function |

The M02 model is inert until its owner starts it. Subscribe feedback and views
before start; then activate external inputs. After disposal, construct a fresh
instance. Effects consume `{ message, previous, state }` transition records;
late state consumers receive the current snapshot, but transitions do not replay.
The [M02 checkpoint](docs/m02/acceptance.md) defines ordering and reset behavior.
The host owns one `todoEffects$` subscription and feeds its result facts back into
the model. Component event handlers emit intents; additional state, view-model and transition
consumers do not execute requests. Reads use `switchMap`, repeated create submissions
use `exhaustMap`, and all accepted writes share a bounded `concatMap` queue.
The [M03 checkpoint](docs/m03/acceptance.md) records policies and local verification.
`todo.view.tsx` owns DOM rendering; the app root connects it to the model's
view-model stream. State accumulation is shared; pure selectors run per consumer.
Scalar bindings and keyed rows commit synchronously. Retained
keys keep node identity and row scopes; removal disposes their bindings/listeners.
See [M04 acceptance](docs/m04/acceptance.md) and the
[minimal binding sample](docs/m04/minimal-sample.md) for focus, selection and cleanup behavior.

### Generated typed client

```typescript
const api = createClient(routes);
api.todos.list({});                            // Observable<Todo[]>  (query-only route — pass {} or { completed: 'true' })
api.todos.create({ title: 'Ship it' });        // Observable<Todo>
api.todos.update({ id: '42' }, { completed: true });
api.todos.remove({ id: '42' });                // Observable<void>
```

`createClient` walks the contract tree: leaf nodes that match the `AnyRoute` shape
are converted to functions; branches become nested objects. Only the slots present
in the contract appear, in the order params → query → body. Pass `{ fetch }` as the
second factory argument to inject a transport. Each subscription starts one request;
unsubscription aborts fetch and cancels active body consumption. Non-2xx responses
produce structured HTTP failures; successful JSON must pass the route's Zod schema.
Only the declared empty 204 response emits `undefined`. Streaming routes fail through
the finite client's error channel without starting a request.

The generic SSE adapter requires a decoder. For the existing Node `todos` event:

```typescript
import { fromEventSource } from './src/client/sse';
import { todoListSchema } from './src/shared/todo.schema';

const snapshots$ = fromEventSource('/api/todos/stream', 'todos', value => todoListSchema.parse(value));
```

Constructing this Observable is inert. Each subscription owns its connection;
unsubscribe, transport failure or decode failure removes listeners and closes it.
The same legacy bare-array `todos` event is available from the M05d Worker route.
M06 connects the Todo application through the same owned adapter using the
separate `/api/todos/live` versioned protocol, bounded RxJS recovery and runtime
decoding. The legacy example above remains available for transport diagnostics.

### JSX configuration

TSX uses a custom factory — **not React**. `jsxFactory: 'h'`, `jsxFragmentFactory: 'null'`. Import `h` explicitly in any `.tsx` file. Hono HTTP adoption does not change this selection.

## Baseline testing patterns

**Unit-test an effect in-memory** (no HTTP):

```typescript
import { runRequest, createTestRequest } from '../core/testing';

const res = await runRequest(todoRoutes, createTestRequest({
  method: 'POST',
  url: '/todos',
  body: { title: 'Test' },
  context: createTestContext({ todoStore }),
}));
```

**Integration-test against a live Node server**:

```typescript
const client = createHttpTestClient('http://localhost:3000');
const res = await client.post('/todos', { title: 'Test' });
```

Workers-runtime tests begin in M05a and complement these tests; Node tests alone
are not Cloudflare acceptance. Record actual versions, commands and evidence, keep
credentials out of Git, and do not claim Project reference-copy synchronization
or deployed verification without performing it.
