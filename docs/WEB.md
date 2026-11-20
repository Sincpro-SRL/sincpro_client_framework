# Web on the client framework

The application layer lives in `@sincpro/client-framework`; @sincpro/web-framework gives the
browser's pieces: React, the screens, the browser's tracing and error reporting. This page is
how a web application adopts it — a plan, not a claim that it is adopted.

| Responsibility        | Here                                                                                         | Web                                                                                  |
| --------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Application execution | `BoundedContext`, Commands, events, Features, AppServices                                    | Hooks that run a use case from a component — a reading, an action — with its state   |
| Pipeline              | interceptors, `onStart` / `onCompletion` / `onFailure`                                       | What a screen shows of a run: busy, done, failed                                     |
| Observability         | Tracer, ErrorReporter, Logger ports; console by default                                      | `browserTracer`, `sentryReporter` (web-framework), plugged in `main`                 |
| Context               | levels, `ContextStore`, `memoryContexts()`                                                   | `useContextValues`; a store over `sessionStorage` if it must survive a reload        |
| Events                | `Publisher`, `Subscriber`, `syncQueue`, the `MessageQueue` port                              | `syncQueue` by default; IndexedDB to work offline; `BroadcastChannel` for other tabs |
| Server                | `OperationTransport` and its REST / JSON-RPC adapters, generated clients, `screensTransport` | Choosing the wire, wiring the session's headers                                      |

## Startup

A production build keeps class names — a service's name is its class's, taken at registration —:
Vite's `esbuild: { keepNames: true }` (and `build.minify` left to esbuild). Next.js has no such
option, and an application on it registers with legacy decorators (`experimentalDecorators`),
which hand over no name: each registration names its service,
`@cursosBoundedContext.feature(CommandLeerCursos, { name: "LeerCursos" })`, and a Command that
travels declares `static commandName` — the README's «Names that survive a minifier».

```ts
// entrypoints/main.tsx
configureProcess({
  tracer: browserTracer({ endpoint: settings.otlp, service: "forge-web" }),
  reporter: sentryReporter(client),
  logger: { mode: import.meta.env.PROD ? "production" : "development" },
});
```

A server that renders pages (Next.js) and runs use cases while it renders traces them on its own
provider, with `openTelemetryTracer`. Built with `{ adoptActiveSpan: true }`, a use case with no
parent starts under the render's span — one trace: render → use case → API — when a context
manager is registered on the server (`NodeSDK` and `@vercel/otel` register one; with a bare
`TracerProvider`, `AsyncLocalStorageContextManager` from `@opentelemetry/context-async-hooks`).
In the browser the option changes nothing. The README's «One trace from a server render». Where
errors go to GlitchTip, `{ recordExceptions: false }` keeps a failure's message and stack out of
the traces — the README's «A failure's detail».

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
through its handlers. What web-framework adds is the React side, one hook for each kind of call
(web-framework, after 2.5.0):

- **An action** — what runs when a person presses — is `useService`: it never runs on mount,
  and gives the pending state, the answer, the error, and drops the answer of a screen that
  closed.
- **A read** — what a screen shows — is `useServiceReading(useCase, args, { follows })`: it runs
  on mount, again whenever its arguments change (keyed by them, so the answer of other
  arguments is never shown), when the process's context changes, and when a write touches an
  entity it follows.

```ts
const quote = useService((quantity: number) =>
  salesBoundedContext.execute(new CommandQuote(quantity)),
);
await quote.run(3); // ResponseTotal; the failure, if any, in `quote.error`

const balance = useServiceReading(
  (memberId: string) => membersBoundedContext.execute(new QueryBalance(memberId)),
  [memberId],
  { follows: [payments] },
);
balance.status === "ready" ? balance.answer : null; // another member starts as "loading"
```

A read run with `useService` ran only when called: a screen re-ran it by hand when a route param
changed, easy to miss, and kept showing the answer of the tab it had left.

`processListeners.onStart`, `onCompletion` and `onFailure` are where an application-wide
indicator (a toast, a progress bar) hears every run of every bounded context. A run takes an
`AbortSignal` (`execute(command, { signal })`): cancelled, it ends `aborted`, never reported, and
its requests with it — what a screen reads can be dropped with the screen; a write, once sent,
is not, since the server may have done it. `failureOf(error)` tells the screen what to do — fix
the form, sign in again, retry, refresh — whatever the wire. A `CircuitBreaker` around a
transport (`guardedTransport`) stops a screen from hammering a backend that is down.

## Which way a screen reaches the backend

There are three ways, and each answers a different need. Choose by what the call does, not by
habit — and start with the lightest that fits:

| The call…                                                                                                                                     | The way                                                                                                                              | What it gives                                                                                                                      |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| lists, opens, edits or runs a declared command of an entity — a back office, a form                                                           | web-framework's entity screens: `useListing`, `useRecord`, `useCommand(entity, "name")`                                              | the model, drafts, dry runs and one `Idempotency-Key` per gesture, with nothing to write                                           |
| calls one operation and has no logic of its own — a read for a panel, a write that forwards what was typed                                    | the generated client over the screens transport: a read with `useServiceReading`, a write with `useService`                          | one line; each call a use case of `screens` (`screens/EntityRead`, `screens/EntitySend`), traced, reported, its route on the span  |
| decides something, composes several calls, publishes or consumes an event, travels in a queue, or is reused by another screen or a subscriber | a Command and its `Feature` (or `ApplicationService`) in the bounded context, read with `useServiceReading` or run with `useService` | a span of its own name, its error handlers and expected errors, its events, the queue, a test in Node with the in-memory transport |

The screens transport is made once, beside `operations`, and handed to web-framework's provider
too — a screens transport given again is answered as it is, so there is one `screens` context:

```ts
// domains/common/infrastructure/screens.ts
export const screens = screensTransport(
  restTransport({ base: "/v1", headers: () => session() }),
);

// domains/tienda/infrastructure/screens.ts
export const tiendaScreens = clientOf(restOperations(screens));

// a screen: what it shows is a reading; what a person presses, an action
const vitrina = useServiceReading(() => tiendaScreens.vitrina(), []);
const reservar = useService((sku: string) => tiendaScreens.reservar({ sku }));
```

A Feature keeps the client made over `operations` — its run already traces each call, and a
screens transport under it would make every call a second use case. When a call gains logic, it
moves to a Feature and only the screen's line changes:
`useServiceReading(() => tiendaBoundedContext.execute(new QueryLeerVitrina()), [])`.

## What a ref points at

A payment, an event or a notification names its record by an entity ref
(`billing.Invoice:0192…`, `EntityRef`). A screen that shows what it points at asks the backend's
`Resolve` — a Query like any other, generated as a method of whichever bounded context publishes
it (`GET /platform/refs?refs=[…]`) —, and each record comes back through its own `Get`, under that
`Get`'s guards:

```ts
const subjects = useServiceReading(
  (refs: EntityRef[]) => platformScreens.resolve({ refs }),
  [payments.map((one) => one.subject)],
);
// subjects.answer?.records: [{ ref, display: "F-0042", record }], in the order asked
```

`display` is what a link shows; `record` is `null` when the record is gone. Where a ref opens is
the application's: `parseEntityRef(ref)` gives its bounded context, its entity and its key. One
to 500 refs per request: with none, ask nothing.

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
4. Add the React hooks that run a use case — `useServiceReading` for what a screen shows,
   `useService` for what a person presses (web-framework, after 2.5.0); keep `screensTransport`
   for what a screen reads directly — [which way](#which-way-a-screen-reaches-the-backend) each
   call takes.
5. Start with `syncQueue`; add a durable or cross-tab queue when a screen needs it.

See the [shared vocabulary](UBIQUITOUS_LANGUAGE.md), [MOBILE.md](MOBILE.md) and the
[README](../README.md).
