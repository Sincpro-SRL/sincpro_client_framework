# @sincpro/client-framework

The client-side application core of [sincpro_framework](https://github.com/Sincpro-SRL/sincpro_framework),
for web, React Native, scripts and tests. No React, DOM or platform storage.

## Breaking command API

There is one execution model: **Command -> Feature or ApplicationService -> Response**.
ApplicationServices compose their bounded context's Features through a feature bus.

`UseBoundedContext`, service maps, direct `context.Service.method(...)` facades and the old
Feature/ApplicationService bases are removed. There are no compatibility aliases. The command
core has its own execution engine; it does not wrap the removed facade runtime. Existing
applications and previously scaffolded files must migrate before adopting this release.
The release pipeline chooses the version; it is not bumped by hand.

```ts
import {
  ApplicationService,
  BoundedContext,
  Command,
  Feature,
  Response,
} from "@sincpro/client-framework/core";

class ResponseTotal extends Response {
  constructor(public readonly total: number) {
    super();
  }
}

class CommandTotal extends Command<ResponseTotal> {
  constructor(public readonly quantity: number) {
    super();
  }
}

class CommandQuote extends Command<ResponseTotal> {
  constructor(public readonly quantity: number) {
    super();
  }
}

class Total extends Feature<CommandTotal, ResponseTotal> {
  static readonly serviceName = "Total";
  declare readonly unitPrice: number;

  execute(dto: CommandTotal): ResponseTotal {
    return new ResponseTotal(dto.quantity * this.unitPrice);
  }
}

class Quote extends ApplicationService<CommandQuote, ResponseTotal> {
  static readonly serviceName = "Quote";

  execute(dto: CommandQuote): Promise<ResponseTotal> {
    return this.featureBus.execute(new CommandTotal(dto.quantity));
  }
}

const sales = new BoundedContext<{ unitPrice: number }>("sales");
sales.addDependency("unitPrice", 10);
sales.feature(CommandTotal)(Total);
sales.appService(CommandQuote)(Quote);

const response = await sales.execute(new CommandQuote(3)); // ResponseTotal, total = 30
```

These are also exported from the main entry. A class Command's generic associates its response
without adding a runtime field. Results can be DTOs, plain generated responses, pages, primitive
values or `void`; `Response` is an optional class base, not a runtime schema validator.

### Registration, dependencies and generations

- One command class has one executor across both layers. Dispatch uses exact constructor
  identity, never `constructor.name`. `serviceName` names the service in observability and
  must be stable under minification.
- Dependencies are registered on the bounded context and injected as attributes. Declare their
  types on a service or on shared service bases as in
  [`tests/support/project/`](tests/support/project/). Interfaces and `declare` fields do not
  register dependencies. Reading a missing dependency fails explicitly.
- A service instance is shared by every execution of its generation, like the backend.
  Request state belongs in DTOs, local variables or execution context, not on the service.
  Use TypeScript `private`, not JavaScript `#private`: execution-bound views cannot access
  another object's private slots.
- The first execution or `buildRootBus()` constructs the generation. Later registrations
  affect the next generation; running calls and their child Features keep the original one.
- `fresh()` copies registrations and dependency references but builds independent services.
  `scoped({ company_id: 2 }).execute(command)` shares the current generation's instances and
  adds execution context, without mutating the parent context.
- `deps` is a live read-only dependency locator. Replacement requires
  `addDependency(name, next, { replaces: previous })`. A mismatched replacement is rejected,
  rather than using the backend's warning-and-replace fallback.
- An optional `execute(command, ResponseClass)` argument only checks the association in
  TypeScript; it does not validate or rebuild runtime data. Structurally identical DTO classes
  may be type-compatible in TypeScript, but runtime dispatch still uses exact constructors.

### Decorators are optional

The same registration functions support `@sales.feature(CommandTotal)` and
`@sales.appService(CommandQuote)`. They preserve the declared class and register after static
initialization. No DI library or `reflect-metadata` is required.

The library itself contains no decorator syntax. Projects without decorator transforms use the
function form. Tests compile real standard decorator syntax with TypeScript; this does **not**
validate default Vite or Metro support. Each consumer must configure and test its transform.

## Generated client, local domain and mapping are different

```text
Local Command -> ApplicationService -> Feature
                                        |
                                injected dependency
                              /         |          \
                    generated client  repository  other adapter
                           |
                       Transport -> backend
```

- **Core:** executes locally authored use cases. It owns no application's business rules.
- **Generated client:** a typed remote adapter. Inject it as a dependency; it is not a local
  ApplicationService and is not automatically registered on the local bus.
- **Generated DTOs:** currently TypeScript types, not runtime constructors or validators.
  Handwritten local classes can implement those types. Code generation of class readers and
  runtime validation is a separate task, not implied by `Command<Response>`.
- **Mapping `Entity`:** the descriptor of remote models, routes and commands, not a domain entity.
- **`IEntity` / `IDomainEvent`:** minimal structural domain contracts (`id`, and for an event,
  stable `name` and ISO `createdAt`). They contain no storage, queue status or publication.
  Mobile can implement them through its own fields or getters without moving SQLite here.

## Observability is injected

```ts
import { configureProcess, memoryContexts, processContext } from "@sincpro/client-framework";

configureProcess({
  tracer, // Tracer port
  reporter, // ErrorReporter port
  logger: applicationLogger, // optional engine override; not a layer logger
  mode: "development", // the host selects production explicitly
  context: memoryContexts(), // ContextStore; memory is the default
});
processContext.set({ tenant_id: "acme" });
sales.context.set({ company_id: 2 });
```

The internal engine opens one span per service execution. An ApplicationService's child Features
share its trace and context snapshot. It records `ok`, `refused`, `aborted` or `failed`, and reports
unexpected failures once as they propagate. No tracer means no claimed trace; no reporter means
no remote error report. A failing observability adapter does not replace the business result.

An injected generated client is bound to the execution through `BIND` and carries `traceparent`,
`tracestate` when present, and `sincpro-context`. Calling it directly outside a service does not
automatically open a span. The generator does not add an independent HTTP span for each request.
`screensTransport(transport)` routes screen reads/writes through registered command Features
with the same instrumentation; do not wrap a Feature's injected transport with it.

Vendor adapters wrap what the application builds; they initialize nothing:

```ts
import { openTelemetryTracer } from "@sincpro/client-framework/opentelemetry";
import { sentryReporter } from "@sincpro/client-framework/sentry";
```

`reportError(error, where)` handles unexpected failures outside an execution, such as a view
or worker. Refusals and aborts are not incident reports. Context is per execution, never a global
async stack; a `ContextStore` supplies synchronous reads and a version for subscriptions.

### Layered logging

Loggers are predefined in the core and can be imported from any module. They all use the same
process engine, which defaults to the development console. No factory or configuration is
required to start logging:

```ts
import {
  loggerAdapter,
  loggerRepositories,
  loggerUseCases,
} from "@sincpro/client-framework/core";

loggerRepositories.info("Repository initialized");
loggerAdapter.warn("Adapter operation is slow");
loggerUseCases.info("Application initialized");
```

Predefined names are `logger` (global), `loggerUseCases`, `loggerFeature`,
`loggerApplicationService`, `loggerAdapter`, `loggerRepositories`, `loggerTransport`,
`loggerQueueProcessor` and `loggerCronJobs`. The root entry exports the same objects.

Choose the engine or console policy centrally:

```ts
import { configureLogger } from "@sincpro/client-framework/core";

configureLogger({
  mode: "production", // default console is now silent, like mobile
});

// Alternatively, use an application-supplied Logger port:
configureLogger({ engine: applicationLogger });
```

`configureLogger` changes only logging, preserving the tracer, reporter and context store.
Already imported loggers follow the new engine. `configureLogger({ engine: false })` disables
logging; `configureLogger()` restores the default development console. `loggerFor(layer)` remains
a lower-level factory, not something every caller must use. `configureProcess({ logger: engine, mode })`
can set logging together with the other process ports at startup, but replaces the full process
configuration rather than patching it.

Like mobile's console policy, **production silences the entire console**. Development prints
all levels and layers by default. Per-layer masks and thresholds affect INFO/DEBUG only;
WARN/ERROR remain visible in development. There is no global console patch or mutable
production flag. Choose the mode in the host, not in application services.

Layers are `global`, `use_cases`, `application_service`, `feature`, `adapter`, `repositories`, `transport`,
`event_bus` and `cron`. The core does not know Odoo or any application's domain. Use explicit
safe attributes such as `{ component: "odoo" }` when an adapter needs a more specific label.
`loggerUseCases` tags general use-case messages; automatic execution records retain the more
specific Feature/ApplicationService layer.

Every Feature/ApplicationService has an execution-bound logger:

```ts
this.logger.info("Business milestone", { count: 2 });
this.repositoryLogger.warn("Slow repository operation"); // injected loggerRepositories
```

Register a predefined logger directly as a dependency to bind it through `BIND` when read:
`project.addDependency("repositoryLogger", loggerRepositories)`.
Bound loggers preserve execution, trace and span correlation across awaits and concurrent
calls without a global active-span stack. A standalone logger has no invented trace ids.
An unrelated adapter that closes over an unbound logger does not gain correlation magically:
inject a layer logger directly, pass the bound logger, or make the adapter execution-bindable.

The engine emits `execution.started` at DEBUG and `execution.finished` with duration/outcome:
INFO for success/abort, WARN for refusal, ERROR for failure. Each layer has its own execution
record; incident reporting still deduplicates propagation through nested services.
Automatic records include no DTO, result, raw exception/stack or session context. Explicit
messages/attributes are the author's responsibility: do not log secrets or business payloads.
Use ErrorReporter for detailed exception reporting.

`combineLoggers(consoleLogger(...), destination)` fans out without sharing console filters.
Each sink owns its delivery/filter policy, so production console silence never disables a
separately supplied destination. `memoryLogger()` from `./testing` records every level for tests.
Sink failures are best-effort, including rejected asynchronous writes; they do not change the
business result or block other sinks. The core does not await logging delivery or provide a
flush guarantee. Loki adapters, retention, buffering and credentials remain platform concerns.
The built-in console engine is also available explicitly from
`@sincpro/client-framework/console` when constructing a combined engine.

### When to use screensTransport

`screensTransport` is **not a React screen component**. It adapts a Transport so requests made
directly by screen infrastructure get a built-in command execution, trace, error handling and
layered lifecycle logs:

```ts
const raw = restTransport({ base: "/v1" });
const screenRequests = screensTransport(raw);
await screenRequests.one("/tickets/42"); // screens/EntityReads.one

project.addDependency("client", clientOf(raw)); // normal client for Features
```

Use the wrapper for screen-level reads/actions that do not already enter your own Feature or
ApplicationService. Inside a Feature inject the **raw** transport or generated client: its
execution already supplies observability. Wrapping it again creates redundant executions.
Wrapping an existing screens transport twice returns the same wrapper.

## Generate, scaffold and check

```bash
sincpro-client generate project.contract.json --out src/domains/project/generated --domain project
sincpro-client scaffold project.contract.json --out src/domains/project
sincpro-client check --root src
```

`generate` writes what the contract says, so a screen keeps no copy of it: each record's type as
a read answers it, and what a caller sends of it as `<Name>Input` (what the contract requires;
the server fills the rest); each entity with its list, record, edit, export, Commands — their
bodies and answers typed — and its `history`, the record's events (`DomainEvents`).

`scaffold` writes application-owned dependency bases and an explicit `registerServices(context)`
entrypoint using the command API. It never rewrites an existing application file. Regenerating
remote clients does not overwrite local services or migrate old scaffolds.

```text
domains/project/
  generated/                         remote contract; regenerate, never edit
  domain/                            local Command/Response classes and domain types
  infrastructure/dependencies.ts     client, repositories and other adapters
  infrastructure/bounded_context.ts  typed service bases and context construction
  services/                          execute(dto) use cases; registerServices
  index.ts                           bounded context ready to execute commands
```

`check` resolves imports with the application's TypeScript configuration and enforces bounded
context/layer boundaries. It does not conflate remote DTOs with local executable services.
Shared terminology is in [`docs/UBIQUITOUS_LANGUAGE.md`](docs/UBIQUITOUS_LANGUAGE.md);
mobile adoption is in [`docs/MOBILE.md`](docs/MOBILE.md).

## Values on the wire

The existing wire rules are independent of command dispatch:

| Value      | Travels as                             | API                                            |
| ---------- | -------------------------------------- | ---------------------------------------------- |
| Decimal    | Exact text, `"10.50"`                  | `Decimal`                                      |
| Money      | `{ amount: "10.50", currency: "BOB" }` | `Money`                                        |
| Day        | `"2026-10-02"`, not an instant         | `isDay`, `dayOf`                               |
| Instant    | ISO text                               | `wallTimeOf`, `instantOf`                      |
| ID         | UUID v7 as 32 hex                      | `newEntityId`, `isEntityId`, `momentOf`        |
| Bytes      | `{ "$bytes": "<base64>" }`             | `valuesOf`, `readValues`                       |
| Collection | Items, count and cursor                | `collectionOf`, `isPartial`, `relatedCriteria` |
| Export     | Parquet, Arrow or JSON Lines           | `downloadRoute`, `exportRoute`                 |

`Money` does not add currencies, `Decimal` uses exact BigInt arithmetic, and a day is never
silently converted into an instant. `valuesOf`/`pack` serialize; `readValues` reads tagged values;
`rebuilt`/`unpack` use an explicitly supplied reader. None is automatic DTO schema validation.
Invalid JSON values such as cycles, functions and nonfinite numbers are rejected.

Collections may be partial pages; only whole owned lines are written back. An optional
`parquetDecoder` from `@sincpro/client-framework/parquet` reads large pages through the same
transport. Formatting, inputs and storage belong to the platform.

## Test organization and guarantees

Tests mirror modules: [`tests/core/`](tests/core/), [`tests/common/`](tests/common/),
[`tests/client/`](tests/client/), [`tests/codegen/`](tests/codegen/),
[`tests/context/`](tests/context/), [`tests/model/`](tests/model/),
[`tests/services/`](tests/services/) and [`tests/adapters/`](tests/adapters/).
[`tests/observability/`](tests/observability/) covers the built-in console engine.
[`tests/integration/`](tests/integration/) joins boundaries; [`tests/support/`](tests/support/)
holds shared fixtures and immutable generated contracts. The root entry has
[`tests/index.test.ts`](tests/index.test.ts). Directory symmetry is not a claim of full coverage.

Core tests include the same registration contracts for function and compiled-decorator forms,
independent execution/DI/generation tests, and [`tests/core/types.ts`](tests/core/types.ts) for
type inference and expected compiler errors. `make typecheck` checks those type contracts;
Vitest checks runtime behavior. The generated-client integration asserts payload, local result,
context propagation and trace ancestry.

Still outside this implementation: event dispatch, transaction/outbox integration, durable
requests, DTO runtime validation/rebuilding, multi-DTO registration and handler replacement.
Consumer builds and real web/mobile telemetry delivery require their own platform evidence.

## Platforms and development

The core uses standard JavaScript, `Proxy`, `WeakMap`, `BigInt`, and platform ports. The client
uses `fetch`, `AbortSignal`, `URL` and `crypto.getRandomValues`. React Native consumers must
provide compatible URL and random-value implementations before using these APIs.
An asynchronous context store must hydrate a synchronous memory store before first execution.

Node 26 (`nvm use`):

```bash
make init
make typecheck
make test
make verify-format
make build
```

`make doctor` enforces self-imports, platform neutrality and Node only in codegen. Read
[`AGENTS.md`](AGENTS.md), [`MANIFESTO.md`](MANIFESTO.md) and
[`CONTRIBUTING.md`](CONTRIBUTING.md). Release workflows remain delegated to
[`Sincpro-SRL/.github`](https://github.com/Sincpro-SRL/.github); versions are written by release,
not edited manually.

## License

[MIT](LICENSE)
