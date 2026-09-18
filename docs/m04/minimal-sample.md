# M04 — A minimal Todo page and its rendering code

This is the existing RxJS-Flow Todo application, now rendered through owned DOM
bindings and keyed rows. It uses RxJS 7, TypeScript, our custom JSX and the retained
Node HTTP backend. The local Worker continuation is documented in [M05b](../m05b/local-development.md).

## Run the page

Use Node 22.22.1. From an existing checkout, use the merged main branch:

```bash
git fetch origin
git switch main
git merge --ff-only origin/main
npm ci
```

In one terminal, start the Todo backend:

```bash
npm run dev:server
```

In a second terminal, start the page:

```bash
npm run dev:client
```

Open **http://localhost:5173**. The page's `/api` requests reach the Node backend
on port 3000 through the existing Vite proxy. Stop both commands with Ctrl+C.
The backend is in memory; its tasks reset when it restarts. The inherited seed
title still references the original `rxjs-stack` project.

Add two tasks, complete one and delete the other. The counts update, and an
unchanged row stays the same DOM node. Refresh reads the current server list.
To observe unsent input, type a draft, refresh, and confirm that it remains. A
normal click on Refresh moves focus to that button; rendering itself does not
choose a different focused control. While a write is pending, its row has
`aria-busy="true"`; a pending create shows `Adding…` and disables submission.
Operation failures appear in the page and allow the next action to proceed.

## The small rendering pattern

This excerpt is the summary binding from [todo.view.tsx](../../src/client/todo.view.tsx).
`scope`, `summary`, `viewModel$` and `onError` are supplied by the mounted view:

```typescript
import { map } from 'rxjs';
import { bindText } from './dom/bindings';
import type { ViewModel } from './todo.selectors';

function remainingText(view: ViewModel): string {
  return `${view.remaining} remaining · ${view.completed} completed`;
}

bindText(
  scope,
  summary,
  viewModel$.pipe(map(remainingText)),
  onError,
);
```

View-model values flow when the model changes. `remainingText` supplies the domain
wording; `map` applies it to each value. The pipeline describes that flow.
`bindText` activates its DOM sink through `scope.subscribe`, writes only when the
element's text differs, and reports commit errors through `onError`. Disposing the
scope disconnects the binding.

The model already shares one owned state execution. Binding another label does
not repeat state accumulation or execute an HTTP request. Rendering is synchronous;
there is no animation frame, timer or implicit delay policy in this sample.

Rows use the same pattern for title, checked state, attributes and class. A keyed
list maintains one child scope for each Todo ID. Changes update the existing row;
reordering moves that node; deletion releases its scope. A pending toggle retains
the captured native checkbox choice until the row's accepted writes settle, then
reconciles the same control with confirmed state. This is local UI feedback, not
proof of a committed or rolled-back server write.

## Where to look

| File | Responsibility |
|---|---|
| [index.html](../../index.html) | Stable page shell and native controls |
| [browser.ts](../../src/client/browser.ts) | Explicit mount and hot-replacement ownership |
| [main.tsx](../../src/client/main.tsx) | Connect model, view, effects and typed input streams |
| [todo.view.tsx](../../src/client/todo.view.tsx) | Named view projections and DOM sink subscriptions |
| [todo-item.tsx](../../src/client/components/todo-item.tsx) | One row's bindings and typed input events |
| [bindings.ts](../../src/client/dom/bindings.ts) | Text/property/attribute/class/conditional sinks |
| [keyed-list.ts](../../src/client/dom/keyed-list.ts) | Identity, order, focus and child lifetimes |

[Acceptance evidence](acceptance.md) records executed tests and runtime checks.
This checkpoint does not activate application SSE, implement durable server
authority or deploy the page.
