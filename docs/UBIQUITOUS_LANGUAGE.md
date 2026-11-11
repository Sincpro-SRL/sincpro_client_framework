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

| Word               | Meaning                                                                            | Backend                                          | Client core                                                                    |
| ------------------ | ---------------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------ |
| Bounded context    | Owns one model, dependencies and use-case registrations; it is a bus               | `UseFramework(name)`                             | `new BoundedContext<Dependencies>(name)`                                       |
| Command            | A request for work, not a fact already confirmed                                   | DTO class                                        | `class Request extends Command<Result>`                                        |
| Response           | The result of that execution, not of all later event consumers                     | DTO, object, list or None                        | DTO, object, page, primitive or void; `Response` is an optional class base     |
| Feature            | Executes one registered operation                                                  | `feature(Command)(Service)`                      | `feature(Command)(Service)` or standard decorator syntax                       |
| ApplicationService | Composes Features of its own context                                               | `app_service(Command)(Service)`                  | `appService(Command)(Service)`                                                 |
| Feature bus        | Executes only Features in the current generation, under its parent execution       | `self.feature_bus`                               | `this.featureBus`                                                              |
| Dependencies       | Registered adapters, available as typed service attributes                         | `add_dependency`, `self.client`                  | `addDependency`, `this.client`                                                 |
| Generation         | One snapshot of registrations, adapters and service instances                      | Built lazily; in-flight work keeps its snapshot  | Same; `buildRootBus()` and `fresh()` are explicit                              |
| Use case           | One operation run through the bus, with one execution and span                     | A registered DTO                                 | A registered Command                                                           |
| Error handler      | Answers a failure instead of raising it; throwing hands it to the next one         | `add_global_error_handler`, `add_feature_…`      | `addGlobalErrorHandler`, `addFeatureErrorHandler`, `addAppServiceErrorHandler` |
| Expected error     | An error the bounded context declares the business answering: not reported         | `ignore_sentry_exceptions(*types)`               | `expectErrors(...types)`: the run ends `refused`                               |
| Domain event       | A fact that already happened, executed by its subscriber through the bus           | `DomainEvent`, `name`, `bus(event)`              | `class X extends DomainEvent`, `static eventName`, `execute(event)`            |
| Subscriber         | The Feature or ApplicationService registered for an event class, one per BC        | `feature(EventClass)(Service)`                   | `feature(EventClass)(Service)`                                                 |
| Replacement        | A service that takes the place of the one registered for a class                   | `feature(dto, replaces=Service)`                 | `feature(dto, { replaces: Service })`, `handlerOf(dto)`                        |
| Interceptor        | Control around a run: look, veto, adjust (same class) or answer                    | `@bus.interceptor(*commands)`                    | `interceptor(...classes)(fn)`, `withoutInterceptor(fn)`                        |
| Listener           | Observation of a run: it started, answered, or a failure escaped; never changes it | `on_start`, `on_completion`, `on_failure`        | `onStart`, `onCompletion`, `onFailure`                                         |
| Extension          | A component wired into a bounded context in one place                              | `bus.extend(fn)`                                 | `extend(fn)`                                                                   |
| Publisher          | What a Feature holds to put events into a queue, bound to its run                  | `Publisher(queue)`                               | `new Publisher(queue)`                                                         |
| Subscriber         | Executes an event in every bounded context that hears it                           | `Subscriber(*buses)`                             | `new Subscriber(...contexts)`                                                  |
| Queue              | What carries an event: in the call, or durably — the platform's                    | `Queue`, `SyncQueue`, `BackgroundQueue`          | `EventQueue` port, `syncQueue`                                                 |
| Envelope           | What travels beside an event: name, id, flow and cause                             | `Envelope`, the event's own chain fields         | `Envelope`: `correlationId`, `causationId`                                     |
| Correlation        | The flow a run or event belongs to; causation, what directly caused it             | `correlation_id`, `causation_id`                 | `execution.correlationId`, `execution.causationId`                             |
| Stored queue       | Stores an event, then delivers it in order: retries, sets aside, never twice       | `Forwarding` (held and forwarded in order)       | `storedQueue({ store, subscriber })`                                           |
| Event store        | Where a stored queue keeps its events — the platform's technology                  | the queue's own storage, the event table         | `EventStore` port, `memoryEventStore()`                                        |
| Set aside          | Delivered no more: a failure every attempt would repeat (the dead-letter queue)    | `PERMANENT`, set aside by the forwarding         | `state: "set_aside"`                                                           |
| Process listeners  | Hear every bounded context of the process at once                                  | the process's start/completion/failure listeners | `processListeners.onStart/onCompletion/onFailure`                              |
| Circuit breaker    | Stops calling what keeps failing; one call tries again after its time              | `CircuitBreaker`, `CircuitOpen`, `COUNTED`       | `CircuitBreaker`, `CircuitOpen`, `COUNTED_KINDS`, `guardedTransport`           |

## Remote contracts are not local services

| Word             | Meaning                                                                                 |
| ---------------- | --------------------------------------------------------------------------------------- |
| Client contract  | What a remote service publishes: models, operations, input/output schemas and bindings  |
| Generated client | A typed remote adapter made over a Transport; injectable into a local Feature           |
| Generated DTO    | A compile-time type from that contract — never a class, never on the local bus          |
| Domain event     | A fact a context recorded, known by its wire `name`; in the contract only on `--events` |
| Recorded event   | One of the context's own events: its aggregates record it                               |
| Handled event    | An event a Feature of the context is registered for: it subscribes                      |
| `DomainEvent`    | The generated union of a contract's events, narrowed by `name`                          |
| Mapping Entity   | The remote descriptor exported as `Entity`, used for routes, fields and commands        |
| Transport        | The remote boundary: REST, memory, or a separately implemented platform adapter         |

Local classes may implement generated DTO types, but a generated client is not automatically
an ApplicationService or registered local executor. A history response containing event records
is not an event bus. Authority of local/remote rules is explicit; synchronization is separate.
A generated DTO and a local Command may share the backend's name: import the generated ones
under their own (`import type * as remote`). A backend leaves its domain events out of the
contract unless it is exported with them (`export-client-contract --events`); the generator then
writes each as a type and `DomainEvent` as their union. Generating types, not classes, is the
rule: the wire is JSON, and the local bus routes only the application's own Command classes.

## Process, context and telemetry

| Word          | Meaning                                                                                        |
| ------------- | ---------------------------------------------------------------------------------------------- |
| Process       | Ports configured once at application startup through `configureProcess`                        |
| Context       | Values an execution runs with: process, bounded context, then explicit scope                   |
| ContextStore  | Synchronous values/version/subscription port; persistence belongs to the platform              |
| Execution     | One run: id, service identity, context snapshot, span and parent                               |
| Tracer        | Opens a span; the application supplies/export configures its implementation                    |
| ErrorReporter | Reports unexpected failures with trace/execution correlation                                   |
| Outcome       | `ok`, `refused`, `aborted` or `failed`; a business refusal is not an incident                  |
| Failure       | What an error is: `kind`, `nextStep`, retryable, permanent, fault — `failureOf(error)`         |
| Failure kind  | The backend's twelve (`invalid` … `internal`), the same on every wire; an error may declare it |
| Cancellation  | `execute(…, { signal })`: the run, its Features and its requests end `aborted`                 |
| Logger        | Structured records tagged by layer and execution; not a synonym for Tracer or ErrorReporter    |
| Log layer     | `infrastructure`, `adapter`, `bounded_context`, `application_service` or `feature`             |

Span names use `<bounded context>/<serviceName>` and use-case identity
`<bounded context>.<serviceName>`. Stable metadata is required because a production build can
rename JavaScript classes. Wire identities for persisted messages are a separate future contract.

Context travels per call, never in a global async stack. An injected generated client is bound
through `BIND` and propagates trace/context headers; an unrelated direct call has no automatic
execution span. The generator does not add an independent HTTP span.

Every logger shares one configurable engine. Console is the default: all development
layers/levels by default, no production output, and per-layer INFO/DEBUG masks that do not hide
development WARN/ERROR. Other destinations have their own policies. A LayerLogger writes to the
process's Logger port. The application layer imports none: a bounded context has its own
(`project.logger`, as the backend's `bus.logger`) and a run hands `this.logger`, bound to its
execution. Only `logger` (infrastructure, the global one) and `loggerAdapter` are predefined;
they carry the run only when injected as a dependency. `configureProcess({ logger })` and
`configureLogger(...)` take the same `LoggerConfiguration`; the second replaces only logging.
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
- Decorators (standard or legacy `experimentalDecorators`) need a compiler transform; function
  registration needs none.
- Invalid dependency replacement is rejected here, unlike the backend's warning-and-replace
  fallback. Multi-DTO registrations (`feature([CommandX, EventY])`), handler placements
  (`before=`) and `without_error_handler` are not implemented.
- An event's wire name is declared (`static eventName`); the backend defaults it to the class's
  name, which a client's minifier would change. `name` is reserved on both sides.
- An event's chain travels in its `Envelope`, beside it; the backend's `DomainEvent` carries
  `correlation_id` and `causation_id` as fields. A local event class holds only what happened.
- Interceptors are functions, ordered by registration; the backend also has class interceptors
  with injected dependencies, `before=`/`after=`/`sequence=` and `replaces=`. Listeners are per
  bounded context; the backend also has process-wide ones and `publish_*` to a Publisher.
- Backend/client tracing attribute naming must evolve together when its canonical vocabulary
  changes; `sincpro.context` currently identifies the bounded context.
- Web and mobile adopt it in their own releases. Mobile keeps SQLite, workers, outbox/DLQ,
  lifecycle and telemetry delivery; its platform kernel composes bounded contexts and is not a
  second application-service core.
- Python's DTOs are pydantic classes that validate; the generated client DTOs are types that do
  not. Validation on the client would be a generated reader, added when a use needs it.

New vocabulary is written here in the same change that introduces it. Follow the
[README](../README.md) for executable API examples and [MOBILE.md](MOBILE.md) for platform adoption.
