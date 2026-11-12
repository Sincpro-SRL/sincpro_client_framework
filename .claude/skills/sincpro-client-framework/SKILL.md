---
name: sincpro-client-framework
description: Build a Sincpro web or mobile application — or a platform framework (@sincpro/web-framework, @sincpro/mobile) — on @sincpro/client-framework. Use whenever you add a bounded context, a Command and its Feature or ApplicationService, a domain event and the use cases registered for it, a Command or an event that travels (its messages), a generated Command or event executed on the bus, the queue's Subscriber, a cron, a stored event queue, an adapter for a platform (an EventStore, an OperationTransport, a ContextStore, a Logger engine, a Tracer, an ErrorReporter), the client of a backend's contract, error handling, cancellation, a circuit breaker or observability to a TypeScript client. It explains what the package is, the rule for what goes in it versus in a platform's framework or an app, its vocabulary, how an application is laid out, and the mistakes to avoid. Read it before writing client code.
---

# sincpro-client-framework

The client side of sincpro_framework. **client-framework + web-framework is to a web app what
sincpro_framework is to a backend; client-framework + @sincpro/mobile, the same for a phone.**
It holds the application layer (bounded contexts, Commands, Features, ApplicationServices, domain
events), its execution pipeline (context, trace, logs, outcome, report, error handlers,
interceptors) and the agnostic tools that are hard to get right (what kind of failure an error is,
cancellation, a circuit breaker, stored event delivery, a client over any wire). Everything a
platform must give, it gives through a port.

> Verified against the repository's main branch. A version string alone does not establish an
> API: check the installed `@sincpro/client-framework` before relying on what follows.

## The rule: where does a piece go?

| If…                                                             | It goes in                                                          | Example                                                                           |
| --------------------------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| web and mobile can both use it, and it needs no platform        | **@sincpro/client-framework** — a port, its rules, a memory adapter | `failureOf`, `storedQueue`, `CircuitBreaker`, `OperationTransport`                |
| only one platform needs it, or it needs a platform's technology | **that platform's framework** — an adapter of a port                | a SQLite `EventStore`, an IndexedDB one, a gRPC `OperationTransport`, React hooks |
| it is one application's business                                | **the application** — a bounded context                             | a sale order, a printer flow, the e-invoice key                                   |

Never replicate what differs by nature: mobile's local SQLite domain and web's server-driven entity
screens are different things, not one shared "ORM". Never rewrite an application to use a new
piece; give it the tool and let it adopt it.

## What it is not

- **Not a UI.** No React, no React Native, no DOM: hooks and screens are the platform's.
- **Not a store or a cache.** Where data lives (SQLite, IndexedDB, MMKV) is an adapter of a port.
- **Not a telemetry SDK.** It calls `Tracer`, `ErrorReporter` and `Logger`; the platform plugs them.
- **Not REST-only.** The generated client calls operations by identity; the wire is an adapter.

## Abstractions

| Term                                                                                     | What it is                                                                                                                                                                                           | Import                                        |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `BoundedContext`                                                                         | The bus of one bounded context: dependencies, services, handlers, interceptors, listeners. `execute(new Command(...))`.                                                                              | `@sincpro/client-framework`                   |
| `Command<R>` / `Response`                                                                | Class DTOs. A Command names its Response by type; `execute` infers it.                                                                                                                               | same                                          |
| `DomainEvent`                                                                            | A fact N consumers hear: a use case registered for it, or an event handler. `static eventName` is its wire name.                                                                                     | same                                          |
| `eventName` / a Command's identity                                                       | An event's wire name (`<context>.<aggregate>.vN.<fact>`): required. A Command's: `<context>.<Command>`, given at registration.                                                                       | same                                          |
| `Feature` / `ApplicationService`                                                         | A use case for one DTO or N (`feature([CommandX, EventY])`). Its name is the framework's, taken at registration.                                                                                     | same                                          |
| `servicesWith<Dependencies>()`                                                           | The context's bases: every dependency typed on `this`, declared nowhere else (the backend's `framework.py`).                                                                                         | same                                          |
| `commandOf` / `RemoteEvent` / `RemoteCommand`                                            | A generated Command or event executed on the bus, registered by its `operations.X` / `events.X` entry.                                                                                               | same                                          |
| `commandMessageOf` / `eventMessageOf` / `commandFrom` / `eventFrom`                      | How a Command (by identity, to one bus) and an event (by name, to N) are written and read.                                                                                                           | same                                          |
| `this.context` / `this.span` / `this.logger` / `this.signal` / `this.execution`          | What a run sees: its context, span, bound logger, cancellation, and identity (`correlationId`, `causationId`).                                                                                       | —                                             |
| Error handlers / `expectErrors`                                                          | `addFeatureErrorHandler`, `addAppServiceErrorHandler`, `addGlobalErrorHandler`; expected errors end `refused`.                                                                                       | —                                             |
| `failureOf(error)`                                                                       | What any error is in the backend's words: `kind`, `nextStep`, `retryable`, `retryAfter`, `permanent`, `fault`, `aborted`.                                                                            | `@sincpro/client-framework`                   |
| `kindOfHttpStatus` / `kindOfGrpcCode` / `kindOfJsonRpcCode`                              | The backend's tables, for an adapter to declare `failureKind` on its errors.                                                                                                                         | same                                          |
| `CircuitBreaker` / `guardedTransport`                                                    | The backend's breaker; guard any transport. `CircuitOpen` is `unavailable` with its wait.                                                                                                            | same                                          |
| `OperationTransport`                                                                     | `call(operation, input, options)`: the port a generated client is made over.                                                                                                                         | same                                          |
| `restOperations` / `jsonRpcOperations`                                                   | Adapters for REST (over a `Transport`) and JSON-RPC. gRPC is a platform's.                                                                                                                           | same                                          |
| `Transport`                                                                              | REST's own port (`restTransport`, `memoryTransport`): what `restOperations` and entity screens stand on.                                                                                             | same                                          |
| `Publisher` / `Subscriber`                                                               | Publish from a Feature (bound to its run); the queue's composite entrypoint: its event handlers and the buses added (`addBus`), Commands only declared.                                              | same                                          |
| `EventHandler` / `handlersWith<D>()`                                                     | The entrypoint an event reaches — on a bus (`@bus.handler([...])`: its dependencies and `this.boundedContext`) or on a `Subscriber` (its explicit dependencies). Executes Commands, decides nothing. | same                                          |
| `syncQueue` / `storedQueue` / `EventStore`                                               | In-call delivery; store-and-forward delivery over a store the platform plugs (`memoryEventStore` here).                                                                                              | same                                          |
| `interceptor` / `onStart` / `onCompletion` / `onFailure` / `processListeners` / `extend` | Extension points of the pipeline: control, observation, composition.                                                                                                                                 | `BoundedContext`, `@sincpro/client-framework` |
| `configureProcess` / `configureLogger`                                                   | Plug the tracer, reporter, logger engine, context store and outcome rule once, in `main`.                                                                                                            | same                                          |
| `logger` / `loggerAdapter`                                                               | The only predefined loggers: infrastructure and adapters. The application layer uses `this.logger` and `projectBoundedContext.logger`.                                                               | same                                          |
| `memoryTracer` / `memoryReporter` / `memoryLogger`                                       | The ports in memory, for tests.                                                                                                                                                                      | `@sincpro/client-framework/testing`           |

## How an application is laid out

```text
src/
  entrypoints/main.ts(x)                 configureProcess; the stored queue
  entrypoints/queue/                     the Subscriber (framework.ts) and its own event handlers
  domains/
    common/infrastructure/operations.ts  export const operations — the wire every client uses
    <bounded context>/
      domain/                            local Commands, Responses, DomainEvents, value rules
        generated/                         sincpro-client generate: models, commands, events — never edited
      adapters/                          repositories, printers, other systems — ports' adapters
        generated/                         sincpro-client generate: the client and the entities
      services/                          the use cases, one folder per aggregate or entity
        <aggregate>/                       sale_order/: Features and ApplicationServices of it
          <entity of the aggregate>/       payments/: a related entity with use cases of its own
        index.ts                           imports each service — it registers itself (decorator)
      infrastructure/
        dependencies.ts                    <Context>Dependencies + registerDependencies
        framework.ts                       servicesWith<…>() bases + <context>BoundedContext
      entrypoints/                       the doors — they translate, they decide nothing
        queue/                             the bus's event handlers: an event → its Commands
        cron/                              mobile only — its scheduler, each tick a Command
      index.ts                           export const <context>BoundedContext — ready to execute
```

- **Services by aggregate.** A simple entity is one folder of Features (a CRUD). An aggregate
  holding related entities with use cases of their own (the payments of a sale order) gives each
  a folder inside it, with its Features and ApplicationServices grouped by what they are about.
- **Entrypoints translate.** A screen and a cron build a Command and execute it. What a queue
  carries goes through one `Subscriber` — composite, created once in `entrypoints/queue/` —, which
  delivers each event to its event handlers and to the buses added to it; never one subscriber
  per handler. Several use cases with decisions between them are an ApplicationService.
- **A cron exists only where the platform has a scheduler** — mobile's `CronWorker`. A browser
  has none (a closed tab runs nothing): on the web, refreshing a screen is the screen's (a query's
  refetch interval) and scheduled work is the backend's `Crons`. This package has no cron.
- **Names say what a thing is.** `salesBoundedContext` — never `sales`, `ctx` or `bc`; `context` is
  the run's (`this.context`). A service's name is its class's, taken by the framework when it
  registers it; a production build keeps class names (Metro `keep_classnames`, esbuild/Vite
  `keepNames`).

`sincpro-client scaffold <contract> --out src/domains/<context>` writes the application-owned files
once; `sincpro-client check --root src` enforces the layers (a service never imports an
entrypoint).

## How to

### Start the process (once, in `main`)

```ts
configureProcess({
  identity: { release: "forge-web:1.4.0" }, // who is running (+ tenant): on every span, line, report
  tracer, // web: browserTracer(…); mobile: its OTel or queue tracer
  reporter, // sentryReporter(client) — GlitchTip speaks Sentry
  logger: { mode: production ? "production" : "development" }, // or { engine: lokiLogger }
  context: contextStore, // memoryContexts() by default; MMKV / sessionStorage
});
processContext.set({ tenant_id, company_id });
```

`configureProcess` replaces every port; `configureLogger(...)` changes only logging (a debug switch).

### Reach the backend's services, over any wire

```ts
// domains/common/infrastructure/operations.ts
export const operations = guardedTransport(
  restOperations(restTransport({ base: "/v1", headers: () => session.headers() })),
  new CircuitBreaker("backend"),
);
// or jsonRpcOperations({ endpoint: "/rpc", headers }) — or a platform's gRPC adapter
```

The generated `clientOf(operations)` is injected as a dependency (`addDependency("client", …)`); a
run binds it, so each call carries `traceparent`, `sincpro-context` and the run's signal. Each
method takes the operation's input DTO and answers its answer DTO, as `domain/generated/commands.ts`
types them. A local Command may `implements remote.CommandX` (`import type * as remote`).

### Start a bounded context (as the backend's `dependencies.py` + `framework.py`)

```ts
// infrastructure/dependencies.ts
export interface SalesDependencies {
  client: ReturnType<typeof clientOf>;
}
export function registerDependencies(boundedContext: BoundedContext<SalesDependencies>) {
  boundedContext.addDependency("client", clientOf(operations));
  return boundedContext;
}

// infrastructure/framework.ts
export const { Feature, ApplicationService } = servicesWith<SalesDependencies>();
export const salesBoundedContext = registerDependencies(
  new BoundedContext<SalesDependencies>("sales"),
);
```

`sincpro-client scaffold` writes these once. The instance lives in `framework.ts`, not `index.ts`:
a service imports it to register itself, and ES modules run their imports first.

### Write a use case

```ts
// services/quote/quote.feature.ts
export class CommandQuote extends Command<ResponseTotal> {
  constructor(readonly quantity: number) {
    super();
  }
}

@salesBoundedContext.feature(CommandQuote) // or a list: feature([CommandQuote, OrderPaid])
export class Quote extends Feature<CommandQuote, ResponseTotal> {
  async execute(command: CommandQuote): Promise<ResponseTotal> {
    this.logger.info("Quoting", { quantity: command.quantity });
    const price = await this.client.getPrice({ sku: "A1" }); // the context's, declared nowhere here
    return new ResponseTotal(command.quantity * Number(price.amount));
  }
}

const answer = await salesBoundedContext.execute(new CommandQuote(3), { signal }); // from a screen
```

Keep this shape: `salesBoundedContext.execute(new Command(...))`. A service is a singleton of its generation:
request state goes in the Command or the context, never on `this`; use TypeScript `private`, never
`#private`.

### Decide what a screen does with a failure

```ts
try {
  await salesBoundedContext.execute(command, { signal });
} catch (error) {
  const failure = failureOf(error);
  if (failure.aborted) return; // the screen closed
  if (failure.nextStep === "fix_request") showFields(failure.problem?.errors);
  else if (failure.nextStep === "authenticate") signIn();
  else if (failure.retryable) retryAfter(failure.retryAfter);
  else show(failure.problem?.detail);
}
```

Errors a bounded context answers itself go in its handlers; a local refusal declares its kind:
`class IssueClosed extends Error { static readonly failureKind = "domain"; }` — it ends `refused`
and is never reported.

### Publish and subscribe to events

```ts
class OrderPaid extends DomainEvent {
  static readonly eventName = "shop.order.v1.paid";
  static fromJSON(values: { order_id: string; total: { amount: string; currency: string } }) {
    return new OrderPaid(
      values.order_id,
      new Money(values.total.amount, values.total.currency),
    );
  }
  constructor(
    readonly order_id: string,
    readonly total: Money,
  ) {
    super();
  }
}

// 1. A use case whose input is the event — one per bounded context:
@mailBoundedContext.feature(OrderPaid)
export class SendReceipt extends Feature<OrderPaid, void> { … }

// 2. An event handler of a bus — a layer above its use cases; N events; it decides nothing:
export const { Feature, ApplicationService, EventHandler } = servicesWith<StockDependencies>();
@stockBoundedContext.handler([OrderPaid, OrderCancelled])
export class OnOrderChanged extends EventHandler<OrderPaid | OrderCancelled> {
  async handle(event: OrderPaid | OrderCancelled) {
    await this.boundedContext.execute(new CommandRecount(event.order_id)); // its own bus
  }
}

// A use case a screen executes AND the event triggers: one service, N DTOs
@stockBoundedContext.feature([CommandReleaseReservation, OrderPaid])
export class ReleaseReservation extends Feature<CommandReleaseReservation | OrderPaid, void> { … }

// A backend's event, generated: registered by its entry, received as its data
@stockBoundedContext.feature(events.OrderShipped)
export class Ship extends Feature<remote.OrderShipped, void> { … }

// 3. The queue's ONE entrypoint — entrypoints/queue/framework.ts, created once:
export const { EventHandler: AppHandler } = handlersWith<AppSubscriberDependencies>();
export const appSubscriber = new Subscriber<AppSubscriberDependencies>("app", {
  commands: [CommandReleaseReservation], // Commands consumed from the queue: only declared
});
appSubscriber.addDependency("invoicingBoundedContext", invoicingBoundedContext); // to call it
appSubscriber.addBus(mailBoundedContext); // to deliver to its use cases and handlers
appSubscriber.addBus(stockBoundedContext);

@appSubscriber.handler([OrderPaid]) // or appSubscriber.handler([OrderPaid])(Invoice)
export class Invoice extends AppHandler<OrderPaid> {
  async handle(event: OrderPaid) {
    await this.invoicingBoundedContext.execute(new CommandIssueInvoice(event.order_id));
  }
}

const queue = storedQueue({ store, subscriber: appSubscriber, ready, onSettled });
shopBoundedContext.addDependency("publisher", new Publisher(queue)); // a Feature: this.publisher.publish(…)
// a socket, a push, another tab: await subscriber.receive(message)
```

- `syncQueue(subscriber)` delivers in the call; `storedQueue` stores first, then delivers in order,
  retries what may succeed, sets aside what never will (`state: "set_aside"`), and stops after
  `maxAttempts`.
- **Messages are the backend's: CloudEvents 1.0**, for Commands and events alike — `type` is the
  event's name or the Command's identity; an event goes to N buses, a Command to one and only when
  the Subscriber declared it (`CommandNotConsumed` otherwise). `subscriber.receive(message)` takes
  one structured or in binary mode (`{ headers, body }`, `ce_` headers). Its `correlationid` and
  `traceparent` continue: the run is a child of the backend's trace.
- Every consumer is acknowledged apart — `mail` (its use case), `stock/OnOrderChanged`,
  `app/Invoice` —: a retry runs only the one that failed. `addDependency("x", value)` injects
  (a bus to call is a dependency); `addBus(bus)` delivers to it, by its namespace — the same bus
  again changes nothing, another of the same name is delivered to too (`stock#2`).
- Delivery is **at least once**: the use case keys its effect by `this.execution.causationId` (the
  message's id) or by the entity the event names.
- An event carrying `Money`, `Decimal` or dates declares `static fromJSON`.
- One process drains a store; call `queue.drain()` when the app returns to the foreground or the
  network comes back.

### Extend the pipeline without touching services

```ts
salesBoundedContext.interceptor(CommandPay)((command, next, run) => {
  guard(command);
  return next(command);
});
salesBoundedContext.onFailure((failed) => toast(failed.execution?.useCase));
processListeners.onStart((started) => activity.running(started.execution.useCase));
salesBoundedContext.feature(CommandPrint, { replaces: Print })(PrintOnBixolon);
salesBoundedContext.extend(auditing); // a module's pieces in one place
```

### Write a platform's adapter (the ports)

| Port                       | Contract                                                                                                                                                                                                                                   | Written by                           |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------ |
| `EventStore`               | `add(stored)`, `next(skip)` — oldest `pending` not skipped —, `save(stored)` by envelope id. Keep records; never decide.                                                                                                                   | mobile (SQLite), web (IndexedDB)     |
| `OperationTransport`       | `call(operation, input, options)`: read `operation.<wire>`; none → `OperationNotPublished`; put `options.headers` in the request/metadata; honour `options.signal`; fail with a `Problem` or a declared `failureKind` (`kindOfGrpcCode`…). | a platform for gRPC; another backend |
| `ContextStore`             | synchronous `load`, `save`, `delete`, `version`; optional `watch`. A new version on every change.                                                                                                                                          | each platform                        |
| `Logger`                   | `log(record)`; never throws into the use case; owns its filtering and delivery.                                                                                                                                                            | Loki, a queue                        |
| `Tracer` / `ErrorReporter` | wrap what the platform built (`openTelemetryTracer`, `sentryReporter`); register nothing global.                                                                                                                                           | each platform                        |

### Test

Use the ports in memory: `configureProcess({ tracer: memoryTracer(), reporter: memoryReporter(), logger: { engine: memoryLogger() } })`
in `beforeEach`; `restOperations(memoryTransport(tables))` or a fake `OperationTransport` for the
backend; `memoryEventStore()` with `await queue.drain()` for events.

## Mistakes to avoid

- **Importing a platform into a bounded context's domain or services.** React, SQLite, NetInfo
  belong to adapters and entrypoints.
- **A logger per application layer.** Use `this.logger` (bound to the run) and `projectBoundedContext.logger`;
  only `logger` and `loggerAdapter` are predefined.
- **Catching in a Feature to hide a failure.** Declare the kind, or answer in an error handler.
- **Writing routes or RPC method names by hand.** They are the contract's bindings; regenerate.
- **A circuit breaker inside a Feature.** Put it on the transport or the adapter (`guardedTransport`).
- **Assuming an event runs once.** Key effects by the envelope's id (`this.execution.causationId`
  in the use case that received it) or by the entity's own id.
- **A subscriber per handler, or a dependency declared in a Feature.** The queue has one
  `Subscriber`; handlers register on it or on their bus. A service inherits its context's
  dependencies (`servicesWith`) and its name is taken at registration — a Feature declares neither.
- **Logic in an event handler.** It is an entrypoint: it executes Commands; the decision is a
  Feature's, the workflow an ApplicationService's.
- **Logic in a cron.** It is an entrypoint: build the Command, execute it. A
  workflow is an ApplicationService; a decision is a Feature.
- **Abbreviating a bounded context** (`ctx`, `bc`) or naming it like an entity (`sales`). Write
  `salesBoundedContext`.
- **Constructing and calling a service directly.** Everything goes through `execute` or
  `featureBus.execute`, or it is neither traced nor reported.
- **Two copies of the package.** A platform framework declares `@sincpro/client-framework` as a
  `peerDependency`; with two copies the process ports split silently.
- **Number for money, Date for a day.** Use `Decimal`, `Money`, and days as text (`isDay`, `dayOf`).

## Checklist before handing a change back

- [ ] Does the piece belong here, in the platform's framework, or in the application (the rule)?
- [ ] Every use case is registered (a decorator) for its DTOs and executed through its bounded context; no `serviceName`, no declared dependency.
- [ ] Failures declare or carry their kind; screens decide with `failureOf`.
- [ ] Events: `eventName`, `fromJSON` when they carry values, idempotent consumers. Handlers on
      their bus or on the one `Subscriber`, never logic in them. Commands that travel get their
      identity at registration. Crons only translate into Commands.
- [ ] Services grouped by aggregate, a related entity's use cases in its own folder inside it.
- [ ] The wire is injected (`operations`), never written into the code.
- [ ] Tests run on the memory ports, in Node.
