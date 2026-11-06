# @sincpro/client-framework

**The client side of [sincpro_framework](https://github.com/Sincpro-SRL/sincpro_framework), for
every platform.** Write a use case once — a `Feature`, or an `ApplicationService` that composes
Features — and run it in a browser, on a phone, in a server-side render, in a script or in a test.
Every use case is traced and every unexpected error reported, continuing the backend's trace,
without its author writing either. A service's client contract becomes typed code for each of
its domains.

> **Status: in construction.** The repository is founded; the first cut is under way. Read the
> [manifesto](MANIFESTO.md) for what this package is responsible for, what it is not and where it
> is going.

## Where it sits

```text
@sincpro/criteria           the contract with the server
        ▲
@sincpro/client-framework   use cases · interceptors · context · ports · domains · the client
        ▲
@sincpro/web-framework      the web          @sincpro/mobile      a phone
```

No React, no DOM, no platform: what a platform must provide — how a span is exported, where an
error is reported — it plugs through a port.

## Development

Node 26 (`nvm use`).

```bash
make init            # pre-commit + dependencies
make test            # vitest, in Node
make verify-format   # format + lint + doctor; fails if the tree is left dirty (what CI runs)
make build           # tsc into dist/
```

`make doctor` enforces what the type checker cannot: the source imports itself, never a relative
path; no React, no UI, no browser global; Node only inside the generator. Read
[`AGENTS.md`](AGENTS.md) before changing anything, and [`CONTRIBUTING.md`](CONTRIBUTING.md)
before opening a pull request.

## CI/CD

Every workflow in `.github/workflows/` delegates to
[`Sincpro-SRL/.github`](https://github.com/Sincpro-SRL/.github) and only calls `make` targets:
checks on every pull request and push to `main`, a release draft on `main`, publication to npm
when a release is published, and notifications. The version is written by the release pipeline,
never by hand.

## License

[MIT](LICENSE)
