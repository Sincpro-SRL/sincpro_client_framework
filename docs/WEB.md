# Web on the client framework

The application layer lives in `@sincpro/client-framework`; @sincpro/web-framework gives the
browser's pieces: React, the screens, the browser's tracing and error reporting. This page is
how a web application adopts it — a plan, not a claim that it is adopted.

| Responsibility        | Here                                                                                         | Web                                                                                  |
| --------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Application execution | `BoundedContext`, Commands, events, Features, AppServices                                    | A hook that runs a use case from a component, with its state                         |
| Pipeline              | interceptors, `onStart` / `onCompletion` / `onFailure`                                       | What a screen shows of a run: busy, done, failed                                     |
| Observability         | Tracer, ErrorReporter, Logger ports; console by default                                      | `browserTracer`, `sentryReporter` (web-framework), plugged in `main`                 |
| Context               | levels, `ContextStore`, `memoryContexts()`                                                   | `useContextValues`; a store over `sessionStorage` if it must survive a reload        |
| Events                | `Publisher`, `Subscriber`, `syncQueue`, the `MessageQueue` port                              | `syncQueue` by default; IndexedDB to work offline; `BroadcastChannel` for other tabs |
| Server                | `OperationTransport` and its REST / JSON-RPC adapters, generated clients, `screensTransport` | Choosing the wire, wiring the session's headers                                      |

## Startup

A production build keeps class names — a service's name is its class's, taken at registration —:
Vite's `esbuild: { keepNames: true }` (and `build.minify` left to esbuild).

```ts
// entrypoints/main.tsx
configureProcess({
  tracer: browserTracer({ endpoint: settings.otlp, service: "forge-web" }),
  reporter: sentryReporter(client),
  logger: { mode: import.meta.env.PROD ? "production" : "development" },
});
```

## Reaching the services

```ts
// domains/common/infrastructure/operations.ts — what `sincpro-client scaffold` imports
export const operations = restOperations(
  restTransport({ base: "/v1", headers: () => session() }),
);
```

Every generated client of the application is made over it; changing to JSON-RPC is changing this
line (`jsonRpcOperations({ endpoint: "/rpc", headers })`). Screens that list and edit entities
keep the REST `Transport` underneath (`entity()`, `screensTransport`).

## Running a use case from a screen

A screen executes a bounded context's Command; the pipeline traces it, reports it and answers
through its handlers. What web-framework adds is the React side: the pending state, the answer,
the error, and dropping the answer of a screen that closed.

```ts
const { run, busy, answer, error } = useExecute(sales);
await run(new CommandQuote(3)); // ResponseTotal
```

`processListeners.onStart`, `onCompletion` and `onFailure` are where an application-wide
indicator (a toast, a progress bar) hears every run of every bounded context. A hook passes the
screen's `AbortSignal` (`execute(command, { signal })`): a screen that closes cancels its run and
its requests, which end `aborted`, never reported. `failureOf(error)` tells the screen what to do
— fix the form, sign in again, retry, refresh — whatever the wire. A `CircuitBreaker` around a
transport (`guardedTransport`) stops a screen from hammering a backend that is down.

## Events in a browser

The same `Publisher` and `Subscriber` as on a phone; what changes is the queue:

- **`syncQueue(subscriber)`** — in the call, in memory: what a single tab needs.
- **`storedQueue({ store, subscriber })`** — stored first, delivered in order and decided by
  the same verdict as on a phone. `memoryMessageStore()` in a tab; an IndexedDB
  `MessageStore` for a point of sale that works offline.
- **`BroadcastChannel`** — an adapter that also tells the other tabs; each tab's `Subscriber`
  executes the event in its own bounded contexts.
- **From the server** — with the backend's server-sent events, an entrypoint that rebuilds each
  event (`subscriber.eventTypeOf(name)`) and hands it to `subscriber.handle(event, envelope)`.

Events a backend publishes are generated types when its contract is exported with `--events`;
a screen narrows `DomainEvent` by `name`. They are registered as they are generated —
`@bc.feature(events.IssueClosed)` — and the one `Subscriber` recognizes them by name.

## Work on a schedule

A web application has no cron: a closed tab runs nothing, and Periodic Background Sync is
Chromium-only, for an installed PWA, at the browser's choosing. What looks like one is something
else:

- **Keeping a screen fresh** is the screen's — a query's refetch interval, or polling while a
  stream is down (synthesis's execution view) —, executing a Query through its bounded context.
- **Work that must happen on time** is the backend's `Crons`; the web hears its result as an
  event or reads it.

So a web module has no `entrypoints/cron/`. When a web application needs scheduled work of its
own, a cron registry and a `Scheduler` port come to the client framework.

## Adoption order

1. Depend on a published release; never a local link or a version written by hand.
2. Plug the tracer, the reporter and the logger once, in `main`.
3. Write each bounded context's Commands and services; inject the generated client.
4. Add the React hook that runs a use case; keep `screensTransport` for what a screen reads
   directly.
5. Start with `syncQueue`; add a durable or cross-tab queue when a screen needs it.

See the [shared vocabulary](UBIQUITOUS_LANGUAGE.md), [MOBILE.md](MOBILE.md) and the
[README](../README.md).
