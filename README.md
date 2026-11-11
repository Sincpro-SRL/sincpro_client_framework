# @sincpro/client-framework

The client side of [sincpro_framework](https://github.com/Sincpro-SRL/sincpro_framework), for
the web, React Native, scripts and tests: the same application layer as the backend —
Commands, Features, ApplicationServices and a bounded context that is their bus —, observed
the same way, and a typed client generated from a service's contract. No React, no DOM, no
platform storage: what a platform must give, it gives through a port.

- [A bounded context](#a-bounded-context)
- [Domain events](#domain-events)
- [Extending the pipeline](#extending-the-pipeline)
- [Errors](#errors)
- [Observability](#observability)
- [Context](#context)
- [Talking to a server](#talking-to-a-server)
- [Generated code](#generated-code)
- [Values on the wire](#values-on-the-wire)
- [Package layout](#package-layout)
- [Development](#development)

## A bounded context

```ts
import {
  ApplicationService,
  BoundedContext,
  Command,
  Feature,
  Response,
} from "@sincpro/client-framework";

class ResponseTotal extends Response {
  constructor(readonly total: number) {
    super();
  }
}

class CommandTotal extends Command<ResponseTotal> {
  constructor(readonly quantity: number) {
    super();
  }
}

class CommandQuote extends Command<ResponseTotal> {
  constructor(readonly quantity: number) {
    super();
  }
}

class Total extends Feature<CommandTotal, ResponseTotal> {
  static readonly serviceName = "Total";
  declare readonly unitPrice: number; // a dependency, typed

  execute(command: CommandTotal): ResponseTotal {
    this.logger.info("Totalling", { quantity: command.quantity });
    return new ResponseTotal(command.quantity * this.unitPrice);
  }
}

class Quote extends ApplicationService<CommandQuote, ResponseTotal> {
  static readonly serviceName = "Quote";

  execute(command: CommandQuote): Promise<ResponseTotal> {
    return this.featureBus.execute(new CommandTotal(command.quantity));
  }
}

const sales = new BoundedContext<{ unitPrice: number }>("sales");
sales.addDependency("unitPrice", 10);
sales.feature(CommandTotal)(Total);
sales.appService(CommandQuote)(Quote);

const answer = await sales.execute(new CommandQuote(3)); // ResponseTotal — total 30
```

A Command names, by its type, the Response it answers: `execute` infers it, with no second
argument (the backend's `bus(dto, ResponseType)` is accepted too, and checked in TypeScript
only). A Response may be a class, a plain object, a page, a primitive or `void`.

- **One Command, one service.** A Command class is registered once, across both layers, and
  dispatched by its exact constructor. `serviceName` names the service in spans and logs —
  stable, where a minifier renames classes.
- **Dependencies are attributes.** `addDependency` supplies them; a service declares their types
  (`declare readonly client: …`), usually once on a base class per bounded context, as
  `sincpro-client scaffold` writes it. Declaring registers nothing; reading a missing one fails.
  A replacement names what it replaces: `addDependency(name, next, { replaces: previous })`.
- **A service is a singleton of its generation.** What belongs to one request goes in the
  Command or the context, never on `this`. Use TypeScript `private`, not `#private`: a run sees
  the instance through a view of its own.
- **Generations.** The first call (or `buildRootBus()`) builds one; what is registered later
  answers from the next call, and a running call keeps its own. `fresh()` copies the
  registrations; `scoped({ company_id: 2 })` runs with more context and the same instances.
- **Composition.** An ApplicationService runs its context's Features through `this.featureBus`,
  as children of its own execution; never another ApplicationService.

### Decorators, when the project has them

```ts
@sales.feature(CommandTotal)
class Total extends Feature<CommandTotal, ResponseTotal> { … }
```

The same functions work as standard decorators and as legacy ones (`experimentalDecorators`);
without a decorator transform, call them: `sales.feature(CommandTotal)(Total)`. No DI library
and no `reflect-metadata`. The tests compile both decorator forms with TypeScript; a bundler's
transform (Vite, Metro/Babel) is each application's to configure and test.

### Replacing a service

An application takes the place of a service a module registered, as the backend's `replaces=`:

```ts
class PrintOnBixolon extends Print {
  static override readonly serviceName = "PrintOnBixolon";
  override execute(command: CommandPrint) { … }
}
printing.feature(CommandPrint, { replaces: Print })(PrintOnBixolon);
printing.handlerOf(CommandPrint); // PrintOnBixolon
```

`replaces` names the service registered now for that class, or the registration is refused. The
next call answers with the new one; its spans say which it replaced (`sincpro.replaces`). A
service meant to be replaced by a subclass widens its name — `static readonly serviceName:
string = "Print"` —, or TypeScript keeps the literal and the subclass cannot rename itself. A
dependency is replaced the same way: `addDependency(name, next, { replaces: previous })`.

## Domain events

A fact that already happened — `OrderPaid` — is executed as a Command is: by the Feature or
ApplicationService registered for its class, its subscriber in this bounded context, through
the same pipeline (span, log lines, error handlers, report):

```ts
class OrderPaid extends DomainEvent {
  static readonly eventName = "shop.order.v1.paid"; // its wire name, as the backend's `name`
  constructor(readonly order_id: string) {
    super();
  }
}

class ThankCustomer extends Feature<OrderPaid, void> {
  static readonly serviceName = "ThankCustomer";
  async execute(event: OrderPaid) { … }
}

shop.feature(OrderPaid)(ThankCustomer);
await shop.execute(new OrderPaid("o-1")); // span shop/ThankCustomer, sincpro.event = its name
```

- **`eventName` is declared**, as `serviceName` is: a minifier renames classes. `event.name`
  reads it; `name` is reserved, and a subclass cannot make it a field.
- **One subscriber per bounded context.** Another context that hears the event registers its
  own; a `Subscriber` executes it in each.
- An ApplicationService can subscribe too, and compose Features — of Commands or of events —
  through `featureBus`. `execute(event)` answers whatever the subscriber returns (`unknown`).

### Publishing and subscribing

```ts
import { Publisher, Subscriber, syncQueue } from "@sincpro/client-framework";

const subscriber = new Subscriber(mail, stock); // every bounded context that hears
const queue = syncQueue(subscriber); // in the call, in memory — or a platform's
shop.addDependency("publisher", new Publisher(queue));

class Pay extends Feature<CommandPay, string> {
  declare readonly publisher: Publisher;
  async execute(command: CommandPay) {
    await this.publisher.publish(new OrderPaid(command.order_id)); // its Envelope
    return command.order_id;
  }
}
```

The `Publisher` is bound to the run that holds it, so the event joins that run's flow: its
envelope carries the run's `correlationId` and names the run as its cause. The `Subscriber`
executes it in `mail` and in `stock` — `context.execute(event, envelope)` —, so their runs
continue the same flow; one that fails does not stop the others.

What is defined here, and what each platform plugs behind the ports:

| Piece                     | Here                                                           | The platform's                         |
| ------------------------- | -------------------------------------------------------------- | -------------------------------------- |
| `DomainEvent`, subscriber | the class, its `eventName`, its execution                      | —                                      |
| `Envelope`                | `name`, `id`, `correlationId`, `causationId`, `publishedAt`    | storing it beside the event            |
| `EventQueue` port         | `syncQueue` (in the call); `storedQueue` (store, then deliver) | a broker's queue, `BroadcastChannel`   |
| `EventStore` port         | `memoryEventStore()`                                           | mobile: a SQLite table; web: IndexedDB |
| `Subscribes` port         | `Subscriber(...contexts)`, `eventTypeOf(name)`                 | —                                      |

### Stored events: one way to carry them, any store

```ts
const queue = storedQueue({
  store: sqliteEventStore(db), // the platform's EventStore; memoryEventStore() in a tab or a test
  subscriber: new Subscriber(sales, stock, printing),
  ready: (stored) => connectivity.online || !needsNetwork(stored.envelope.name),
  onSettled: (stored) => activity.show(stored.envelope.name, stored.state),
});
shop.addDependency("publisher", new Publisher(queue));
connectivity.onBack(() => queue.drain()); // and on coming back to the foreground
```

`publish` returns once the event is stored. Then the queue delivers what waits, one at a time,
in the order stored — the backend's store-and-forward, over whatever store the platform plugs:

- It is rebuilt as its class — `static fromJSON` when it has one — and executed in every
  bounded context that hears it and does not have it yet: a retry never runs one twice.
- A failure a retry may fix (`failureOf`: unavailable, no answer, a conflict…) is tried again
  after the backoff or the wait it asks for, and what follows waits, so the order holds.
- A failure every attempt would repeat (`PERMANENT_KINDS`: a refusal, invalid, not found) sets
  it aside — the dead-letter queue — and never holds back what follows.
- One that is not `ready` (no connection, no session) waits while the rest go on.
- After `maxAttempts` (10) a failure a retry might still fix is set aside too: a bug of the
  process (`internal`) never holds the line forever.

The port only keeps records — `add`, `next(skip)`, `save` — so a SQLite table, IndexedDB or
memory carry events the same way, with the same rules.

Three things a platform keeps in mind:

- **At least once.** A process that stops after a context executed an event and before the store
  saved it runs it there again. A subscriber that must not act twice keys what it does by the
  envelope's id, `this.execution.causationId` in its run.
- **One drainer per store.** Two tabs over one IndexedDB claim it first (the Web Locks API).
- **Values come back as JSON.** An event that carries a `Money`, a `Decimal` or a date declares
  `static fromJSON` to read them back as such.

The events a remote service publishes arrive as generated types (`DomainEvent` in
`generated/domain.ts`, a union narrowed by `name`); a local event is a class, like a local
Command.

## Extending the pipeline

The flow of a run is the core's — context, chain, span, log lines, outcome, report, handlers —,
and an application changes or hears it from outside, as the backend's `bus_pipeline`:

```ts
// control: around the service — look, veto (throw), adjust (same class), or answer
shop.interceptor(CommandPay)(async (command, next, run) => {
  if (!credit.allows(command.customer_id)) throw new NoCredit();
  return next(command);
});
shop.interceptor()((executable, next, run) => next(executable)); // every class

// observation: never changes the answer
shop.onStart((started) => activity.running(started.execution.useCase));
shop.onCompletion((done) => activity.succeeded(done.execution.useCase), CommandPay);
shop.onFailure((failed) => activity.failed(failed.execution?.useCase, failed.outcome));

// composition: a module or plugin wires its pieces in one place
shop.extend(auditing);
```

- **Interceptors** run inside the run, outermost first in the order registered: a veto is the
  use case's failure — observed, answered by the error handlers. What an interceptor passes on
  keeps its class (the bus routes by class); `run` gives it the use case, the execution and its
  logger. `withoutInterceptor(fn)` stops one; registered later, it wraps from the next call.
- **Listeners** hear each run start and each service that answered, filtered by class when
  named; a failure is heard once, when it escapes the call after every handler, from where it
  first failed. One that throws is ignored. Each `on…` answers how to stop.
  `processListeners.onStart / onCompletion / onFailure` hear every bounded context at once — a
  progress bar, a toast —, after each one's own.
- **`extend(fn)`** is `fn(context)`, said as composition; `fresh()` copies everything an
  extension registered.

## Errors

As the backend's, a bounded context has three chains of error handlers, run
first-registered-first. A handler returns the answer, or throws to hand the error on; the last
one's throw reaches the caller:

```ts
sales.addFeatureErrorHandler((error) => {
  if (error instanceof PriceNotFound) return new ResponseTotal(0); // the answer
  throw error; // the next handler, or the caller
});
sales.addAppServiceErrorHandler(toBusinessError);
sales.addGlobalErrorHandler(toProblem); // what reaches sales.execute or a scope

sales.expectErrors(QuoteExpired); // the business answering: `refused`, never reported
```

A failure is observed where it happened, before any handler runs: its span closes with its
outcome, its log line is written and, when unexpected, it is reported once. A handler decides
the answer, not whether the failure is seen; an answered one adds an `error.handled` line. A
feature handler answers wherever the Feature ran, inside an ApplicationService too; the global
chain wraps only `execute` and `scoped(...).execute`.

### What kind of failure it is

`failureOf(error)` says what any error is, in the backend's words (`FailureKind`, `NextStep`
from @sincpro/criteria), whatever raised it:

```ts
const failure = failureOf(error);
failure.kind; // "conflict", "unavailable", "domain", "unknown_outcome"…
failure.nextStep; // "refresh_and_retry", "retry_later", "authenticate", "do_not_retry"…
failure.retryable; // may sending it again succeed
failure.retryAfter; // seconds to wait first
failure.permanent; // every attempt fails the same way: set it aside
failure.fault; // the system's problem: reported
failure.aborted; // whoever asked stopped waiting
```

It reads, in order: an `AbortError`; what the error declares (`failureKind`, `reason`,
`retryAfter` — on itself or as a static of its class, as the backend's errors do); the `Problem`
the server sent, the same over REST, JSON-RPC and gRPC; a REST status. Not every wire is REST: a
JSON-RPC or gRPC transport — or another backend's adapter, such as Odoo's — makes errors that
declare their kind, with the backend's own tables:

```ts
class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
  get failureKind() {
    return kindOfJsonRpcCode(this.code); // kindOfGrpcCode, kindOfHttpStatus
  }
}
```

How an error ended a use case follows from it (`outcomeOf`):

| Outcome   | When                                                                       | Reported |
| --------- | -------------------------------------------------------------------------- | -------- |
| `ok`      | it answered                                                                | —        |
| `refused` | the caller's answer: a 4xx, a declared kind (`domain`…), or `expectErrors` | no       |
| `aborted` | whoever asked stopped waiting: an `AbortError`, a cancelled run            | no       |
| `failed`  | a fault: a bug, a 5xx, a server nobody reached                             | yes      |

`configureProcess({ outcomeOf })` replaces the process-wide rule. `reportError(error, where)`
reports what fails outside a use case — a view, a worker —, with the same rule.

### Cancelling a run

```ts
const screen = new AbortController();
const answer = sales.execute(new CommandQuote(3), { signal: screen.signal });
screen.abort(); // the run ends `aborted` at once; nothing is reported
```

Its Features inherit the signal, a service reads it as `this.signal`, and every request its bound
transport or generated client sends is cancelled with it — with nothing passed by hand.

### A circuit breaker

```ts
const odoo = new CircuitBreaker("odoo", { failures: 5, openFor: 30_000 });
const transport = guardedTransport(rpcTransport, odoo); // every call through the circuit
await odoo.call(() => printer.print(receipt)); // or one call; odoo.wrap(fn) for a function
```

The backend's `CircuitBreaker`, in this process's memory. After `failures` counted failures in a
row — the dependency did not answer (`unavailable`, `unknown_outcome`, `exhausted`, `internal`) —
it opens: calls fail at once with `CircuitOpen`, `unavailable` with the time left as its
`retryAfter`, so `failureOf`, a stored queue (which waits that long) and a screen already know
what to do. After `openFor`, one call tries: an answer closes it, a counted failure opens it
again. A refusal is an answer and never counts. Put it where the dependency is — the transport, an
adapter —, not in each Feature.

## Observability

The platform plugs the implementations once, at startup; nothing breaks without them:

```ts
import { configureProcess, memoryContexts } from "@sincpro/client-framework";
import { openTelemetryTracer } from "@sincpro/client-framework/opentelemetry";
import { sentryReporter } from "@sincpro/client-framework/sentry";

configureProcess({
  tracer: openTelemetryTracer(provider.getTracer("forge-web")), // the app's provider
  reporter: sentryReporter(client), // the app's Sentry or GlitchTip client
  logger: { mode: production ? "production" : "development" },
  context: memoryContexts(),
});
```

Every execution opens a span `<bounded context>/<serviceName>`; an ApplicationService's Features
are its children, on the same trace. A dependency that is a `Transport` or a generated client is
bound to the run, so each request carries `traceparent` (and `tracestate`) and
`sincpro-context` — the backend continues the trace. A tracer, reporter or logger that fails is
ignored: telling about a use case never changes its answer.

The vendor entries wrap what the application built — they initialize nothing, read no
environment and register nothing global. There is no context manager: the trace reaches the
wire through the transport. On the web, leave the backend's origin out of OpenTelemetry's
automatic `fetch` instrumentation (`ignoreUrls`), or it writes a `traceparent` of a trace of its
own over this one.

### Logging

The application layer imports no logger. Two are predefined, for the code around the use cases:

```ts
import { logger, loggerAdapter } from "@sincpro/client-framework";

logger.info("Database opened"); // infrastructure — the global logger
loggerAdapter.warn("Printer is slow", { ms: 900 }); // an adapter
sales.logger.info("Catalog preloaded"); // a bounded context, outside a use case
this.logger.info("Totalling"); // inside a Feature or ApplicationService
```

| Logger                    | Layer                 | Each line carries                              |
| ------------------------- | --------------------- | ---------------------------------------------- |
| `logger`                  | `infrastructure`      | —                                              |
| `loggerAdapter`           | `adapter`             | the run, when injected as a dependency         |
| `sales.logger`            | `bounded_context`     | its bounded context                            |
| `this.logger`, Feature    | `feature`             | bounded context, use case, execution and trace |
| `this.logger`, AppService | `application_service` | the same                                       |

`this.logger` keeps its run across awaits and concurrent calls, without a global stack. An
adapter that imports `loggerAdapter` at module level writes without the run; inject it
(`sales.addDependency("log", loggerAdapter)`) or pass `this.logger` when a line must carry it.

One configuration, two doors — `configureProcess({ logger })` replaces every process port,
`configureLogger(...)` only logging (an in-app debug switch):

```ts
configureLogger({ mode: "development", level: "info", layers: { adapter: false } }); // the console
configureLogger({ mode: "production" }); // the console, silent
configureLogger({ engine: combineLoggers(consoleLogger({ mode }), lokiLogger) }); // other sinks
configureLogger({ engine: false }); // no logs
```

The console is the default engine. In production it is silent; in development it prints
everything, and `level` and `layers` hide only INFO/DEBUG. A supplied `engine` owns its own
policy, and each sink of `combineLoggers` keeps its own — the console's silence never silences
another. Every execution writes `execution.started` (DEBUG) and `execution.finished` with its
outcome and duration (INFO, WARN when refused, ERROR when failed). No line carries a DTO, a
result, an error body or the session's context unless the author writes it. Delivery, buffering
and credentials (Loki, a phone's queue) are the platform's.

## Context

The values every use case runs with — the tenant, the company —, in levels: the process's, the
bounded context's, a scope's. A root execution reads them once; its Features inherit that
snapshot, and what travels goes to the server in `sincpro-context`.

```ts
processContext.set({ tenant_id: "acme" });
sales.context.set({ warehouse_id: 4 });
await sales.scoped({ company_id: 2 }).execute(new CommandQuote(1));
```

Where the values live is a port (`ContextStore`): synchronous reads, a version per change and an
optional `watch`. `memoryContexts()` is the default; a browser, a phone or a server render plugs
its own. `values` is the same object until it changes, so a screen can hand it to React's
`useSyncExternalStore`.

## Talking to a server

| Piece                          | What it does                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------------- |
| `restTransport({ base })`      | REST over `fetch`: `Idempotency-Key`, the server's `Problem`, model versions, Parquet |
| `memoryTransport(tables)`      | the same contract in memory, copying by the wire's rules — for tests and demos        |
| `entity(key, routes)`          | a model's routes and Commands, typed — what a generated `entities.ts` declares        |
| `retryKeys()`                  | one `Idempotency-Key` per gesture, kept while a retry may repeat it                   |
| `guardedTransport(t, breaker)` | every call of a transport — of any wire — through a circuit breaker                   |
| `screensTransport(transport)`  | screen reads and writes run as use cases of `screens`: traced and reported            |
| `parquetDecoder` (`./parquet`) | large pages read as Parquet through the same transport                                |

Inside a Feature, inject the transport or the generated client as they are — the run already
observes them. `screensTransport` is for what a screen asks directly, outside any Feature.

## Generated code

```bash
python -m sincpro_framework.entrypoints export-client-contract app.http:gateways contracts [--events]
sincpro-client generate contracts/project.contract.json --out src/domains/project/generated --domain project
sincpro-client scaffold contracts/project.contract.json --out src/domains/project
sincpro-client check --root src
```

`generate` writes, from the contract the backend exports — never edited, written again whole:

| File          | What                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------ |
| `domain.ts`   | a type per model, per `<Name>Input`, per operation's input and answer, per domain event    |
| `client.ts`   | `clientOf(transport)`: a method per operation REST reaches; `operations` and `events` data |
| `entities.ts` | each entity's list, record, edit, export, Commands and history, for screens                |

`scaffold` writes, once, the application's own files: its dependencies, its service bases and
`registerServices`. `check` enforces the application's layers and bounded-context boundaries.

**Domain events, on demand.** A backend leaves its events out of the contract unless it is
exported with `--events`. Then each event is a type as it is received — every field present,
`name` its wire name as a literal — and `DomainEvent`, their union, narrows by `name`:

```ts
import type * as remote from "./generated/domain";

function subjectOf(event: remote.DomainEvent): string {
  switch (event.name) {
    case "project.issue.v1.closed":
      return event.issue_id; // remote.IssueClosed
    // …
  }
}
```

`events` in `client.ts` says, per event, its wire name and whether the bounded context records it
(its aggregates' own) or handles it (a Feature subscribes).

### Types, not classes

What is generated is the remote service's contract and an adapter over it, so it is written as
types; the application's own Commands are classes, written by hand.

- **The wire is JSON, and a type says it exactly.** A decimal is text, a day is text, a page is
  `{ items, count, cursor }`. A class around that JSON would claim more than it holds unless
  every field had a reader; a type claims nothing it does not hold.
- **The local bus routes by class, and the remote contract must not reach it.** A generated
  class extending `Command` could be registered and executed locally — the confusion between a
  remote operation and a local use case this package keeps apart. A remote call happens inside
  a local Feature, through the injected client.
- **Events read best as a union.** A stream of facts — a queue, a history page — is narrowed by
  `name`, with no registry of constructors to rebuild each one.
- **Nothing runs.** `domain.ts` adds no byte to a bundle and no side effect; a contract of three
  hundred models costs nothing at runtime.

A local class takes the contract's shape and stays checked against it:

```ts
import type * as remote from "../generated/domain";

class CommandCancelIssue
  extends Command<ResponseCancelIssue>
  implements remote.CommandCancelIssue
{
  constructor(readonly issue_id: string) {
    super();
  }
}
```

The generated name and the local one may be the same — the backend's —, so the generated ones
are imported under their own (`remote`). Validating and converting what arrives (a decimal into
`Decimal`) is a reader's job, not a class's: generated readers are the next step, when a use
needs them.

## Values on the wire

| Value      | Travels as                             | API                                            |
| ---------- | -------------------------------------- | ---------------------------------------------- |
| Decimal    | exact text, `"10.50"`                  | `Decimal`                                      |
| Money      | `{ amount: "10.50", currency: "BOB" }` | `Money`                                        |
| Day        | `"2026-10-02"`, never an instant       | `isDay`, `dayOf`                               |
| Instant    | ISO text                               | `wallTimeOf`, `instantOf`                      |
| ID         | UUID v7 as 32 hex                      | `newEntityId`, `isEntityId`, `momentOf`        |
| Bytes      | `{ "$bytes": "<base64>" }`             | `valuesOf`, `readValues`                       |
| Collection | items, count and cursor                | `collectionOf`, `isPartial`, `relatedCriteria` |
| Export     | Parquet, Arrow or JSON Lines           | `downloadRoute`, `exportRoute`                 |

`Decimal` and `Money` compute exactly, on `BigInt`; a decimal never becomes a `number` and a day
never a `Date`. `valuesOf`/`pack` write; `readValues` reads tagged values back; `rebuilt`/`unpack`
use a reader given explicitly. Cycles, functions and non-finite numbers are refused. How a value
is shown, typed or stored is the platform's.

## Package layout

Each module is laid out as sincpro_framework's are, and says what it offers in its `index.ts`:

```text
src/
  common/          the values of the wire, and what kind of failure an error is
  circuit_breaker/ CircuitBreaker, CircuitOpen
  context/
    domain/          ContextStore and ContextCodec ports, what travels, Execution
    adapters/        memoryContexts, plainCodec
    entrypoint/      Context: one door over a level
    infrastructure/  the process's store and processContext
  observability/
    domain/          Tracer, ErrorReporter, Logger ports
    adapters/        console (default), memory, opentelemetry and sentry (optional entries)
    infrastructure/  the ports this process runs with
    services/        logger, loggerAdapter, reportError, outcomeOf
  client/
    domain/          Transport, TransportError, entity(), the client contract
    adapters/        rest, memory, parquet (optional entry)
    services/        discovery, retry keys, propagation of trace and context
  model/           defineMeta, metaFromSchema, metaStore
  core/
    domain/          Command, DomainEvent, Response, Feature, ApplicationService, FeatureBus,
                     ErrorHandler, the pipeline's extension points
    services/        the execution pipeline, interceptors, dependency binding, the handler chain
    entrypoint/      BoundedContext, screensTransport
    infrastructure/  configureProcess, configureLogger, processListeners
  event_driven/
    domain/          Envelope, the EventQueue, Subscribes and EventStore ports
    adapters/        syncQueue, storedQueue, memoryEventStore
    entrypoint/      Publisher, Subscriber
  codegen/         the generator and its CLI — the only place Node is allowed
  testing/         memoryTracer, memoryReporter, memoryLogger
```

| Entry                                                   | What                                        |
| ------------------------------------------------------- | ------------------------------------------- |
| `@sincpro/client-framework`                             | everything an application runs              |
| `@sincpro/client-framework/core`                        | the application layer alone                 |
| `@sincpro/client-framework/testing`                     | the observability ports in memory           |
| `@sincpro/client-framework/codegen`                     | the generator, as functions                 |
| `./console`, `./opentelemetry`, `./sentry`, `./parquet` | optional entries; a vendor's SDK only there |

## Development

Node 26 (`nvm use`):

```bash
make init
make typecheck
make test
make verify-format      # eslint --fix + prettier + typecheck + doctor; fails on a dirty tree
make build
make codegen-fixtures   # after changing the generator on purpose; read the diff
```

`make doctor` enforces what the compiler does not: self-imports, no platform (React, DOM, Node
outside `codegen/`), a vendor's SDK only in its optional entry, and `domain/` importing only
`domain/`. Tests run in Node, one folder per module; `tests/support/forge-contract/` holds real
contracts and what the generator writes from them, compared byte for byte.

The runtime uses `fetch`, `AbortSignal`, `URL`, `crypto.getRandomValues`, `Proxy`, `WeakMap` and
`BigInt`; React Native must provide URL and random values before ids or transports are used.

Read [`MANIFESTO.md`](MANIFESTO.md) (what this package is and is not), [`AGENTS.md`](AGENTS.md)
(how to change it), [`CONTRIBUTING.md`](CONTRIBUTING.md),
[`docs/UBIQUITOUS_LANGUAGE.md`](docs/UBIQUITOUS_LANGUAGE.md),
[`docs/WEB.md`](docs/WEB.md) and [`docs/MOBILE.md`](docs/MOBILE.md). Versions are written by the release pipeline.

## License

[MIT](LICENSE)
