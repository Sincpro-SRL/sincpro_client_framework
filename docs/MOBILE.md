# Mobile on the client framework

The application layer lives in `@sincpro/client-framework`. Mobile supplies the platform:
SQLite and repositories, migrations, durable delivery, lifecycle, UI and exporters. This page is
how mobile adopts it — a plan, not a claim that it is adopted or device-tested. Mobile keeps no
second implementation of application execution.

| Responsibility          | Shared core                                                                 | Mobile                                                              |
| ----------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Application execution   | BoundedContext, Command, Feature, ApplicationService                        | Compose contexts in the platform kernel/modules                     |
| Dependencies            | Typed attributes registered with addDependency                              | Supply repositories, session adapters, generated clients            |
| Composition             | this.featureBus.execute(command)                                            | No competing navigator/service bus                                  |
| Context                 | Process/context/scope snapshot per execution                                | Implement/hydrate ContextStore before execution                     |
| Traces/errors           | Tracer and ErrorReporter ports                                              | Build provider/client, buffers, exporters and native integration    |
| Logs                    | Logger port, `this.logger`, `projectBoundedContext.logger`, console adapter | Adapt existing delivery to structured records; own buffering/export |
| Error handling          | Global, feature and app-service handlers; `expectErrors`                    | Register handlers per bounded context; no try/catch in Features     |
| Domain events           | `DomainEvent`; `EventSubscriber` entrypoints; remote as types               | The queue: persist, deliver to everyone who hears, retry, DLQ       |
| Replacing pieces        | `feature(dto, { replaces })`, `addDependency(…, { replaces })`              | An app's module declares what it replaces                           |
| Remote operations       | Generated client and Transport contract                                     | Inject only where remote work is required                           |
| Offline synchronization | Not supplied by command execution                                           | Explicit repository/sync/conflict policies                          |

A command may execute locally or delegate remotely; registration does not choose authority.
A generated remote client and a local repository are different dependencies.

## Startup

The platform must provide compatible random values and URL APIs before using ids/transports.
It initializes telemetry once and hands the common process simple port implementations:

```ts
import { configureProcess, processContext } from "@sincpro/client-framework";
import { openTelemetryTracer } from "@sincpro/client-framework/opentelemetry";
import { sentryReporter } from "@sincpro/client-framework/sentry";

configureProcess({
  tracer: openTelemetryTracer(provider.getTracer("mobile")),
  reporter: sentryReporter(errorClient),
  logger: { mode: appProduction ? "production" : "development" }, // the default console policy
  context: platformContextStore,
});
processContext.set({ tenant_id: session.tenant, company_id: session.company });
```

The provider, error client and store are built by mobile, not this package. The process opens
one span per Feature/ApplicationService execution; a generated client injected into a Feature
propagates that run's headers. It does not configure destinations or automatically deliver to Loki.

## Reaching the services

Mobile chooses the wire; the generated clients and the Features do not change with it:

```ts
// domains/common/infrastructure/operations.ts — what `sincpro-client scaffold` imports
export const operations = guardedTransport(
  jsonRpcOperations({ endpoint: `${server}/rpc`, headers: () => sessionHeaders() }),
  new CircuitBreaker("backend"),
);
```

`restOperations(restTransport(…))` speaks REST, `jsonRpcOperations` JSON-RPC; a gRPC adapter is
mobile's — one function reading `operation.grpc.method`, putting `options.headers` in the call's
metadata, and declaring `kindOfGrpcCode(code)` on what fails (README, «Writing an adapter for
another wire»). Odoo is no sincpro_framework contract: mobile-odoo keeps its client, and its
errors declare their kind.

## Registering local work

```ts
import { BoundedContext, Command, Feature } from "@sincpro/client-framework/core";

class CommandReserve extends Command<{ quantity: number }> {
  constructor(
    readonly sku: string,
    readonly quantity: number,
  ) {
    super();
  }
}

interface SalesDependencies {
  stock: { reserve(sku: string, quantity: number): Promise<{ quantity: number }> };
}

class Reserve extends Feature<CommandReserve, { quantity: number }> {
  static readonly serviceName = "Reserve";
  declare readonly stock: SalesDependencies["stock"];
  execute(command: CommandReserve) {
    return this.stock.reserve(command.sku, command.quantity);
  }
}

const salesBoundedContext = new BoundedContext<SalesDependencies>("sales");
salesBoundedContext.addDependency("stock", stockRepository);
salesBoundedContext.feature(CommandReserve)(Reserve);
await salesBoundedContext.execute(new CommandReserve("A1", 2));
```

An ApplicationService composes Features through `this.featureBus.execute(...)`. Define shared
service bases with typed dependency attributes once per context, as in the repository's test
fixtures. Each service is a singleton of its generation, so request state must not be stored on it.
Scopes share instances while isolating execution context. Avoid JavaScript `#private` fields.

Function registration requires no decorator transform. Decorator syntax is optional — the
tests compile both standard and legacy (`experimentalDecorators`) forms with TypeScript — and
must be validated with mobile's actual Babel/Metro configuration before use.

## Context storage

ContextStore requires synchronous reads, version changes and subscriptions. A synchronous
platform store can implement it directly; asynchronous storage should hydrate `memoryContexts()`
before the first use case and write changes through. Watchers must unsubscribe correctly.

Context is a small set of execution values, not the domain database or a screen-state cache.
`processContext`, each bounded context's `context`, and `scoped(...)` supply precedence. A root
execution snapshots those values once; its child Features inherit that snapshot after awaits.

## Logging, from mobile's loggers

Mobile's `EApplicationLogger` contexts map onto fewer layers here. The application layer imports
no logger: what `loggerUseCases` wrote, a Feature writes with `this.logger` (bound to the run)
and a bounded context with `salesBoundedContext.logger`.

| Mobile                                   | Here                                                     |
| ---------------------------------------- | -------------------------------------------------------- |
| `GLOBAL`, `CRON_JOBS`                    | `logger` (infrastructure)                                |
| `ADAPTER`, `REPOSITORIES`, `ODOO_CLIENT` | `loggerAdapter`, with a safe attribute (`{ component }`) |
| `USE_CASES`                              | `this.logger` in a Feature or ApplicationService         |
| `EVENT_BUS` (`QUEUE_PROCESSOR`)          | mobile's own worker: `logger`, or its bounded context's  |

The in-app debug switch maps onto `configureLogger({ mode, level, layers })`: it replaces only
logging, never the tracer, the reporter or the context. A Loki delivery is mobile's `Logger`
engine, combined with the console through `combineLoggers`.

## Events, subscribers and crons

Mobile's `EventBus` splits along the line this package draws: what is the same on every
platform comes from here; what a phone does to deliver durably stays in mobile, behind the
`EventQueue` port. A module keeps its doors where they are — `entrypoints/queue/` and
`entrypoints/cron/` —, and they become what they always meant: entrypoints that translate an
event or a tick into a Command, executed on the module's bounded context. What a subscriber
decides today moves into a Feature; what it orchestrates, into an ApplicationService.

| Today in mobile                                  | With the client framework                                                       |
| ------------------------------------------------ | ------------------------------------------------------------------------------- |
| `Subscriber` with `listen` and `process(event)`  | an `EventSubscriber` with `handle(event)`: builds the Command, executes it      |
| the service calls and checks inside `process`    | a Feature (one step) or an ApplicationService (a workflow) of a Command         |
| a module's `subscribers()` list                  | its `Subscriptions` (`entrypoints/queue/index.ts`), one subscriber per event    |
| a use case that exists only because of the event | a use case of the event: `boundedContext.feature(Event)(…)`                     |
| `EventBus.on(subscriber)`, several per event     | the queue's `new Subscriber(...boundedContexts, ...subscriptions)` fans out     |
| `EventBus.publish` / `publishSync`               | `this.publisher.publish(event)` — over mobile's queue, or `syncQueue`           |
| `event_chain`, `applyChain`, `runWithChain`      | the `Envelope` and `execution.correlationId` / `causationId`                    |
| event interceptors (`interceptEvent`, `"*"`)     | `boundedContext.interceptor(Command)(…)` around the use cases subscribers call  |
| `static replaces = CoreSubscriber`               | `subscriptions.subscribe(Event, { replaces: CoreSubscriber })(…)`               |
| a `CronWorker` job calling a service or workflow | a `CronWorker` job executing a Command: `boundedContext.execute(new Command())` |
| `publishActivity` running / succeeded / failed   | `processListeners`, or the stored queue's `onSettled`                           |
| `RepeatableFailure`, `DomainNetworkError`        | errors that declare a kind (`unavailable`, `unknown_outcome`): retried          |
| `UserError`, `ValidationError` of mobile-odoo    | errors that declare `domain` / `invalid`: set aside, never retried              |
| the drain loop, retries, backoff, DLQ            | `storedQueue` — the same rules on every platform                                |
| `requiresNetwork`, `requiresAuth`                | `ready` of the stored queue: waits while the rest go on                         |
| SQLite table, `AppState`, NetInfo                | mobile's `EventStore`, and what calls `queue.drain()`                           |

```ts
// a module's entrypoints/queue/sale-order-confirmed.subscriber.ts — it translates, nothing else
export class SaleOrderConfirmedSubscriber extends EventSubscriber<SaleOrderConfirmedEvent> {
  static readonly subscriberName = "SaleOrderConfirmed";
  declare readonly distributionBoundedContext: BoundedContext<DistributionDependencies>;
  async handle(event: SaleOrderConfirmedEvent) {
    await this.distributionBoundedContext.execute(
      new CommandConfirmQuotationInBackend(event.saleOrderUUID),
    );
  }
}

// entrypoints/cron/sync-distribution-app.cron.ts — the scheduler is mobile's, the work a Command
export default new CronWorker(
  "SYNC_DISTRIBUTION_APP",
  () => distributionBoundedContext.execute(new CommandSyncDistributionApp()),
  15,
  { requiresAuth: true },
);

// mobile writes only the store: a SQLite table, rows in the order added
const sqliteEventStore: EventStore = {
  add: (stored) => events.insert(stored),
  next: (skip) => events.firstPendingNotIn(skip),
  save: (stored) => events.update(stored),
};

const queue = storedQueue({
  store: sqliteEventStore,
  subscriber: new Subscriber(...boundedContexts, ...subscriptions), // every module's
  ready: (stored) =>
    (online || !requiresNetwork(stored)) && (signedIn || !requiresAuth(stored)),
  onSettled: (stored) => publishActivity(stored),
});
AppState.addEventListener("change", (state) => state === "active" && queue.drain());
NetInfo.addEventListener((net) => net.isConnected && queue.drain());
```

The rules — store first, deliver in order, retry what may succeed after its wait, set aside what
never will, never run one who heard it twice — are the same as on the web; mobile keeps only the table,
when to drain, and the screen that lists the set-aside events (`state: "set_aside"`). A stored
event is rebuilt as its class — `static fromJSON` when it has one, as `from` is today. The
events a backend publishes reach mobile as generated types when its contract is exported with
`--events`. This package exports no entity interface to implement; entity identity stays in
mobile.

Errors of mobile-odoo declare their kind with the backend's JSON-RPC table
(`kindOfJsonRpcCode`) or the one they mean (`domain`, `invalid`, `unavailable`): the queue, the
outcome and the screens then decide the same way as everywhere. A `CircuitBreaker` around the
Odoo client stops spending battery on a server that does not answer; its `CircuitOpen` tells the
queue how long to wait. Delivery is at least once: a use case that pushes to the server keys the
write by the entity it pushes, as the `external_uuid` check does today, or by the envelope's id —
the subscriber reads it as `this.execution.causationId` and hands it in the Command.

## Adoption order

1. Depend on a published release; never a local link, a tarball or a version written by hand.
2. Plug mobile's Tracer, ErrorReporter, Logger engine and ContextStore once, at startup.
3. Move one bounded context at a time: class Commands, `execute(command)` services, explicit
   registrations, `featureBus` composition, its error handlers. Delete its former execution code
   in the same step.
4. Inject generated clients where remote work is needed; keep local repositories explicit.
   Generated DTOs are types, not constructors.
5. Prove offline, restart and background behavior on devices, apart from the unit tests here;
   traces, reports and logs need real delivery evidence.
6. Keep the wire rules: exact Decimal/Money until presentation, ids, days and instants,
   `valuesOf`/`readValues`. Canonicalization and storage stay mobile's.

See the [shared vocabulary](UBIQUITOUS_LANGUAGE.md) and the [README](../README.md).
