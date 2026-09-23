# Contributing to rxjs-flow

This project is an RxJS 7 dataflow reference application: browser events,
remembered state, effects, targeted rendering and live server snapshots have
explicit owners. Hono and Cloudflare Workers provide the primary HTTP/runtime
boundary, with a durable Todo collection. The original Marble.js-inspired
patterns and source attribution remain part of its history.

Read the [canonical roadmap](docs/roadmap-gpt-6-astra-2026-09-15.md) and [baseline record](docs/baseline-rxjs-flow-m00.md) before implementation. Work on the current milestone only.

## What belongs here

- Bug fixes in the server core or client layer
- Additional tests that improve coverage or document edge cases
- Documentation improvements — clarity, examples, corrections
- Performance improvements that do not add complexity

## What does not belong here

- New frameworks or libraries beyond the current stack
- Features outside the accepted roadmap and current milestone
- Rewriting existing patterns in a different style

## Getting started

```bash
git clone https://github.com/hansschenker/rxjs-flow.git
cd rxjs-flow
nvm use              # Node 22.22.1, or select .nvmrc with your version manager
npm ci
npm run dev:worker   # http://localhost:5174; no Cloudflare login required
```

The retained Node mode is a tested local compatibility option with in-memory
storage. See the [delivery guide](docs/m09/delivery.md) for its commands and
limits, the complete verification workflow and built-preview behavior.
The built configuration intentionally disables Todo access; the guide explains
the explicit local-only override used to verify the complete built application.

## Code style

| Rule | Value |
|---|---|
| Indentation | Tabs |
| Quotes | Single |
| Variable declarations | `const` / `let` — never `var` |
| Observable naming | `$` suffix — `state$`, `action$` |
| Types | Always explicit on public APIs |

- Use `pipe()` chains — no imperative loops over streams
- Keep named reducers, selectors and transformations pure. Put external work in
  owned adapters/effect streams; rendering never initiates network writes.
- Make competing-work policies explicit: latest (`switchMap`), overlap
  (`mergeMap`), queue (`concatMap`) or ignore while busy (`exhaustMap`). State
  queue limits separately; serialization alone does not bound waiting work.
- Construction describes the graph; subscription/activation starts it. Internal
  subscriptions require a named owner and teardown path. Dispose cancellation,
  listeners, timers, live responses and queued work at the appropriate lifetime.
- State consumers share one app-owned execution. Extra consumers must not repeat
  reductions or effects. Test synchronous sources and reentrant feedback.
- No `any` — use `unknown` and narrow, or define a proper type

## Workflow

1. Fork the repository
2. Create a branch: `git checkout -b fix/<short-description>`
3. For behavior corrections, reproduce the failure before implementing the fix
4. Run the relevant tests and the [delivery verification commands](docs/m09/delivery.md).
   Worker changes require workerd evidence; Node tests alone are insufficient.
5. Open a pull request against `main`

## Commit messages

Imperative present tense, concise subject line:

```
fix: router fails to match paths with trailing slash
feat: add cors() middleware
test: add edge cases for validate() with nested codecs
docs: clarify Effect type in README
```

## Pull request checklist

- [ ] Tests pass (`npm test`)
- [ ] Worker tests pass (`npm run test:worker`)
- [ ] Typecheck passes (`npm run typecheck`)
- [ ] Generated types, browser/Worker build and delivery checks pass
- [ ] Changed behavior has meaningful verification; commands, results and limitations are recorded
- [ ] No `any` types introduced
- [ ] Commit messages follow the style above

Validation CI does not deploy. A merge, release, remote migration, account/secret
change or public demo requires its own authorization. Preserve RxJS 7 and the
locked toolchain unless an upgrade is explicitly part of the reviewed work.

## Questions

Open an issue at [github.com/hansschenker/rxjs-flow/issues](https://github.com/hansschenker/rxjs-flow/issues).
