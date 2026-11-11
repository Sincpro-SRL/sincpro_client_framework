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

Laid out as a backend's context (`sincpro_mcp_odoo/domains/helpdesk`): what its services count on
(`dependencies.ts`), its bases and its instance (`framework.ts`), and one file per use case.

```ts
// domains/sales/infrastructure/dependencies.ts — the backend's DependencyContextType
export interface SalesDependencies {
  prices: PriceList;
  taxRate: number;
}
export function registerDependencies(boundedContext: BoundedContext<SalesDependencies>) {
  boundedContext.addDependency("prices", new PriceList());
  boundedContext.addDependency("taxRate", 0.13);
  return boundedContext;
}

// domains/sales/infrastructure/framework.ts — the bases inherit every dependency, typed
export const { Feature, ApplicationService } = servicesWith<SalesDependencies>();
export const salesBoundedContext = registerDependencies(
  new BoundedContext<SalesDependencies>("sales"),
);

// domains/sales/services/quote/total.feature.ts
export class CommandTotal extends Command<ResponseTotal> {
  constructor(
    readonly sku: string,
    readonly quantity: number,
  ) {
    super();
  }
}

@salesBoundedContext.feature(CommandTotal)
export class Total extends Feature<CommandTotal, ResponseTotal> {
  execute(command: CommandTotal): ResponseTotal {
    this.logger.info("Totalling", { quantity: command.quantity });
    const unit = this.prices.of(command.sku) * (1 + this.taxRate); // declared nowhere else
    return new ResponseTotal(unit * command.quantity);
  }
}

// domains/sales/services/quote/quote.app-service.ts
@salesBoundedContext.appService(CommandQuote)
export class Quote extends ApplicationService<CommandQuote, ResponseTotal> {
  execute(command: CommandQuote): Promise<ResponseTotal> {
    return this.featureBus.execute(new CommandTotal(command.sku, command.quantity));
  }
}

const answer = await salesBoundedContext.execute(new CommandQuote("a1", 3)); // ResponseTotal
```

A Command names, by its type, the Response it answers: `execute` infers it, with no second
argument (the backend's `bus(dto, ResponseType)` is accepted too, and checked in TypeScript
only). A Response may be a class, a plain object, a page, a primitive or `void`.

- **Dependencies are the context's, never a service's.** `servicesWith<SalesDependencies>()` gives
  the bases every dependency typed on `this` — the backend's `class Feature(_Feature,
DependencyContextType)` —; `addDependency` supplies them, and reading one never supplied fails.
  A replacement names what it replaces: `addDependency(name, next, { replaces: previous })`.
- **The framework names a service when it registers it**: its class, as the code wrote it — a
  standard decorator hands the name over before any minifier runs —, else the class's `name`. A
  production build keeps class names (`keep_classnames` in Metro's minifier, `keepNames` in
  esbuild and Vite). Nothing on the class declares it.
- **One service, N DTOs.** `feature([CommandX, EventY])` registers one service for each, as the
  backend's `DTORegistration`; a DTO still has one service, across both layers, dispatched by
  its exact class — or, generated, by its identity.
- **A service is a singleton of its generation**, one instance whatever the number of DTOs it
  takes. What belongs to one request goes in the Command or the context, never on `this`. Use
  TypeScript `private`, not `#private`: a run sees the instance through a view of its own.
- **Generations.** The first call (or `buildRootBus()`) builds one; what is registered later
  answers from the next call, and a running call keeps its own. `fresh()` copies the
  registrations; `scoped({ company_id: 2 })` runs with more context and the same instances.
- **Composition.** An ApplicationService runs its context's Features through `this.featureBus`,
  as children of its own execution; never another ApplicationService. A bounded context injected
  into another's services (the backend's `common_mcp`) is bound to the run: what it executes is
  a child of it.

### Registering: a decorator, or a call

The same functions work as standard decorators, as legacy ones (`experimentalDecorators`), and
called: `salesBoundedContext.feature(CommandTotal)(Total)`. No DI library and no
`reflect-metadata`. The tests compile both decorator forms with TypeScript; a bundler's transform
(Vite, Metro/Babel) is each application's to configure and test. A service registers itself
where it is written; `services/index.ts` imports each file, so all are registered before anyone
executes.

### Replacing a service

An application takes the place of a service a module registered, as the backend's `replaces=`:

```ts
@printingBoundedContext.feature(CommandPrint, { replaces: Print })
class PrintOnBixolon extends Print {
  override execute(command: CommandPrint) { … }
}
printingBoundedContext.handlerOf(CommandPrint); // PrintOnBixolon
```

`replaces` names the service registered now for each DTO listed, or the registration is
refused — all of them or none. The next call answers with the new one; its spans say which it
replaced (`sincpro.replaces`). A dependency is replaced the same way.

## Commands and events: two DTOs that travel differently

|                      | A Command                                                                                                              | An event                                                                           |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Is                   | a request to **one** bus                                                                                               | a fact **N** buses hear                                                            |
| Known on the wire by | its identity, `<context>.<Command>` — given by the bounded context that registers it (the backend's `registered_name`) | its wire name, `static eventName = "billing.invoice.v1.issued"` — required, dotted |
| Travels as           | CloudEvents 1.0, `type` = its identity                                                                                 | CloudEvents 1.0, `type` = its name; `data` repeats `name`                          |
| Written / read with  | `commandMessageOf(command, cause?)` / `commandFrom(type, data)`                                                        | `eventMessageOf(event, envelope)` / `eventFrom(type, data)`                        |

Both travel as the backend writes them on every queue — CloudEvents 1.0: `id`, `source`, `type`,
`time`, `correlationid`, `causationid`, `traceparent`, and the DTO's JSON as `data` —; what differs
is the route. `readMessage` reads one structured, or in a broker's binary mode (the attributes as
`ce_`, `ce-` or `cloudEvents:` headers, the type falling back to `sincpro-event`), as the backend's
`Envelope.of`. A delivered message continues its flow and its trace: the run's span is a child of
its `traceparent`. An event's name is declared — the contract other processes read, with its
version; a Command's identity is the framework's, the one a generated contract's `operations`
carry (`static commandName` fixes another). A value that is not JSON (`Money`, `Decimal`, a day)
comes back as such through the class's `static fromJSON`.

```ts
class InvoiceIssued extends DomainEvent {
  static readonly eventName = "billing.invoice.v1.issued";
  static fromJSON(values: {
    invoice_id: string;
    total: { amount: string; currency: string };
  }) {
    return new InvoiceIssued(
      values.invoice_id,
      new Money(values.total.amount, values.total.currency),
    );
  }
  constructor(
    readonly invoice_id: string,
    readonly total: Money,
  ) {
    super();
  }
}
```

`event.name` reads `eventName`; `name` is reserved, and a subclass cannot make it a field.

### What the generator writes is recognized on the bus

A contract's Commands and events are generated as types and data, never classes. The bus takes
their entries — `operations.X` (an identity), `events.X` (a wire name) — as what a service is
registered for, and executes them as data:

```ts
import { events, operations } from "../generated/client";
import type * as remote from "../generated/domain";

@projectBoundedContext.feature([events.IssueClosed, operations.CommandArchiveIssue])
class Archive extends Feature<remote.IssueClosed | RemoteCommand<remote.CommandArchiveIssue>, void> {
  execute(input: remote.IssueClosed | RemoteCommand<remote.CommandArchiveIssue>) { … }
}

await projectBoundedContext.execute(issueClosed); // the event's data: its `name` says which
await projectBoundedContext.execute(commandOf(operations.CommandArchiveIssue, { issue_id }));
```

`commandOf` tags the input with the operation's identity — never serialized with its data.

## Domain events

Registering a use case for an event **is** the subscription — the backend's
`@accounting.feature(InvoiceIssued)`. Several bounded contexts may register it; each hears it once.

```ts
@accountingBoundedContext.feature(InvoiceIssued)
class Book extends Feature<InvoiceIssued, void> { … }

@billingBoundedContext.feature([CommandIssueInvoice, OrderPaid]) // a screen, or the event
class IssueInvoice extends Feature<CommandIssueInvoice | OrderPaid, ResponseInvoice> { … }
```

A use case of an event runs through the same pipeline (span `<context>/<Service>` with
`sincpro.event`, log lines, error handlers, report). An ApplicationService may take the event and
compose Features; `execute(event)` answers whatever its use case returns (`unknown`).

### The Subscriber: the queue's entrypoint, composite

One per queue — the backend's `Subscriber(*buses)` and `QueueGateway`, never one per handler.
It pulls what the queue delivers, rebuilds it (an event by its name, a Command by its identity)
and hands it to every consumer subscribed to it. An event has three kinds of consumers, all
registered the same way, with or without a decorator:

| Consumer                         | Registered with                              | It finds on `this`                               | Acknowledged as       |
| -------------------------------- | -------------------------------------------- | ------------------------------------------------ | --------------------- |
| a use case of a bus              | `@salesBoundedContext.feature([Cmd, Evt])`   | the bus's dependencies                           | `sales`               |
| an event handler of a bus        | `@salesBoundedContext.handler([EvtA, EvtB])` | the bus's dependencies and `this.boundedContext` | `sales/OnSaleChanged` |
| an event handler of a subscriber | `@appSubscriber.handler([EvtA])`             | the subscriber's dependencies                    | `app/NotifySalePaid`  |

```ts
// entrypoints/queue/framework.ts — once, like a bounded context's framework.ts
export const { EventHandler } = handlersWith<AppSubscriberDependencies>();
export const appSubscriber = new Subscriber<AppSubscriberDependencies>("app", {
  commands: [CommandIssueInvoice], // consumed from the queue: only when declared
});
appSubscriber.addDependency("invoicingBoundedContext", invoicingBoundedContext); // to call it
appSubscriber.addDependency("notifier", notifier);
appSubscriber.addBus(salesBoundedContext); // to deliver to its use cases and handlers

// entrypoints/queue/sale_paid.handler.ts — events → handler; it decides nothing
@appSubscriber.handler([SalePaid, SaleCancelled])
export class NotifySaleChanged extends EventHandler<SalePaid | SaleCancelled> {
  async handle(event: SalePaid | SaleCancelled) {
    await this.invoicingBoundedContext.execute(new CommandIssueInvoice(event.saleId));
  }
}
appSubscriber.handler([InvoiceVoided])(OnInvoiceVoided); // the same, without a decorator

// services/sale/on_sale_changed.handler.ts — a handler of the bus: a layer above its use cases
export const { Feature, ApplicationService, EventHandler } =
  servicesWith<SalesDependencies>();
@salesBoundedContext.handler([SalePaid])
export class OnSalePaid extends EventHandler<SalePaid> {
  async handle(event: SalePaid) {
    await this.boundedContext.execute(new CommandCloseSale(event.saleId)); // its own bus
  }
}

const queue = storedQueue({ store, subscriber: appSubscriber });
await appSubscriber.receive(message); // CloudEvents, structured or { headers, body }
```

- **Two levels, never mixed.** `addDependency("x", value)` is what its handlers find on `this` —
  a bus they call is a dependency like any other —; `addBus(bus)`, with no name to write (the
  bus's own namespace), is a bus it delivers to. The same bus added again changes nothing;
  another bus of the same name is delivered to as well, under its own key (`sales#2`).
- **An event** reaches every consumer subscribed to it — the subscriber's handlers, then each bus
  in the order added (its use case, then its handlers); one that fails does not stop the others,
  and each is acknowledged under its key — which a stored queue keeps, so a redelivery runs only
  the ones that do not have it yet.
- **A handler** runs in the pipeline of a use case, in its own layer (`event_handler`): its span
  `<owner>/<Handler>`, `this.logger`, `this.execution.causationId` (the message's id), and what it
  executes is its child. A handler takes N events: its type is their union, and TypeScript checks
  it accepts every event listed.
- **A Command** is executed by the one bounded context that registered it, continuing the
  message's flow — **only when declared** (`commands`). A bus never hands all its Commands to
  whoever can publish on a queue: an undeclared one fails `CommandNotConsumed`
  (`permission_denied`).
- `new Subscriber(...boundedContexts)` and `new Subscriber({ boundedContexts, events, commands })`
  still build one that delivers to those buses only.

### Publishing

```ts
const queue = syncQueue(new Subscriber(mailBoundedContext, stockBoundedContext)); // or storedQueue
shopBoundedContext.addDependency("publisher", new Publisher(queue));

@shopBoundedContext.feature(CommandPay)
class Pay extends Feature<CommandPay, string> {
  async execute(command: CommandPay) {
    await this.publisher.publish(new OrderPaid(command.order_id)); // its Envelope
    return command.order_id;
  }
}
```

The `Publisher` is bound to the run that holds it, so the event joins that run's flow: its
envelope carries the run's `correlationId` and names the run as its cause, and every use case
that hears it continues that flow.

What is defined here, and what each platform plugs behind the ports:

| Piece             | Here                                                           | The platform's                         |
| ----------------- | -------------------------------------------------------------- | -------------------------------------- |
| `DomainEvent`     | the class, its `eventName`, its messages                       | —                                      |
| `Command`         | its identity (given at registration), its messages             | —                                      |
| `Envelope`        | `name`, `id`, `correlationId`, `causationId`, `publishedAt`    | storing it beside the event            |
| `EventQueue` port | `syncQueue` (in the call); `storedQueue` (store, then deliver) | a broker's queue, `BroadcastChannel`   |
| `EventStore` port | `memoryEventStore()`                                           | mobile: a SQLite table; web: IndexedDB |
| `Subscriber`      | pull, rebuild, deliver to every consumer; Commands declared    | where messages come from (a socket)    |

### Stored events: one way to carry them, any store

```ts
const queue = storedQueue({
  store: sqliteEventStore(db), // the platform's EventStore; memoryEventStore() in a tab or a test
  subscriber: new Subscriber(
    salesBoundedContext,
    stockBoundedContext,
    printingBoundedContext,
  ),
  ready: (stored) => connectivity.online || !needsNetwork(stored.envelope.name),
  onSettled: (stored) => activity.show(stored.envelope.name, stored.state),
});
shopBoundedContext.addDependency("publisher", new Publisher(queue));
connectivity.onBack(() => queue.drain()); // and on coming back to the foreground
```

`publish` returns once the event is stored. Then the queue delivers what waits, one at a time,
in the order stored — the backend's store-and-forward, over whatever store the platform plugs:

- It is rebuilt as its class — `static fromJSON` when it has one — and executed by everyone who
  hears it and does not have it yet: a retry never runs one twice.
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
  saved it runs it there again. What must not act twice keys what it does by the message's id —
  `this.execution.causationId` in the use case that received it — or by what the event names
  (the entity's own id).
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
shopBoundedContext.interceptor(CommandPay)(async (command, next, run) => {
  if (!credit.allows(command.customer_id)) throw new NoCredit();
  return next(command);
});
shopBoundedContext.interceptor()((executable, next, run) => next(executable)); // every class

// observation: never changes the answer
shopBoundedContext.onStart((started) => activity.running(started.execution.useCase));
shopBoundedContext.onCompletion(
  (done) => activity.succeeded(done.execution.useCase),
  CommandPay,
);
shopBoundedContext.onFailure((failed) =>
  activity.failed(failed.execution?.useCase, failed.outcome),
);

// composition: a module or plugin wires its pieces in one place
shopBoundedContext.extend(auditing);
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
salesBoundedContext.addFeatureErrorHandler((error) => {
  if (error instanceof PriceNotFound) return new ResponseTotal(0); // the answer
  throw error; // the next handler, or the caller
});
salesBoundedContext.addAppServiceErrorHandler(toBusinessError);
salesBoundedContext.addGlobalErrorHandler(toProblem); // what reaches salesBoundedContext.execute or a scope

salesBoundedContext.expectErrors(QuoteExpired); // the business answering: `refused`, never reported
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
const answer = salesBoundedContext.execute(new CommandQuote(3), { signal: screen.signal });
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

Every execution opens a span `<bounded context>/<Service>`; an ApplicationService's Features
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
salesBoundedContext.logger.info("Catalog preloaded"); // a bounded context, outside a use case
this.logger.info("Totalling"); // inside a Feature or ApplicationService
```

| Logger                       | Layer                 | Each line carries                              |
| ---------------------------- | --------------------- | ---------------------------------------------- |
| `logger`                     | `infrastructure`      | —                                              |
| `loggerAdapter`              | `adapter`             | the run, when injected as a dependency         |
| `salesBoundedContext.logger` | `bounded_context`     | its bounded context                            |
| `this.logger`, Feature       | `feature`             | bounded context, use case, execution and trace |
| `this.logger`, AppService    | `application_service` | the same                                       |

`this.logger` keeps its run across awaits and concurrent calls, without a global stack. An
adapter that imports `loggerAdapter` at module level writes without the run; inject it
(`salesBoundedContext.addDependency("log", loggerAdapter)`) or pass `this.logger` when a line must carry it.

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
salesBoundedContext.context.set({ warehouse_id: 4 });
await salesBoundedContext.scoped({ company_id: 2 }).execute(new CommandQuote(1));
```

Where the values live is a port (`ContextStore`): synchronous reads, a version per change and an
optional `watch`. `memoryContexts()` is the default; a browser, a phone or a server render plugs
its own. `values` is the same object until it changes, so a screen can hand it to React's
`useSyncExternalStore`.

## Talking to a server

A remote service is reached through a port. The generated client never names a wire: it says
which operation, with what input, and the adapter the application injects decides how it
travels.

```ts
import { clientOf } from "./generated/client";

// pick the wire; the client, the Features and the tests stay the same
const forge = clientOf(restOperations(restTransport({ base: "/v1", headers: session })));
// or clientOf(jsonRpcOperations({ endpoint: "/rpc", headers: session }))
// or clientOf(grpcOperations(channel)) — a platform's adapter, the same port

await forge.sendIssue({ issue_id: "acme-3", message: "hola" }); // ResponseSendIssue
```

| Piece                             | What it does                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------------- |
| `OperationTransport` port         | `call(operation, input, options)`: an operation by who it is, over any wire           |
| `restOperations(transport)`       | over REST: the path from the input's fields, a Query's query, a Command's body        |
| `jsonRpcOperations({ endpoint })` | over JSON-RPC 2.0: one `POST`, the operation's method, its input as named params      |
| `restTransport({ base })`         | REST over `fetch`: `Idempotency-Key`, the server's `Problem`, model versions, Parquet |
| `memoryTransport(tables)`         | the same REST contract in memory, copying by the wire's rules — for tests and demos   |
| `entity(key, routes)`             | a model's routes and Commands, typed — what a generated `entities.ts` declares        |
| `retryKeys()`                     | one `Idempotency-Key` per gesture, kept while a retry may repeat it                   |
| `guardedTransport(t, breaker)`    | every call of a transport through a circuit breaker                                   |
| `screensTransport(transport)`     | screen reads and writes run as use cases of `screens`: traced and reported            |
| `parquetDecoder` (`./parquet`)    | large pages read as Parquet through the same transport                                |

Inside a Feature, inject the generated client as it is: the run binds it, so every call carries
its trace (`traceparent`), its context (`sincpro-context`) and its signal — as headers over HTTP,
as metadata where a platform's adapter puts them. `screensTransport` and `entity()` stay on the
REST `Transport`: they are how a screen reads pages of an entity, with its model and its drafts.

### Writing an adapter for another wire

An adapter is one function: read the operation's binding for its wire, send the input, answer the
answer, and fail with errors `failureOf` reads.

```ts
function grpcOperations(channel: Channel): OperationTransport {
  return {
    async call(operation, input, options) {
      const method = operation.grpc?.method;
      if (!method) throw new OperationNotPublished(operation.identity, "gRPC");
      try {
        return await channel.unary(method, input, {
          metadata: options?.headers, // traceparent, sincpro-context
          signal: options?.signal,
        });
      } catch (error) {
        const code = (error as { code: number }).code;
        throw Object.assign(error as Error, { failureKind: kindOfGrpcCode(code) });
      }
    },
  };
}
```

Every operation in `operations` carries its identity and each wire's binding (`rest`, `rpc`,
`grpc`, `mcp`); an operation the adapter's wire does not publish is `OperationNotPublished`
(`not_found`), never guessed.

## Generated code

```bash
python -m sincpro_framework.entrypoints export-client-contract app.http:gateways contracts [--events]
sincpro-client generate contracts/project.contract.json --out src/domains/project/generated --domain project
sincpro-client scaffold contracts/project.contract.json --out src/domains/project
sincpro-client check --root src
```

`generate` writes, from the contract the backend exports — never edited, written again whole:

| File          | What                                                                                          |
| ------------- | --------------------------------------------------------------------------------------------- |
| `domain.ts`   | a type per model, per `<Name>Input`, per operation's input and answer, per domain event       |
| `client.ts`   | `clientOf(operations)`: a method per operation, over any wire; `operations` and `events` data |
| `entities.ts` | each entity's list, record, edit, export, Commands and history, for screens                   |

Each method takes the operation's input and answers its answer, as `domain.ts` types them — a
search answers its `Response…` with its records and cursor, as the backend's callers get it, on
every wire. `scaffold` writes, once, the application's own files: its dependencies (the client
over the `operations` the application exports — `--operations <module>` —), its `framework.ts`
(the service bases with every dependency typed, and the instance) and `services/index.ts`. `check`
enforces the application's layers and bounded-context
boundaries.

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

## An application's layout

An application is laid out as a sincpro_framework service is — the entrypoints call the bus, the
bus runs the use cases, the use cases use the adapters:

```text
src/
  entrypoints/main.ts(x)               configureProcess, the stored queue and its Subscriber
  domains/
    common/infrastructure/operations.ts  export const operations — the wire every client uses
    <bounded context>/
      generated/                       sincpro-client generate — never edited
      domain/                          local Commands, Responses, DomainEvents, value rules
      adapters/                        repositories, printers, other systems
      services/                        the use cases, one folder per aggregate or entity
        <aggregate>/                     sale_order/: its Features and ApplicationServices
          confirm-quotation.feature.ts
          <entity of the aggregate>/     payments/: a related entity with use cases of its own
            register-payment.feature.ts
            reconcile-payments.app-service.ts
        index.ts                         imports each service: it registers itself (a decorator)
      infrastructure/
        dependencies.ts                  <Context>Dependencies and registerDependencies
        framework.ts                     servicesWith<…>() bases, and <context>BoundedContext
      entrypoints/                     the doors: they translate, they decide nothing
        cron/                            mobile only — its scheduler: tick → Command → bus
      index.ts                         <context>BoundedContext, ready to execute
```

- **Services by aggregate.** A simple entity is one folder with its Features (a CRUD). When an
  aggregate holds related entities with use cases of their own — the payments of a sale order —,
  they get a folder inside it, and its Features and ApplicationServices live there, grouped by
  what they are about.
- **Entrypoints translate.** A screen and a cron build a Command and execute it; what a queue
  carries goes through the one `Subscriber` (`entrypoints/main.ts`). A workflow of several use
  cases is an ApplicationService. `sincpro-client check` refuses a service that imports an
  entrypoint.
- **A cron is a platform's door, and only where the platform has a scheduler.** A phone wakes a
  closed app on a schedule (mobile's `CronWorker`); a browser does not — Periodic Background Sync
  is Chromium-only, for an installed PWA, and the browser decides when. On the web, refreshing
  what a screen shows is the screen's (a query's refetch interval), not a cron, and work on a
  schedule is the backend's (`Crons`). This package has no cron: the day web needs one, its
  registry and a `Scheduler` port come here.
- **A bounded context is named for what it is**: `salesBoundedContext`, never `sales` (an
  entity?) or `ctx` — `context` is already the run's (`this.context`).

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
    domain/          OperationTransport, RemoteOperation, Transport, TransportError, entity(),
                     the client contract
    adapters/        restOperations, jsonRpcOperations, rest, memory, parquet (optional entry)
    services/        discovery, retry keys, propagation of trace, context and signal,
                     guardedTransport
  model/           defineMeta, metaFromSchema, metaStore
  core/
    domain/          Command, DomainEvent, Response, Feature, ApplicationService, FeatureBus,
                     ErrorHandler, the pipeline's extension points
    services/        the execution pipeline, interceptors, dependency binding, the handler chain
    entrypoint/      BoundedContext, screensTransport
    infrastructure/  configureProcess, configureLogger, processListeners
  event_driven/
    domain/          Envelope, the messages (an event's, a Command's), the EventQueue,
                     Subscribes and EventStore ports
    services/        writing and reading messages
    adapters/        syncQueue, storedQueue, memoryEventStore
    entrypoint/      Publisher, Subscriber (the queue's composite entrypoint)
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

## For consumers: the skill

[`.claude/skills/sincpro-client-framework/SKILL.md`](.claude/skills/sincpro-client-framework/SKILL.md)
is the guide for whoever builds on this package — an application, @sincpro/web-framework,
@sincpro/mobile — and for the agents that help them: the rule for what goes here, in a platform's
framework or in an application; the vocabulary; how an application is laid out; how to start the
process, reach the services over any wire, write a use case, decide what a screen does with a
failure, publish and subscribe to events, extend the pipeline, write a platform's adapter for each
port, and test; and the mistakes to avoid. It follows the format of sincpro_framework's skills, so
the shared knowledge base can carry it beside them.

## License

[MIT](LICENSE)
