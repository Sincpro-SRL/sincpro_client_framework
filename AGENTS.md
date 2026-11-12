# AGENTS.md — working on @sincpro/client-framework

Rules for any agent (or person) changing this package. Read [`MANIFESTO.md`](MANIFESTO.md) first:
it says what this package is responsible for and what it is not. This file is how to keep it.

## Before you change anything

- **Read the manifesto.** A piece that serves nothing there does not go in; a piece it forbids
  does not either. If you think it should, change the manifesto first and say why.
- **Look at the backend.** This package mirrors sincpro_framework (`~/dev/sincpro_framework`):
  the bounded context and its dependencies, `Feature`, `ApplicationService`, the context and its
  store, the process, the span per use case. When in doubt about a
  word or a behaviour, read how the backend does it, not memory.
- **Use the shared words.** [`docs/UBIQUITOUS_LANGUAGE.md`](docs/UBIQUITOUS_LANGUAGE.md) is the
  vocabulary of every Sincpro framework. A new word, or a word that changes, goes there in the
  same pull request; a word in its «do not use» table never enters code or docs.
- **Look at who uses it.** @sincpro/web-framework (`~/dev/sincpro_web_framework`) and
  @sincpro/mobile (`~/dev/mobile/sincpro_mobile`). A piece only one of them needs, and that
  needs a platform, belongs there.

## Where things go

Each module is laid out as sincpro_framework's are: `domain/` (ports, types and rules),
`adapters/` (implementations of the ports), `services/` (what uses them), `infrastructure/`
(the process's state and technical support) and `entrypoint/` (the doors a caller uses). A
module has only the layers it needs, and says what it offers in its own `index.ts`.

| Folder               | What                                                                                            |
| -------------------- | ----------------------------------------------------------------------------------------------- |
| `src/common/`        | The values of the wire: ids, a day and an instant, `Decimal`, `Money`, `valuesOf` / `rebuilt`   |
| `src/context/`       | `ContextStore`, codec, `Execution` (domain); memory and plain codec; `Context`; the process's   |
| `src/observability/` | Tracer/ErrorReporter/Logger ports; console, memory, OpenTelemetry, Sentry; loggers, reporting   |
| `src/client/`        | `Transport`, `entity()`, the contract (domain); REST, memory, Parquet; discovery, propagation   |
| `src/model/`         | Model definitions: `defineMeta`, from a JSON Schema, the store of known ones                    |
| `src/core/`          | DTOs and events, bus, services, handlers, extension points; pipeline; `BoundedContext`; process |
| `src/event_driven/`  | `Envelope`, messages, `EventQueue`/`Subscribes` ports; queues; `Publisher`, `Subscriber`        |
| `src/codegen/`       | The generator and its CLI (`sincpro-client generate`) — the only place Node is allowed          |
| `src/testing/`       | The public entry of the in-memory observability adapters                                        |
| `tests/`             | vitest in Node, one folder per module; `tests/support/` holds fakes and forge's contracts       |

## Hard rules (the build enforces them — `make doctor`)

- **Platform-neutral.** No React, no `react-native`, no web-ui, no composer, no @sincpro/mobile;
  no `document`, `window`, `localStorage`, `navigator`. What a platform must give, it gives
  through a port.
- **Node only in the generator.** `node:` imports, `process` and `Buffer` live in `src/codegen/`
  and nowhere else; nothing an application runs imports `codegen/`.
- **Self-imports, no extensions.** Inside `src/`, import `@sincpro/client-framework/<path>` —
  never a relative path, never `.ts`.
- **Domain inward.** A `domain/` folder imports only other `domain/` folders: no adapter,
  service, infrastructure or entrypoint.
- **Vendors in their entry.** A vendor's SDK is imported only in its optional entry
  (`observability/adapters/opentelemetry.ts`, `observability/adapters/sentry.ts`,
  `client/adapters/parquet.ts`), and nothing in `src/` imports one.

## Conventions

- Code, comments and docs in English: this package is open source.
- `Context:` blocks at the top of a file are the design record: why it is the way it is. Keep
  them true.
- A change ships with a test in `tests/` that fails without it, run in Node.
- Public means exported from `src/index.ts`. No side effects at import (`sideEffects: false`).
- A port (an `interface`) only where there are two implementations; a class or a type otherwise.

## Known traps

- **A run sees the instance through a view of its own.** Inside a method, each dependency
  (`this.client`), `this.context` and `this.featureBus` are that run's — bound to its execution. So a
  service declares no `#private` fields (they refuse the view); use TypeScript's `private`.
- **A service is a singleton of its generation.** What a method writes on `this` lands on the
  instance, shared by the next call, the call beside it and every `scoped` variant — as in
  sincpro_framework. What belongs to one request goes in its arguments or its context.
- **A service's name is the framework's, taken at registration.** A standard decorator hands it
  the class's name as the code wrote it (`context.name`, untouched by a minifier); otherwise the
  class's `name` — so a production build keeps class names (`keep_classnames`, `keepNames`).
  `class Cancel` gives `project/Cancel`, identity `project.Cancel`. Nothing on a service declares
  it. Commands and events route by exact constructor identity — a generated one by its identity
  or wire name.
- **An event's name is declared; a Command's identity is the framework's.** `static eventName` is
  required and dotted (`<context>.<aggregate>.vN.<fact>`); `name` is reserved for it. A Command's
  identity is given when a bounded context registers it — `<context>.<Command>`, the backend's
  `registered_name`, the key a generated contract carries —; `static commandName` fixes another.
- **A replacement names what it replaces.** `feature(dto, { replaces: Service })` is refused
  unless `Service` is registered now for each DTO listed — all of them or none; its spans carry
  `sincpro.replaces`.
- **A service takes N DTOs; a DTO has one service.** `feature([CommandX, EventY])`, as the
  backend's `DTORegistration`; one instance per service and generation.
- **Dependencies are the context's.** `servicesWith<Dependencies>()` gives the bases every
  dependency typed — the backend's `class Feature(_Feature, DependencyContextType)` —; a service
  never declares one. A scaffold writes `dependencies.ts` and `framework.ts`; the instance lives in
  `framework.ts` because ES modules run their imports first.
- **How events are carried is here; where they are kept is the platform's.** An event's
  consumers are acknowledged apart: a bounded context's use case for it (one per bounded context,
  keyed by its name), its event handlers and a subscriber's (`<owner>/<Handler>`). `storedQueue`
  holds the rules — store first, deliver in order, retry what may succeed, set aside what never
  will, never run one consumer twice — over an `EventStore` the platform plugs (SQLite,
  IndexedDB, memory). A store only keeps records; it never decides.
- **The Subscriber is the queue's entrypoint, and it is composite.** One per queue — never one
  per handler —, created once like a bounded context (`new Subscriber<D>("app")`,
  `handlersWith<D>()`). It pulls what the queue delivers, rebuilds it (an event by name, a Command
  by identity) and hands it to every consumer subscribed to it: its own event handlers, and the
  buses added to it — each with its use case for the event and its own handlers. Two levels, never
  mixed: `addDependency("x", value)` is what its handlers find on `this` (a bus they call is a
  dependency); `addBus(bus)` — no name, the bus's namespace — is a bus it delivers to. The same
  bus added again changes nothing; another bus of the same name is delivered to as well
  (`sales#2`). A Command from a queue runs only when declared (`commands`), in the one bus that
  registered it; `CommandNotConsumed` otherwise.
- **An event has three kinds of consumers, one API.** Its use case on a bus
  (`@bus.feature([CommandX, Event])`, the event is its input); an event handler of a bus
  (`@bus.handler([EventA, EventB])`, a layer above its use cases: the bus's dependencies and
  `this.boundedContext`); an event handler of a subscriber (`@subscriber.handler([...])`, its
  explicit dependencies). A handler decides nothing — it executes Commands —; it runs in the
  pipeline of a use case, in its own layer (`event_handler`), and is registered with or without a
  decorator.
- **Messages are the backend's: CloudEvents 1.0.** One shape for Commands and events — `type` is
  the event's name or the Command's identity —; the route differs (N buses, or the one that
  registered it, when declared). `readMessage` reads structured and binary mode (`ce_` headers),
  as `Envelope.of`. A delivered message's `correlationid`, `causationid` and `traceparent` become
  the run's `Cause`: its flow and its trace continue. Written and read only through
  `eventMessageOf`/`commandMessageOf`, `readMessage` and `eventFrom`/`commandFrom`.
- **A cron is a platform's, and not every platform has one.** Mobile's scheduler wakes a closed
  app (`CronWorker`, its job a Command); a browser runs nothing in a closed tab, so on the web a
  refresh is a screen's and scheduled work is the backend's. No cron piece lives here until web
  needs one — then a registry and a `Scheduler` port.
- **A bounded context injected into a run is bound to it** (`BIND`): what it executes is a child
  of the caller — span, flow, cause, signal, one report — with its own dependencies, context and
  handlers. A failure keeps the outcome where it first failed, so a caller does not report what
  the callee expected.
- **A bounded context is named for what it is.** `salesBoundedContext`, never `sales` (an
  entity?) and never `ctx` or `bc`: `context` is already the run's. The scaffold writes it so.
- **A circuit belongs where the dependency is.** `CircuitBreaker` (in the process's memory, the
  backend's semantics: `COUNTED_KINDS`, half-open with one probe) guards a transport
  (`guardedTransport`) or an adapter; its `CircuitOpen` declares `unavailable` and a wait, so
  nothing else needs to know a circuit exists.
- **Delivery is at least once.** A stored message may run twice after a crash. The use case keys
  its effect by `this.execution.causationId` (the message's id) or by the entity the event names.
  `maxAttempts` sets aside what keeps failing. One process drains a store. `execution` is
  reserved.
- **A failure says its kind, whatever the wire.** `failureOf` reads a declared `failureKind`, the
  `Problem` (the same over REST, JSON-RPC and gRPC), then a REST status. A transport of another
  wire, or another backend's adapter, declares the kind with `kindOfGrpcCode` /
  `kindOfJsonRpcCode` / `kindOfHttpStatus` — never a table of its own. Retrying, setting aside,
  reporting and the outcome all follow from it.
- **A run can be cancelled.** `execute(…, { signal })`: it ends `aborted` at once, its Features
  inherit the signal, `this.signal` reads it, and a bound transport sends it with every request.
  `signal` is reserved, like `context` and `logger`.
- **No variable named `process`.** `make doctor` reads `process.` as Node outside `codegen/`.
- **A run belongs to a flow.** `correlationId` is shared by every run and event of one flow;
  `causationId` names what directly caused it. A dependency carrying `BIND` (the `Publisher`)
  is bound to the run, so what it publishes joins that flow with nothing passed by hand.
- **The pipeline is closed for modification, open for extension.** Change the flow in
  `executeService` only for every run; what one application needs goes through an interceptor
  (control, inside the run, keeps the class), a listener (observation, never changes the
  answer, its failure ignored) or `extend`.
- **Dependency declarations do not register anything.** Service bases declare typed attributes
  from a shared dependency interface. Only `addDependency` supplies runtime values; a missing
  dependency fails explicitly.
- **Decorators are optional.** Function registration must work without any decorator
  transform. Standard and legacy (`experimentalDecorators`) fixtures are compiled explicitly in
  tests; do not claim Metro (Babel) or web bundler support without testing those configurations.
- **A run binds what says it can be bound, never what looks like a transport.** A dependency is
  bound when it carries `BIND` (a generated client, `restOperations`, `jsonRpcOperations`,
  `guardedTransport`, `bindableOperations(…)` for a platform's own) or is a REST `Transport`.
  An object is never taken for an `OperationTransport` because it has a `call`: an Odoo client's
  is `call(service, method, args)`, and binding it hid `setServer` and rewrote its `args` — only
  with a trace to carry, so never in a test without a tracer. Binding wraps only the wire's
  methods; the dependency's state, methods and getters stay its own (`keeping`).
- **The trace reaches the wire through the dependencies.** A dependency is bound to the run when it
  is a `Transport` or carries `BIND` (every generated client does, through `bindable`); anything
  else is handed as it is. A client built elsewhere and closed over sends no trace.
- **The process is read on every call, never at import.** `project` is defined when its module
  loads, before `main` runs `configureProcess`; nothing may capture the tracer, the reporter or the
  store at definition time. `configureProcess` replaces everything at once — a test calls it in
  `beforeEach` and starts with an empty context.
- **A store's `load` may answer a new object each time** (one that parses JSON does): `Context`
  keeps one object per `version`, so a screen can hand `values` to `useSyncExternalStore`. A store
  that changes without moving the version is a broken store.
- **The generated client never names a wire.** A method is `transport.call(operations.X, input,
options)`: no route, no verb, no RPC method. The contract's bindings (`rest`, `rpc`, `grpc`,
  `mcp`) are data in `operations`; an `OperationTransport` adapter reads the one of its wire
  (`restOperations`, `jsonRpcOperations`, a platform's gRPC) and throws `OperationNotPublished`
  for the rest. A run binds an `OperationTransport` as it binds a `Transport`: headers and signal.
  The REST `Transport` stays for `restOperations` and for screens (`entity()`, pages, drafts).
- **What is generated is types, never classes.** A generated DTO is the remote contract: a
  class extending `Command` could be registered on the local bus, which is what keeps a remote
  operation and a local use case apart. Runtime knowledge goes in data (`operations`, `events`);
  validating or converting what arrives would be a generated reader, not a class.
- **Events come only from the contract.** The generator writes event types and `DomainEvent`
  only when the backend exported its contract with `--events`; a contract without them writes
  the same bytes as before.
- **What the generator writes is compared byte for byte** (`tests/support/forge-contract/`, out
  of prettier and eslint). After changing the generator on purpose, run `make codegen-fixtures`
  and read the diff.
- **A module name the generator writes is built in parts** (`codegen/domain/names.ts`, `FRAMEWORK`): the
  build's `tsc-alias` rewrites this package's specifiers inside strings too.
- **An adapter wraps what the application built, never builds it.** `openTelemetryTracer` takes
  the app's tracer, `sentryReporter` the app's client: no `register()`, no `Sentry.init()`, no
  endpoint or DSN here, nothing read from the environment. A vendor's SDK is imported only in
  its optional entry, and nothing else imports one (`make doctor`).
- **A span nothing records claims no trace.** OpenTelemetry's API with no provider answers an
  all-zeros span: the adapter gives no ids, so no `traceparent` of zeros reaches the server.
- **Reported means unexpected.** A `TransportError` the server answered with a 4xx is `refused`,
  an `AbortError` is `aborted`; neither is reported (`outcomeOf`). A bounded context adds its own
  with `expectErrors(...)`; a process replaces the rule with `ProcessOptions.outcomeOf`. Never
  catch in a Feature to hide a failure.
- **An error handler answers; it does not observe.** The failure is recorded where it happened —
  span, log line, report — before the layer's handlers run, as in sincpro_framework. A handler
  returns the answer or throws to the next; the global chain wraps only `execute` and `scoped`.
- **The application layer imports no logger.** A bounded context has `projectBoundedContext.logger`; a run
  hands `this.logger`, bound to its execution. Only `logger` (infrastructure, the global one) and
  `loggerAdapter` are predefined; injected as a dependency they bind to the run (`BIND`), imported
  at module level they do not. No logger is predefined for an application layer. Console is the
  default engine; `configureProcess({ logger })` and `configureLogger(...)` take the same
  `LoggerConfiguration`. The host chooses production explicitly. Never log DTOs, results or the
  full session context automatically.
- **A failure is described once, as sincpro_framework's failure line** (`PRD_03 §6`,
  `observability/failure.py`). The run where it was raised writes its type, kind, fault and —
  when nobody expected it — its message, the use case's own line (`at`) and its stack; a run it
  crosses says only `failedIn`. Its span records the exception; the spans it crosses take the
  error status. An expected failure is information: type and kind, never its message (it may
  carry the caller's data) nor a stack. `sincpro.outcome` is `ok` or the failure's kind, beside
  `sincpro.fault` and `error.type`, on the span and in GlitchTip.
- **Who is running is on every signal** (`configureProcess({ identity })`, `PRD_03 §4.10`):
  `release`, the run's `tenant` and `user_id`. Tenant and user are optional, and so are their
  keys — `identity.keys` names the context keys an application uses (`company_id`, `tenant_ids`);
  nothing is sent when its context says none. Nothing else of the context is copied.
- **Observability never fails a use case.** Every tracer, logger and reporter call is shielded:
  a collector down, Loki unreachable or no network leave the run's own answer — or its own error —
  untouched.

- **Only what is transversal comes here.** A value's wire form (a decimal as text, a day never
  an instant, a money with its currency) is the backend's contract, the same on every platform,
  so it lives in `src/common/`. How a value is shown to a person, typed in an input, or kept in
  SQLite or IndexedDB is the platform's — @sincpro/web-framework's or @sincpro/mobile's.
- **A decimal never becomes a `number`.** It travels as text and is computed with `Decimal` or
  `Money` (exact, on `BigInt`); `Number(...)` or `parseFloat` on an amount is the float the
  backend sends text to avoid. And a day is never a `Date`: a `Date` is an instant.
- **The in-memory server copies by the wire's rules** (`valuesOf` → `readValues`): what it receives
  and answers is what a real server would — a `Money` as `{ amount, currency }`, a `Date` as text.

## Before you hand it back

```bash
make verify-format   # eslint --fix + prettier + typecheck + doctor
make test
make build
```

Never bump `version` in `package.json` — the release pipeline does. Commit on a working branch,
never on `main`: a change reaches `main` through a pull request, and further changes of the same
work go into that one pull request.
