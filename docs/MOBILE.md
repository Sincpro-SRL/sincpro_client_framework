# Mobile adoption of the command core

The common application core lives in `@sincpro/client-framework/core`. Mobile supplies the
platform: SQLite/repositories, migrations, durable delivery, lifecycle, UI and exporters.
This document is an adoption plan, not a claim that mobile has been migrated or device-tested.

## Breaking API

The old facade Feature/ApplicationService classes, service maps and direct service-method
entrypoints are removed from client-framework. Mobile consumers must migrate deliberately;
there are no compatibility aliases. Do not retain a second implementation of application
execution in mobile.

| Responsibility          | Shared core                                                    | Mobile                                                              |
| ----------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------- |
| Application execution   | BoundedContext, Command, Feature, ApplicationService           | Compose contexts in the platform kernel/modules                     |
| Dependencies            | Typed attributes registered with addDependency                 | Supply repositories, session adapters, generated clients            |
| Composition             | this.featureBus.execute(command)                               | No competing navigator/service bus                                  |
| Context                 | Process/context/scope snapshot per execution                   | Implement/hydrate ContextStore before execution                     |
| Traces/errors           | Tracer and ErrorReporter ports                                 | Build provider/client, buffers, exporters and native integration    |
| Logs                    | Logger port, execution-bound layer loggers and console adapter | Adapt existing delivery to structured records; own buffering/export |
| Domain identity/events  | IEntity and IDomainEvent interfaces                            | Implement fields/getters; retain persistence and queue metadata     |
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
  mode: appProduction ? "production" : "development", // selects the default console policy
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

Function registration requires no decorator transform. Standard decorator syntax is optional
and must be validated with mobile's actual bundler configuration before use.

## Context storage

ContextStore requires synchronous reads, version changes and subscriptions. A synchronous
platform store can implement it directly; asynchronous storage should hydrate `memoryContexts()`
before the first use case and write changes through. Watchers must unsubscribe correctly.

Context is a small set of execution values, not the domain database or a screen-state cache.
`processContext`, each bounded context's `context`, and `scoped(...)` supply precedence. A root
execution snapshots those values once; its child Features inherit that snapshot after awaits.

## Entity and event contracts

Mobile can implement `IEntity` and `IDomainEvent` through fields or getters. For example, a class
whose local identity is `uuid` may expose `get id() { return this.uuid; }`. This is a domain adapter,
not a requirement to duplicate persisted fields or rename a database column.

The interfaces do not carry queue status, attempts, DLQ policy or transport configuration.
They do not register an event consumer or promise event delivery. Keep those responsibilities
in mobile until a separately designed publisher/outbox contract is implemented.

## Migration order

1. Publish the breaking client-framework release; verify the published version before updating
   consumers. No local links, tarballs or manual version edits.
2. Configure mobile's Tracer, ErrorReporter and ContextStore implementations once.
3. Migrate one bounded context at a time: class Commands, execute(dto) services, explicit
   registrations and featureBus composition. Remove its former local execution implementation.
4. Inject generated remote clients where needed; keep local business repositories explicit.
   Generated DTO types are not constructors. Reconstruction/validation is a separate boundary.
5. Test offline/restart/background behavior on devices independently of command-core unit tests.
   Traces, error reports and future logs require actual delivery evidence.
6. Preserve shared wire rules: exact Decimal/Money until presentation, ids, days/instants and
   valuesOf/readValues. Canonicalization and storage remain platform concerns.

This package does not migrate mobile's releases, build configuration or persisted data by itself.
See the [shared vocabulary](UBIQUITOUS_LANGUAGE.md) and [README](../README.md).
