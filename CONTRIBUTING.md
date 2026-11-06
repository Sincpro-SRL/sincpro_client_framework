# Contributing

## Getting set up

```bash
make init
make test
```

Node 26 (`nvm use`). `make test` runs vitest in Node: the package runs on every platform, so it
is proven where no platform helps.

## Before you open a pull request

```bash
make verify-format
make test
make build
```

`make verify-format` formats, lints, type-checks and runs `doctor`, then fails if any of that left
the tree dirty — the same check CI runs.

## What a good change looks like

- **It serves the [manifesto](MANIFESTO.md).** Read [`AGENTS.md`](AGENTS.md) too: it says what
  the build enforces.
- **A test that would fail without it.**
- **A reason in the code.** Exported symbols carry a JSDoc block saying why the thing is the way
  it is; a comment that repeats the signature is noise.
- **Platform-neutral.** No React, no DOM, no Node outside the generator — `make doctor` catches
  it.

## Versions

Versions are set by the release pipeline, never by hand in a pull request. A breaking change says
so in its commit (`feat!:` and a `BREAKING CHANGE:` footer); the release decides the number.
