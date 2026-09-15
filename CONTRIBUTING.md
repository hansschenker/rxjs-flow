# Contributing to rxjs-flow

Thank you for your interest in contributing. This project is a focused reference implementation of five Marble.js patterns in pure RxJS — contributions that keep it clean, educational, and idiomatic are most welcome.

Read the [canonical roadmap](docs/roadmap-gpt-6-astra-2026-09-15.md) and [baseline record](docs/baseline-rxjs-flow-m00.md) before implementation. Work on the current milestone only.

## What belongs here

- Bug fixes in the server core or client layer
- Additional tests that improve coverage or document edge cases
- Documentation improvements — clarity, examples, corrections
- Performance improvements that do not add complexity

## What does not belong here

- New frameworks or libraries beyond the current stack
- Features unrelated to the five core patterns
- Rewriting existing patterns in a different style

## Getting started

```bash
git clone https://github.com/hansschenker/rxjs-flow.git
cd rxjs-flow
npm ci

npm run dev:server   # API server on port 3000
npm run dev:client   # Vite client on port 5173+
npm test             # run the test suite
npm run typecheck    # TypeScript strict check
```

## Code style

| Rule | Value |
|---|---|
| Indentation | Tabs |
| Quotes | Single |
| Variable declarations | `const` / `let` — never `var` |
| Observable naming | `$` suffix — `state$`, `action$` |
| Types | Always explicit on public APIs |

- Use `pipe()` chains — no imperative loops over streams
- Use `tap()` for side effects — never inside `map()`
- No nested subscriptions — flatten with `switchMap` / `mergeMap` / `concatMap` / `exhaustMap`
- No `any` — use `unknown` and narrow, or define a proper type

## Workflow

1. Fork the repository
2. Create a branch: `git checkout -b fix/<short-description>`
3. Write a failing test first, then implement the fix
4. Run `npm test` and `npm run typecheck` — both must pass
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
- [ ] Typecheck passes (`npm run typecheck`)
- [ ] New code has tests
- [ ] No `any` types introduced
- [ ] Commit messages follow the style above

## Questions

Open an issue at [github.com/hansschenker/rxjs-flow/issues](https://github.com/hansschenker/rxjs-flow/issues).
