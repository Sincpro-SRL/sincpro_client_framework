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

## Before you hand it back

```bash
make verify-format   # eslint --fix + prettier + typecheck + doctor
make test
make build
```

Never bump `version` in `package.json` — the release pipeline does. Never commit; a person
does.
