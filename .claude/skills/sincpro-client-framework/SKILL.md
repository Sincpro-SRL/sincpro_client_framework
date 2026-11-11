---
name: sincpro-client-framework
description: Build a Sincpro web or mobile application — or a platform framework (@sincpro/web-framework, @sincpro/mobile) — on @sincpro/client-framework. Use whenever you add a bounded context, a Command and its Feature or ApplicationService, a domain event and its subscriber, a stored event queue, an adapter for a platform (an EventStore, an OperationTransport, a ContextStore, a Logger engine, a Tracer, an ErrorReporter), the client of a backend's contract, error handling, cancellation, a circuit breaker or observability to a TypeScript client. It explains what the package is, the rule for what goes in it versus in a platform's framework or an app, its vocabulary, how an application is laid out, and the mistakes to avoid. Read it before writing client code.
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

| Term                                                                                     | What it is                                                                                                                | Import                                        |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `BoundedContext`                                                                         | The bus of one bounded context: dependencies, services, handlers, interceptors, listeners. `execute(new Command(...))`.   | `@sincpro/client-framework`                   |
| `Command<R>` / `Response`                                                                | Class DTOs. A Command names its Response by type; `execute` infers it.                                                    | same                                          |
| `DomainEvent`                                                                            | A fact; executed by its subscriber like a Command. `static eventName` is its wire name; `event.name` reads it.            | same                                          |
| `Feature` / `ApplicationService`                                                         | A use case; an AppService composes Features through `this.featureBus`. `static serviceName` is required.                  | same                                          |
| `this.context` / `this.span` / `this.logger` / `this.signal` / `this.execution`          | What a run sees: its context, span, bound logger, cancellation, and identity (`correlationId`, `causationId`).            | —                                             |
| Error handlers / `expectErrors`                                                          | `addFeatureErrorHandler`, `addAppServiceErrorHandler`, `addGlobalErrorHandler`; expected errors end `refused`.            | —                                             |
| `failureOf(error)`                                                                       | What any error is in the backend's words: `kind`, `nextStep`, `retryable`, `retryAfter`, `permanent`, `fault`, `aborted`. | `@sincpro/client-framework`                   |
| `kindOfHttpStatus` / `kindOfGrpcCode` / `kindOfJsonRpcCode`                              | The backend's tables, for an adapter to declare `failureKind` on its errors.                                              | same                                          |
| `CircuitBreaker` / `guardedTransport`                                                    | The backend's breaker; guard any transport. `CircuitOpen` is `unavailable` with its wait.                                 | same                                          |
| `OperationTransport`                                                                     | `call(operation, input, options)`: the port a generated client is made over.                                              | same                                          |
| `restOperations` / `jsonRpcOperations`                                                   | Adapters for REST (over a `Transport`) and JSON-RPC. gRPC is a platform's.                                                | same                                          |
| `Transport`                                                                              | REST's own port (`restTransport`, `memoryTransport`): what `restOperations` and entity screens stand on.                  | same                                          |
| `Publisher` / `Subscriber`                                                               | Publish from a Feature (bound to its run); execute an event in every bounded context that hears it.                       | same                                          |
| `syncQueue` / `storedQueue` / `EventStore`                                               | In-call delivery; store-and-forward delivery over a store the platform plugs (`memoryEventStore` here).                   | same                                          |
| `interceptor` / `onStart` / `onCompletion` / `onFailure` / `processListeners` / `extend` | Extension points of the pipeline: control, observation, composition.                                                      | `BoundedContext`, `@sincpro/client-framework` |
| `configureProcess` / `configureLogger`                                                   | Plug the tracer, reporter, logger engine, context store and outcome rule once, in `main`.                                 | same                                          |
| `logger` / `loggerAdapter`                                                               | The only predefined loggers: infrastructure and adapters. The application layer uses `this.logger` and `project.logger`.  | same                                          |
| `memoryTracer` / `memoryReporter` / `memoryLogger`                                       | The ports in memory, for tests.                                                                                           | `@sincpro/client-framework/testing`           |

## How an application is laid out

```text
src/
  entrypoints/main.ts(x)                 configureProcess: tracer, reporter, logger, context store
  domains/
    common/infrastructure/operations.ts  export const operations — the wire every client uses
    <bounded context>/
      generated/                         sincpro-client generate — never edited
      domain/                            local Commands, Responses, DomainEvents, value rules
      adapters/                          repositories, printers, other systems — ports' adapters
      services/                          Features and ApplicationServices; registerServices
      infrastructure/                    dependencies.ts, bounded_context.ts (service bases)
      index.ts                           export const <context> — ready to execute
```

`sincpro-client scaffold <contract> --out src/domains/<context>` writes the application-owned files
once; `sincpro-client check --root src` enforces the layers.

## How to

### Start the process (once, in `main`)

```ts
configureProcess({
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
method takes the operation's input DTO and answers its answer DTO, as `generated/domain.ts` types
them. A local Command may `implements remote.CommandX` (`import type * as remote`).

### Write a use case

```ts
export class CommandQuote extends Command<ResponseTotal> {
  constructor(readonly quantity: number) {
    super();
  }
}

export class Quote extends Feature<CommandQuote, ResponseTotal> {
  // the context's base, from scaffold
  static readonly serviceName = "Quote";
  async execute(command: CommandQuote): Promise<ResponseTotal> {
    this.logger.info("Quoting", { quantity: command.quantity });
    const price = await this.client.getPrice({ sku: "A1" }); // a declared dependency
    return new ResponseTotal(command.quantity * Number(price.amount));
  }
}

sales.feature(CommandQuote)(Quote); // or @sales.feature(CommandQuote)
const answer = await sales.execute(new CommandQuote(3), { signal }); // from a screen
```

Keep this shape: `context.execute(new Command(...))`. A service is a singleton of its generation:
request state goes in the Command or the context, never on `this`; use TypeScript `private`, never
`#private`.

### Decide what a screen does with a failure

```ts
try {
  await sales.execute(command, { signal });
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

mail.feature(OrderPaid)(SendReceipt); // one subscriber per bounded context
const queue = storedQueue({
  store,
  subscriber: new Subscriber(mail, stock),
  ready,
  onSettled,
});
shop.addDependency("publisher", new Publisher(queue)); // a Feature: this.publisher.publish(…)
```

- `syncQueue(subscriber)` delivers in the call; `storedQueue` stores first, then delivers in order,
  retries what may succeed, sets aside what never will (`state: "set_aside"`), and stops after
  `maxAttempts`.
- Delivery is **at least once**: a subscriber that must not act twice keys its effect by
  `this.execution.causationId` (the envelope's id).
- An event carrying `Money`, `Decimal` or dates declares `static fromJSON`.
- One process drains a store; call `queue.drain()` when the app returns to the foreground or the
  network comes back.

### Extend the pipeline without touching services

```ts
sales.interceptor(CommandPay)((command, next, run) => {
  guard(command);
  return next(command);
});
sales.onFailure((failed) => toast(failed.execution?.useCase));
processListeners.onStart((started) => activity.running(started.execution.useCase));
sales.feature(CommandPrint, { replaces: Print })(PrintOnBixolon);
sales.extend(auditing); // a module's pieces in one place
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
- **A logger per application layer.** Use `this.logger` (bound to the run) and `project.logger`;
  only `logger` and `loggerAdapter` are predefined.
- **Catching in a Feature to hide a failure.** Declare the kind, or answer in an error handler.
- **Writing routes or RPC method names by hand.** They are the contract's bindings; regenerate.
- **A circuit breaker inside a Feature.** Put it on the transport or the adapter (`guardedTransport`).
- **Assuming an event runs once.** Key effects by `this.execution.causationId`.
- **Constructing and calling a service directly.** Everything goes through `execute` or
  `featureBus.execute`, or it is neither traced nor reported.
- **Two copies of the package.** A platform framework declares `@sincpro/client-framework` as a
  `peerDependency`; with two copies the process ports split silently.
- **Number for money, Date for a day.** Use `Decimal`, `Money`, and days as text (`isDay`, `dayOf`).

## Checklist before handing a change back

- [ ] Does the piece belong here, in the platform's framework, or in the application (the rule)?
- [ ] Every use case is a Command executed through its bounded context, with a stable `serviceName`.
- [ ] Failures declare or carry their kind; screens decide with `failureOf`.
- [ ] Events: `eventName`, `fromJSON` when they carry values, idempotent subscribers.
- [ ] The wire is injected (`operations`), never written into the code.
- [ ] Tests run on the memory ports, in Node.
