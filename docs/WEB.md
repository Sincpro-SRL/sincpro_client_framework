# Web on the client framework

The application layer lives in `@sincpro/client-framework`; @sincpro/web-framework gives the
browser's pieces: React, the screens, the browser's tracing and error reporting. This page is
how a web application adopts it — a plan, not a claim that it is adopted.

| Responsibility        | Here                                                          | Web                                                                                  |
| --------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Application execution | `BoundedContext`, Commands, events, Features, AppServices     | A hook that runs a use case from a component, with its state                         |
| Pipeline              | interceptors, `onStart` / `onCompletion` / `onFailure`        | What a screen shows of a run: busy, done, failed                                     |
| Observability         | Tracer, ErrorReporter, Logger ports; console by default       | `browserTracer`, `sentryReporter` (web-framework), plugged in `main`                 |
| Context               | levels, `ContextStore`, `memoryContexts()`                    | `useContextValues`; a store over `sessionStorage` if it must survive a reload        |
| Events                | `Publisher`, `Subscriber`, `syncQueue`, the `EventQueue` port | `syncQueue` by default; IndexedDB to work offline; `BroadcastChannel` for other tabs |
| Server                | REST transport, generated clients, `screensTransport`         | Wiring the transport and the session's headers                                       |

## Startup

```ts
// entrypoints/main.tsx
configureProcess({
  tracer: browserTracer({ endpoint: settings.otlp, service: "forge-web" }),
  reporter: sentryReporter(client),
  logger: { mode: import.meta.env.PROD ? "production" : "development" },
});
```

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
- **`storedQueue({ store, subscriber })`** — stored first, delivered in order, retried and set
  aside by the same rules as on a phone. `memoryEventStore()` in a tab; an IndexedDB
  `EventStore` for a point of sale that works offline.
- **`BroadcastChannel`** — an adapter that also tells the other tabs; each tab's `Subscriber`
  executes the event in its own bounded contexts.
- **From the server** — with the backend's server-sent events, an entrypoint that rebuilds each
  event (`subscriber.eventTypeOf(name)`) and hands it to `subscriber.handle(event, envelope)`.

Events a backend publishes are generated types when its contract is exported with `--events`;
a screen narrows `DomainEvent` by `name`.

## Adoption order

1. Depend on a published release; never a local link or a version written by hand.
2. Plug the tracer, the reporter and the logger once, in `main`.
3. Write each bounded context's Commands and services; inject the generated client.
4. Add the React hook that runs a use case; keep `screensTransport` for what a screen reads
   directly.
5. Start with `syncQueue`; add a durable or cross-tab queue when a screen needs it.

See the [shared vocabulary](UBIQUITOUS_LANGUAGE.md), [MOBILE.md](MOBILE.md) and the
[README](../README.md).
