# Mobile on the client framework

The application layer lives in `@sincpro/client-framework`. Mobile supplies the platform:
SQLite and repositories, migrations, durable delivery, lifecycle, UI and exporters. This page is
how mobile adopts it — a plan, not a claim that it is adopted or device-tested. Mobile keeps no
second implementation of application execution.

| Responsibility          | Shared core                                                    | Mobile                                                              |
| ----------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------- |
| Application execution   | BoundedContext, Command, Feature, ApplicationService           | Compose contexts in the platform kernel/modules                     |
| Dependencies            | Typed attributes registered with addDependency                 | Supply repositories, session adapters, generated clients            |
| Composition             | this.featureBus.execute(command)                               | No competing navigator/service bus                                  |
| Context                 | Process/context/scope snapshot per execution                   | Implement/hydrate ContextStore before execution                     |
| Traces/errors           | Tracer and ErrorReporter ports                                 | Build provider/client, buffers, exporters and native integration    |
| Logs                    | Logger port, `this.logger`, `project.logger`, console adapter  | Adapt existing delivery to structured records; own buffering/export |
| Error handling          | Global, feature and app-service handlers; `expectErrors`       | Register handlers per bounded context; no try/catch in Features     |
| Domain events           | `DomainEvent` executed by its subscriber; remote ones as types | The queue: persist, deliver to each bounded context, retry, DLQ     |
| Replacing pieces        | `feature(dto, { replaces })`, `addDependency(…, { replaces })` | An app's module declares what it replaces                           |
| Remote operations       | Generated client and Transport contract                        | Inject only where remote work is required                           |
| Offline synchronization | Not supplied by command execution                              | Explicit repository/sync/conflict policies                          |

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

const sales = new BoundedContext<SalesDependencies>("sales");
sales.addDependency("stock", stockRepository);
sales.feature(CommandReserve)(Reserve);
await sales.execute(new CommandReserve("A1", 2));
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
and a bounded context with `sales.logger`.

| Mobile                                   | Here                                                     |
| ---------------------------------------- | -------------------------------------------------------- |
| `GLOBAL`, `CRON_JOBS`                    | `logger` (infrastructure)                                |
| `ADAPTER`, `REPOSITORIES`, `ODOO_CLIENT` | `loggerAdapter`, with a safe attribute (`{ component }`) |
| `USE_CASES`                              | `this.logger` in a Feature or ApplicationService         |
| `EVENT_BUS` (`QUEUE_PROCESSOR`)          | mobile's own worker: `logger`, or its bounded context's  |

The in-app debug switch maps onto `configureLogger({ mode, level, layers })`: it replaces only
logging, never the tracer, the reporter or the context. A Loki delivery is mobile's `Logger`
engine, combined with the console through `combineLoggers`.

## Events and their subscribers

Mobile's `EventBus` splits along the line this package draws: what is the same on every
platform comes from here; what a phone does to deliver durably stays in mobile, behind the
`EventQueue` port.

| Today in mobile                                           | With the client framework                                             |
| --------------------------------------------------------- | --------------------------------------------------------------------- |
| `Subscriber` with `listen` and `process(event)`           | a Feature registered for the event class: `context.feature(Event)(…)` |
| `EventBus.on(subscriber)`, several per event              | one per bounded context; `new Subscriber(...contexts)` fans out       |
| `EventBus.publish` / `publishSync`                        | `this.publisher.publish(event)` — over mobile's queue, or `syncQueue` |
| `event_chain`, `applyChain`, `runWithChain`               | the `Envelope` and `execution.correlationId` / `causationId`          |
| event interceptors (`interceptEvent`, `"*"`)              | `context.interceptor(Event)(…)`, `context.interceptor()(…)`           |
| `static replaces = CoreSubscriber`                        | `context.feature(Event, { replaces: CoreSubscriber })(…)`             |
| `publishActivity` running / succeeded / failed            | `onStart`, `onCompletion`, `onFailure`                                |
| `RepeatableFailure`, `DomainNetworkError`                 | kept by mobile's queue: what it retries                               |
| SQLite table, DLQ, `AppState`, `requiresNetwork`, backoff | mobile's `EventQueue` adapter                                         |

```ts
// mobile's queue, behind the port: store now, deliver when it can
const sqliteQueue: EventQueue = {
  async put(event, envelope) {
    await DomainEventRepository.save({ ...envelope, payload: valuesOf(event) });
    worker.trigger();
  },
};

// the worker, for each stored event
const Event = subscriber.eventTypeOf(stored.name);
if (Event) {
  const handled = await subscriber.handle(rebuild(Event, stored.payload), stored.envelope);
  // a failure: retry when it is repeatable, the DLQ otherwise — mobile's policy
}
```

`rebuild` is mobile's: how a stored payload becomes an instance of its class (its `from`). The
events a backend publishes reach mobile as generated types when its contract is exported with
`--events`. This package exports no entity interface to implement; entity identity and persisted
events stay in mobile.

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
