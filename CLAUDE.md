# CLAUDE.md

Development target: `hansschenker/rxjs-flow`. Read [AGENTS.md](AGENTS.md), the
[canonical roadmap](docs/roadmap-gpt-6-astra-2026-09-15.md) (**rxjs-flow migration r2 — Cloudflare/Hono**),
[architecture contract](docs/dataflow-architecture.md), and
[runtime decision](docs/runtime-cloudflare-hono.md) before changes.

M00 is accepted/closed at `c9197b68591e390a0a3add4667e5dd23717d6b6e` (PR #2).
M01 implementation is ready for acceptance review; see [its evidence](docs/m01/acceptance.md).
M02–M09 remain pending. Use a dedicated branch and PR; do not start a milestone,
merge, publish, deploy, create remote resources or change `netxpert.ch` without
appropriate explicit authorization. `rxjs-stack` and `rxjs-fullstack` are historical/
separate repositories, not implementation targets.

The r2 target is RxJS 7 + TypeScript + existing custom JSX, Hono HTTP integration
on Cloudflare Workers, Vite/Cloudflare build tooling, project-local Wrangler, and
a minimal Durable Object authority. These are planned, not implemented. Keep Node
as the baseline during the tested transition. Hono does not replace our renderer.
Do not use mutable Worker-global state as authority or pass Hono context into reducers.

Next authorized implementation: M01, then early M05a, then M02–M04 and remaining
M05 substeps as specified in the roadmap. No permanent Node-only constraint or
instruction to reopen M00 is in force. Do not merge the intentionally failing
`m00/characterize-baseline` probes.

## Existing Node baseline reference

The commands and examples below describe the inherited implementation, not the
r2 target contract or acceptance of its known lifecycle/outcome gaps. In particular,
module-global client state, positional replay defaults and full rerendering are
starting points to be corrected in M01–M04. Preserve tested behavior while changing
its ownership. The unmodified earlier guide is archived at
[CLAUDE-before-cloudflare-r2-2026-09-17.md](docs/archive/CLAUDE-before-cloudflare-r2-2026-09-17.md).
Existing `src/claude-md.test.ts` examples remain baseline tests; no test code is changed
by this documentation revision.

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
| `src/server/todos/` | Concrete CRUD: store (BehaviorSubject), validator (Zod schemas), effects |

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

The single source of truth for every endpoint. One `RouteContract` declaration covers method, path template, body type, query type, and response type.

```typescript
// Derive types from the contract
type TodoParams  = RouteParams<typeof routes.todos.update.path>; // { id: string }
type CreateBody  = RouteBody<typeof routes.todos.create>;        // CreateTodoBody
type CreateResult = RouteResponse<typeof routes.todos.create>;   // Todo

// Build type-safe URLs
apiPath(routes.todos.update.path, { id: '42' }); // /api/todos/42
```

In the Node baseline, adding an endpoint means one entry in `src/shared/routes.ts`
and a `handle(contract, effect)` in the server router; the typed client uses that
contract. M05b must test the corresponding Hono mapping, without duplicating the
contract. Type inference never replaces runtime validation of external input.

### Client (`src/client/`)

| File | Responsibility |
|---|---|
| `src/client/h.ts` | Custom JSX factory (`h`) — no React |
| `src/client/todo.state.ts` | MVU state: `Subject` → `scan(reducer)` → `shareReplay(1)` |
| `src/client/todo.service.ts` | Typed client wrappers via `createClient` |
| `src/client/api.ts` | `createClient(routes)` — generates typed Observable methods from the contract tree |
| `src/client/main.tsx` | Entry: wires DOM events to `dispatch`, subscribes `state$` to re-render |

The inherited client MVU pattern, to be replaced by owned instances in M02:

```typescript
export const action$ = new Subject<Action>();
export const state$  = action$.pipe(scan(reducer, initialState), startWith(initialState), shareReplay(1));
export const dispatch = (action: Action): void => action$.next(action);
```

### Generated typed client

```typescript
const api = createClient(routes);
api.todos.list({});                            // Observable<Todo[]>  (query-only route — pass {} or { completed: 'true' })
api.todos.create({ title: 'Ship it' });        // Observable<Todo>
api.todos.update({ id: '42' }, { completed: true });
api.todos.remove({ id: '42' });                // Observable<void>
```

`createClient` walks the contract tree: leaf nodes that match the `AnyRoute` shape are converted to functions; branches become nested objects. Argument order: `(params, body)` or `(query)` — only the slots present in the contract appear, in the order params → query/body.

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
