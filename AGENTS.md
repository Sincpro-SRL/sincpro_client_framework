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

| Folder               | What                                                                                          |
| -------------------- | --------------------------------------------------------------------------------------------- |
| `src/common/`        | The values of the wire: ids, a day and an instant, `Decimal`, `Money`, `valuesOf` / `rebuilt` |
| `src/client/`        | The seam with a server: `Transport`, REST, memory, `entity()`, the client contract            |
| `src/model/`         | Model definitions: `defineMeta`, from a JSON Schema, the store of known ones                  |
| `src/services/`      | `UseBoundedContext`, `Feature`, `ApplicationService`, the process, the execution              |
| `src/context/`       | The `ContextStore` port, `memoryContexts`, and `Context` — one level of it                    |
| `src/observability/` | The ports a platform plugs: `Tracer`, `ErrorReporter`                                         |
| `src/codegen/`       | The generator and its CLI (`sincpro-client generate`) — the only place Node is allowed        |
| `src/adapters/`      | Optional entries over a vendor (`./opentelemetry`, `./sentry`): the only place one is named   |
| `src/testing/`       | `memoryTracer`, `memoryReporter` — the ports in memory, for tests                             |
| `tests/`             | vitest in Node; `tests/support/` holds the fake domains and forge's real contracts            |

## Hard rules (the build enforces them — `make doctor`)

- **Platform-neutral.** No React, no `react-native`, no web-ui, no composer, no @sincpro/mobile;
  no `document`, `window`, `localStorage`, `navigator`. What a platform must give, it gives
  through a port.
- **Node only in the generator.** `node:` imports, `process` and `Buffer` live in `src/codegen/`
  and nowhere else; nothing an application runs imports `codegen/`.
- **Self-imports, no extensions.** Inside `src/`, import `@sincpro/client-framework/<path>` —
  never a relative path, never `.ts`.

## Conventions

- Code, comments and docs in English: this package is open source.
- `Context:` blocks at the top of a file are the design record: why it is the way it is. Keep
  them true.
- A change ships with a test in `tests/` that fails without it, run in Node.
- Public means exported from `src/index.ts`. No side effects at import (`sideEffects: false`).
- A port (an `interface`) only where there are two implementations; a class or a type otherwise.

## Known traps

- **A run sees the instance through a view of its own.** Inside a method, each dependency
  (`this.client`), `this.context` and `this.feature` are that run's — bound to its execution. So a
  service declares no `#private` fields (they refuse the view); use TypeScript's `private`.
- **A service is a singleton of its bounded context.** What a method writes on `this` lands on the
  instance, shared by the next call, the call beside it and every `with`/`scoped` variant — as in
  sincpro_framework. What belongs to one request goes in its arguments or its context.
- **A span is named by the registered name, not the class** (`register({ features: { Issues } })`
  → `project/Issues.close`, identity `project.Issues.close`): a production build renames classes,
  never the keys of an object.
- **The dependencies are typed, not declared.** `BaseFeature<ProjectDependencies>` types
  `this.client` from an interface, which does not exist at run time; the bounded context answers
  whatever was added with `addDependency`. A dependency nobody added reads `undefined`.
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
- **What the generator writes is compared byte for byte** (`tests/support/forge-contract/`, out
  of prettier and eslint). After changing the generator on purpose, run `make codegen-fixtures`
  and read the diff.
- **A module name the generator writes is built in parts** (`codegen/names.ts`, `FRAMEWORK`): the
  build's `tsc-alias` rewrites this package's specifiers inside strings too.
- **An adapter wraps what the application built, never builds it.** `openTelemetryTracer` takes
  the app's tracer, `sentryReporter` the app's client: no `register()`, no `Sentry.init()`, no
  endpoint or DSN here, nothing read from the environment. A vendor's SDK is imported only in
  `src/adapters/`, and nothing else imports an adapter (`make doctor`).
- **A span nothing records claims no trace.** OpenTelemetry's API with no provider answers an
  all-zeros span: the adapter gives no ids, so no `traceparent` of zeros reaches the server.
- **Reported means unexpected.** A `TransportError` the server answered with a 4xx is `refused`,
  an `AbortError` is `aborted`; neither is reported (`outcomeOf`). Change that with
  `ProcessOptions.outcomeOf`, never by catching in a Feature.

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

Never bump `version` in `package.json` — the release pipeline does. Never commit; a person
does.
