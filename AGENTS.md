# AGENTS.md — working on @sincpro/client-framework

Rules for any agent (or person) changing this package. Read [`MANIFESTO.md`](MANIFESTO.md) first:
it says what this package is responsible for and what it is not. This file is how to keep it.

## Before you change anything

- **Read the manifesto.** A piece that serves nothing there does not go in; a piece it forbids
  does not either. If you think it should, change the manifesto first and say why.
- **Look at the backend.** This package mirrors sincpro_framework (`~/dev/sincpro_framework`):
  `Feature`, `ApplicationService`, the context, the span per use case. When in doubt about a
  word or a behaviour, read how the backend does it, not memory.
- **Look at who uses it.** @sincpro/web-framework (`~/dev/sincpro_web_framework`) and
  @sincpro/mobile (`~/dev/mobile/sincpro_mobile`). A piece only one of them needs, and that
  needs a platform, belongs there.

## Where things go

| Folder               | What                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------- |
| `src/client/`        | The seam with a server: `Transport`, REST, memory, `entity()`, the client contract, ids     |
| `src/model/`         | Model definitions: `defineMeta`, from a JSON Schema, the store of known ones                |
| `src/services/`      | `Feature`, `ApplicationService`, the runtime, the execution and what binds to it            |
| `src/observability/` | The ports a platform plugs: `Tracer`, `ErrorReporter`                                       |
| `src/codegen/`       | The generator and its CLI (`sincpro-client generate`) — the only place Node is allowed      |
| `src/adapters/`      | Optional entries over a vendor (`./opentelemetry`, `./sentry`): the only place one is named |
| `src/testing/`       | `memoryTracer`, `memoryReporter` — the ports in memory, for tests                           |
| `tests/`             | vitest in Node; `tests/support/` holds the fake domains and forge's real contracts          |

## Hard rules (the build enforces them — `make doctor`)

- **Platform-neutral.** No React, no `react-native`, no web-ui, no composer, no @sincpro/mobile;
  no `document`, `window`, `localStorage`, `navigator`. What a platform must give, it gives
  through a port.
- **Node only in the generator.** `node:` imports, `process` and `Buffer` live in `src/codegen/`
  and nowhere else; nothing in the runtime imports `codegen/`.
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

- **A run sees the instance through a view of its own.** Inside a method, `this.deps`,
  `this.context` and `this.features` are that run's — bound to its execution. So a Feature keeps
  nothing of a request on `this`, and declares no `#private` fields (they refuse the view); use
  TypeScript's `private`.
- **A span is named by the key, not the class** (`bindServices(runtime, "project", { sendIssue })`
  → `project/sendIssue`; an ApplicationService's Features by their keys too): a production build
  renames classes. Only an unbound Feature falls back to its class name.
- **The trace reaches the wire through `deps`.** A dependency is bound to the run when it is a
  `Transport` or carries `BIND` (every generated client does, through `bindable`); anything else
  is handed as it is. A client built outside `deps` and closed over sends no trace.
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
  `RuntimeOptions.outcomeOf`, never by catching in a Feature.

## Before you hand it back

```bash
make verify-format   # eslint --fix + prettier + typecheck + doctor
make test
make build
```

Never bump `version` in `package.json` — the release pipeline does. Never commit; a person
does.
