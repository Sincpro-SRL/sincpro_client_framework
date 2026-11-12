# Ubiquitous language

One vocabulary for sincpro_framework (Python), @sincpro/client-framework (TypeScript),
@sincpro/web-framework and @sincpro/mobile. The backend is the semantic reference; a language
limitation must be named and tested rather than hidden behind a different architecture.

## Application execution

```text
Entrypoint -> BoundedContext.execute(Command | event) -> Feature or ApplicationService -> Response
(a screen,                                                  |
 a cron,                                     featureBus.execute(Command)
 the queue's Subscriber)                                    |
                                                         Feature
```

| Word               | Meaning                                                                                      | Backend                                            | Client core                                                                    |
| ------------------ | -------------------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------ |
| Bounded context    | Owns one model, dependencies and use-case registrations; it is a bus                         | `UseFramework(name)`                               | `const salesBoundedContext = new BoundedContext<Dependencies>("sales")`        |
| Entrypoint         | A door that calls use cases — a screen, a cron, the queue's Subscriber; it decides nothing   | REST/RPC/MCP gateways, `Crons`, `QueueGateway`     | screens, mobile's cron (`CronWorker`), `Subscriber`                            |
| Command            | A request for work to one bus, not a fact already confirmed                                  | DTO class; `registered_name` on the wire           | `class Request extends Command<Result>`; identity given at registration        |
| Response           | The result of that execution, not of all later event consumers                               | DTO, object, list or None                          | DTO, object, page, primitive or void; `Response` is an optional class base     |
| Feature            | Executes the DTOs it is registered for — one or N                                            | `feature(dto)` / `feature([dto, …])`               | `@bc.feature(dto)` / `feature([dto, …])`; named at registration                |
| ApplicationService | Composes Features of its own context                                                         | `app_service(dto)`                                 | `appService(dto)`                                                              |
| Service bases      | A context's Feature and ApplicationService, typed with its dependencies                      | `class Feature(_Feature, DependencyContextType)`   | `servicesWith<Dependencies>()` in `framework.ts`                               |
| Feature bus        | Executes only Features in the current generation, under its parent execution                 | `self.feature_bus`                                 | `this.featureBus`                                                              |
| Dependencies       | Registered adapters, available as typed service attributes, never redeclared                 | `dependencies.py`, `add_dependency`, `self.client` | `dependencies.ts`, `addDependency`, `this.client`                              |
| Generation         | One snapshot of registrations, adapters and service instances                                | Built lazily; in-flight work keeps its snapshot    | Same; `buildRootBus()` and `fresh()` are explicit                              |
| Use case           | One operation run through the bus, with one execution and span                               | A registered DTO                                   | A registered DTO: a Command, an event, a generated one                         |
| Error handler      | Answers a failure instead of raising it; throwing hands it to the next one                   | `add_global_error_handler`, `add_feature_…`        | `addGlobalErrorHandler`, `addFeatureErrorHandler`, `addAppServiceErrorHandler` |
| Expected error     | An error the bounded context declares the business answering: not reported                   | `ignore_sentry_exceptions(*types)`                 | `expectErrors(...types)`: the run ends `refused`                               |
| Domain event       | A fact that already happened, heard by N buses by its wire name                              | `DomainEvent`, `name`, `bus(event)`                | `class X extends DomainEvent`, `static eventName`, `execute(event)`            |
| Subscription       | Registering a use case for an event: one per bounded context                                 | `@bus.feature(SomeEvent)`                          | `@bc.feature(SomeEvent)`                                                       |
| Message            | A DTO as it travels: CloudEvents 1.0, `type` its name or identity, its flow and trace        | `Envelope` (CloudEvents) and the DTO's JSON        | `Message`, `readMessage`, `eventMessageOf`, `commandMessageOf`                 |
| Generated DTO      | A contract's Command or event, executed on the bus as data                                   | the DTO itself                                     | `operations.X` / `events.X` registered; `commandOf`, `RemoteEvent`             |
| Workflow           | Several use cases in order, with decisions between them: an ApplicationService               | an ApplicationService                              | an ApplicationService                                                          |
| Replacement        | A service that takes the place of the one registered for a class                             | `feature(dto, replaces=Service)`                   | `feature(dto, { replaces: Service })`, `handlerOf(dto)`                        |
| Interceptor        | Control around a run: look, veto, adjust (same class) or answer                              | `@bus.interceptor(*commands)`                      | `interceptor(...classes)(fn)`, `withoutInterceptor(fn)`                        |
| Listener           | Observation of a run: it started, answered, or a failure escaped; never changes it           | `on_start`, `on_completion`, `on_failure`          | `onStart`, `onCompletion`, `onFailure`                                         |
| Extension          | A component wired into a bounded context in one place                                        | `bus.extend(fn)`                                   | `extend(fn)`                                                                   |
| Publisher          | What a Feature holds to put events into a queue, bound to its run                            | `Publisher(queue)`                                 | `new Publisher(queue)`                                                         |
| Subscriber         | The queue's entrypoint, composite: its handlers and the buses added, Commands only declared  | `Subscriber(*buses)`, `QueueGateway`               | `new Subscriber("app")`, `addDependency`, `addBus`, `handler([...])`           |
| Event handler      | The entrypoint an event reaches on a bus or a subscriber: executes Commands, decides nothing | a subscriber's handler                             | `EventHandler`, `@bus.handler([...])`, `@subscriber.handler([...])`            |
| Consumer           | Who an event is delivered to and acknowledged by: a use case or an event handler             | the queue's consumer                               | `EventConsumer`: `sales`, `sales/OnSalePaid`, `app/NotifySalePaid`             |
| Queue              | What carries an event: in the call, or durably — the platform's                              | `Queue`, `SyncQueue`, `BackgroundQueue`            | `MessageQueue` port, `syncQueue`                                               |
| Envelope           | What travels beside an event: name, id, flow and cause                                       | `Envelope`, the event's own chain fields           | `Envelope`: `correlationId`, `causationId`                                     |
| Correlation        | The flow a run or event belongs to; causation, what directly caused it                       | `correlation_id`, `causation_id`                   | `execution.correlationId`, `execution.causationId`                             |
| Stored queue       | Stores a message, then delivers it by its verdict: never twice                               | `Forwarding` (held and forwarded in order)         | `storedQueue({ store, subscriber })`                                           |
| Message            | What a queue carries: an event (a fact, N consumers) or a Command (an intention, one bus)    | the CloudEvents message, `@queue.consumes`         | `StoredMessage`, `kind: "event" \| "command"`                                  |
| Send               | Puts a Command in the queue: run by the bus that consumes it when it can, its answer kept    | a Command sent to a queue                          | `publisher.send(command)`, `answer`                                            |
| Message store      | Where a stored queue keeps its messages — the platform's technology                          | the queue's own storage, the event table           | `MessageStore` port, `memoryMessageStore()`                                    |
| Delivery policy    | How one message is delivered: its retries, its attempts, whether it goes over the network    | `QueueOptions(max_attempts)`                       | `DeliveryPolicy`, `policy`, `policyOf`                                         |
| Verdict            | What follows one delivery: delivered, wait, retry or set aside                               | `Verdict`, `Settlement` (`verdicts.py`)            | `verdictOf`, `combined`, `WAITING_KINDS`                                       |
| Set aside          | Delivered no more: a failure every attempt would repeat (the dead-letter queue)              | `PERMANENT`, set aside by the forwarding           | `state: "set_aside"`                                                           |
| Process listeners  | Hear every bounded context of the process at once                                            | the process's start/completion/failure listeners   | `processListeners.onStart/onCompletion/onFailure`                              |
| Circuit breaker    | Stops calling what keeps failing; one call tries again after its time                        | `CircuitBreaker`, `CircuitOpen`, `COUNTED`         | `CircuitBreaker`, `CircuitOpen`, `COUNTED_KINDS`, `guardedTransport`           |

## Remote contracts are not local services

| Word                | Meaning                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------ |
| Client contract     | What a remote service publishes: models, operations, input/output schemas and bindings     |
| Generated client    | Typed methods per remote operation, over an `OperationTransport`; injected into a Feature  |
| Remote operation    | An operation of the contract: its identity and each wire's binding (`rest`, `rpc`, `grpc`) |
| Operation transport | The port that calls an operation by who it is; one adapter per wire, injected by the app   |
| Generated DTO       | A compile-time type from that contract — never a class, never on the local bus             |
| Domain event        | A fact a context recorded, known by its wire `name`; in the contract only on `--events`    |
| Recorded event      | One of the context's own events: its aggregates record it                                  |
| Handled event       | An event the context has a use case of (a Feature registered for its class)                |
| `DomainEvent`       | The generated union of a contract's events, narrowed by `name`                             |
| Mapping Entity      | The remote descriptor exported as `Entity`, used for routes, fields and commands           |
| Transport           | REST's own port: what `restOperations` and screens (`entity()`, pages) stand on            |

Local classes may implement generated DTO types, but a generated client is not automatically
an ApplicationService or registered local executor. A history response containing event records
is not an event bus. Authority of local/remote rules is explicit; synchronization is separate.
A generated DTO and a local Command may share the backend's name: import the generated ones
under their own (`import type * as remote`). A backend leaves its domain events out of the
contract unless it is exported with them (`export-client-contract --events`); the generator then
writes each as a type and `DomainEvent` as their union. Generating types, not classes, is the
rule: the wire is JSON, and the local bus routes only the application's own Command classes.

## Process, context and telemetry

| Word                | Meaning                                                                                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Process             | Ports configured once at application startup through `configureProcess`                                                                                             |
| Identity            | Who is running: its release, and the deployment's tenant — `configureProcess({ identity })`                                                                         |
| Release             | `<name>:<version>` as deployed (the backend's `APP_RELEASE`); `service.name`/`.version` in it                                                                       |
| Tenant              | Whom a run serves: its context's, under the keys the app names (`tenant`, `tenant_id` by default; `company_id`…), else the deployment's; optional                   |
| User                | Who a run acts for: its context's `user_id` (or the key the app names); optional; GlitchTip's user                                                                  |
| Failure description | What a failed run says once, where it was raised: type, kind, fault, message, `at`, stack                                                                           |
| Context             | Values an execution runs with: process, bounded context, then explicit scope                                                                                        |
| ContextStore        | Synchronous values/version/subscription port; persistence belongs to the platform                                                                                   |
| Execution           | One run: id, service identity, context snapshot, span and parent                                                                                                    |
| Tracer              | Opens a span; the application supplies/export configures its implementation                                                                                         |
| ErrorReporter       | Reports unexpected failures with trace/execution correlation                                                                                                        |
| Outcome             | `ok`, `refused`, `aborted` or `failed`; a business refusal is not an incident                                                                                       |
| Failure             | What an error is: `kind`, `nextStep`, retryable, permanent, fault — `failureOf(error)`                                                                              |
| Failure kind        | The backend's twelve (`invalid` … `internal`), the same on every wire; an error may declare it                                                                      |
| Change              | A write that may have changed what was read: its method and route; a preview or a dry run is none                                                                   |
| Change feed         | Where writes are announced and readers follow them, so neither knows the other — `processChanges`, `follow`, `announce`                                             |
| Cancellation        | `execute(…, { signal })`: the run, its Features and its requests end `aborted`                                                                                      |
| Logger              | Structured records tagged by layer and execution; not a synonym for Tracer or ErrorReporter                                                                         |
| Log layer           | `infrastructure`, `adapter`, `bounded_context`, `application_service` or `feature`                                                                                  |
| Log filter          | Which INFO and DEBUG lines speak, by level, layer and bounded context; WARN and ERROR always do; spans are never filtered — `LogFilter`, `speaks`, `filteredLogger` |

Span names use `<bounded context>/<Service>` and use-case identity `<bounded context>.<Service>`:
the service's class name, taken by the framework when it registers it (a standard decorator's
`context.name`, untouched by a minifier; else the class's `name`, so a production build keeps
class names). An event's wire name is declared (`eventName`, dotted); a Command's identity is the
framework's too: `<context>.<Command>`, the backend's `registered_name`, given at registration.

Context travels per call, never in a global async stack. An injected generated client is bound
through `BIND` and propagates trace/context headers; an injected bounded context is bound the
same way, so what it executes is a child of the run that holds it; an unrelated direct call has
no automatic execution span. The generator does not add an independent HTTP span.

A bounded context is named for what it is — `salesBoundedContext` —, never a bare noun that reads
as an entity (`sales`) and never an abbreviation (`ctx`, `bc`): `context` is the run's
(`this.context`), and a name that can be misread will be. A subscriber is named for what it
delivers to (`appSubscriber`, `"app"`): its handlers are said `app/<Handler>`, and the stored
queue keeps who has an event by those keys.

Every logger shares one configurable engine. Console is the default: all development
layers/levels by default, no production output, and per-layer INFO/DEBUG masks that do not hide
development WARN/ERROR. Other destinations have their own policies. A LayerLogger writes to the
process's Logger port. The application layer imports none: a bounded context has its own
(`projectBoundedContext.logger`, as the backend's `bus.logger`) and a run hands `this.logger`, bound to its
execution. Only `logger` (infrastructure, the global one) and `loggerAdapter` are predefined;
they carry the run only when injected as a dependency. `configureProcess({ logger })` and
`configureLogger(...)` take the same `LoggerConfiguration`; the second replaces only logging.
Automatic lifecycle records include outcome and duration, never DTOs or full session context. A
failed run's record describes its failure once, where it was raised, as the backend does: its
type, kind, fault and, when unexpected, its message, the use case's line and its stack; an
expected failure says its type and kind only.
Every span, log record and report says who was running — its `release` and, when there is one,
its `tenant` —, the keys sincpro_framework puts on its own signals (`correlation.md`). Nothing
else of the context is copied onto them. A platform's tracer and log shipping read
`processIdentity()` for their resource and labels, so no adapter invents a key of its own.
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
  fallback. Handler placements (`before=`) and `without_error_handler` are not implemented.
- An event's wire name is declared (`static eventName`); the backend defaults it to the class's
  name, which a client's minifier would change. `name` is reserved on both sides.
- An event's chain travels in its `Envelope`, beside it; the backend's `DomainEvent` carries
  `correlation_id` and `causation_id` as fields. A local event class holds only what happened.
- Interceptors are functions, ordered by registration; the backend also has class interceptors
  with injected dependencies, `before=`/`after=`/`sequence=` and `replaces=`. Listeners are per
  bounded context; the backend also has process-wide ones and `publish_*` to a Publisher.
- An event's wire name is declared (`eventName`); the backend defaults it to the class's name.
  A Command's identity is computed as the backend's (`<context>.<Command>`), so production builds
  keep class names.
- Backend/client tracing attribute naming must evolve together when its canonical vocabulary
  changes; `sincpro.context` currently identifies the bounded context.
- Web and mobile adopt it in their own releases. Mobile keeps SQLite, workers, outbox/DLQ,
  lifecycle and telemetry delivery; its platform kernel composes bounded contexts and is not a
  second application-service core.
- Python's DTOs are pydantic classes that validate; the generated client DTOs are types that do
  not. Validation on the client would be a generated reader, added when a use needs it.

New vocabulary is written here in the same change that introduces it. Follow the
[README](../README.md) for executable API examples and [MOBILE.md](MOBILE.md) for platform adoption.
