# Ubiquitous language

One vocabulary for sincpro_framework (Python), @sincpro/client-framework (TypeScript),
@sincpro/web-framework and @sincpro/mobile. The backend is the semantic reference; a language
limitation must be named and tested rather than hidden behind a different architecture.

## Application execution

```text
Entrypoint -> BoundedContext.execute(Command) -> Feature or ApplicationService -> Response
                                                       |
                                        featureBus.execute(Command)
                                                       |
                                                    Feature
```

| Word               | Meaning                                                                      | Backend                                         | Client core                                                                |
| ------------------ | ---------------------------------------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------- |
| Bounded context    | Owns one model, dependencies and use-case registrations; it is a bus         | `UseFramework(name)`                            | `new BoundedContext<Dependencies>(name)`                                   |
| Command            | A request for work, not a fact already confirmed                             | DTO class                                       | `class Request extends Command<Result>`                                    |
| Response           | The result of that execution, not of all later event consumers               | DTO, object, list or None                       | DTO, object, page, primitive or void; `Response` is an optional class base |
| Feature            | Executes one registered operation                                            | `feature(Command)(Service)`                     | `feature(Command)(Service)` or standard decorator syntax                   |
| ApplicationService | Composes Features of its own context                                         | `app_service(Command)(Service)`                 | `appService(Command)(Service)`                                             |
| Feature bus        | Executes only Features in the current generation, under its parent execution | `self.feature_bus`                              | `this.featureBus`                                                          |
| Dependencies       | Registered adapters, available as typed service attributes                   | `add_dependency`, `self.client`                 | `addDependency`, `this.client`                                             |
| Generation         | One snapshot of registrations, adapters and service instances                | Built lazily; in-flight work keeps its snapshot | Same; `buildRootBus()` and `fresh()` are explicit                          |
| Use case           | One operation run through the bus, with one execution and span               | A registered DTO                                | A registered Command                                                       |

The facade service API is removed. There is no service-map registry, direct service-method
entrypoint, second execution pipeline or compatibility alias.

## Remote contracts are not local services

| Word             | Meaning                                                                                  |
| ---------------- | ---------------------------------------------------------------------------------------- |
| Client contract  | What a remote service publishes: models, operations, input/output schemas and bindings   |
| Generated client | A typed remote adapter made over a Transport; injectable into a local Feature            |
| Generated DTO    | A compile-time type from that contract; not currently a runtime class or validator       |
| Mapping Entity   | The remote descriptor exported as `Entity`, used for routes, fields and commands         |
| IEntity          | Minimal local domain identity contract; unrelated to the mapping descriptor              |
| IDomainEvent     | A fact's id, stable name and creation instant; no delivery or persistence implementation |
| Transport        | The remote boundary: REST, memory, or a separately implemented platform adapter          |

Local classes may implement generated DTO types, but a generated client is not automatically
an ApplicationService or registered local executor. A history response containing event records
is not an event bus. Authority of local/remote rules is explicit; synchronization is separate.

## Process, context and telemetry

| Word          | Meaning                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------- |
| Process       | Ports configured once at application startup through `configureProcess`                     |
| Context       | Values an execution runs with: process, bounded context, then explicit scope                |
| ContextStore  | Synchronous values/version/subscription port; persistence belongs to the platform           |
| Execution     | One run: id, service identity, context snapshot, span and parent                            |
| Tracer        | Opens a span; the application supplies/export configures its implementation                 |
| ErrorReporter | Reports unexpected failures with trace/execution correlation                                |
| Outcome       | `ok`, `refused`, `aborted` or `failed`; a business refusal is not an incident               |
| Logger        | Structured records tagged by layer and execution; not a synonym for Tracer or ErrorReporter |

Span names use `<bounded context>/<serviceName>` and use-case identity
`<bounded context>.<serviceName>`. Stable metadata is required because a production build can
rename JavaScript classes. Wire identities for persisted messages are a separate future contract.

Context travels per call, never in a global async stack. An injected generated client is bound
through `BIND` and propagates trace/context headers; an unrelated direct call has no automatic
execution span. The generator does not add an independent HTTP span.

Predefined core loggers share one configurable engine. Console is the default:
all development layers/levels by default, no production output,
and per-layer INFO/DEBUG masks that do not hide development WARN/ERROR. Other destinations have
their own policies. A LayerLogger is an execution-bound facade over the process Logger port.
Standalone predefined loggers carry their layer; execution correlation requires explicit
binding. configureLogger updates the engine without replacing other process ports.
Automatic lifecycle records include outcome and duration, never DTOs or full session context.
Loki, buffers, endpoints, credentials and flush guarantees remain platform responsibilities.

## Values and serialization

`Decimal`, `Money`, ids, a day, an instant, bytes and paginated collections have one wire form.
`valuesOf`/`pack` serialize; `readValues` restores tagged values; `rebuilt`/`unpack` use an explicit
reader. Schema validation, class construction and business validation are distinct steps.
A generic type annotation is not a reader, and a class constructor is not Pydantic.

## Explicit differences and adoption work

- Python's callable bus is expressed as `.execute(...)` in TypeScript.
- The core's generic Command result is erased at runtime. Structurally identical TS classes can
  be assignable even though dispatch uses exact constructors.
- Standard decorators need a compiler transform; function registration needs none.
- Invalid dependency replacement is rejected here, unlike the backend's warning-and-replace
  fallback. Multi-DTO registrations and handler replacement are not yet implemented.
- Backend/client tracing attribute naming must evolve together when its canonical vocabulary
  changes; `sincpro.context` currently identifies the bounded context.
- Mobile/web must migrate their consumers in their own releases. Mobile keeps SQLite, workers,
  outbox/DLQ, lifecycle and telemetry delivery. DomainModule and the platform kernel compose
  bounded contexts; they are not competing application-service cores.
- Remaining mobile wire-value adoption includes preserving exact amounts until presentation and
  using shared serialization before canonicalization/hashing. It is not part of this core change.

New vocabulary is written here in the same change that introduces it. Follow the
[README](../README.md) for executable API examples and [MOBILE.md](MOBILE.md) for platform adoption.
