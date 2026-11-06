# @sincpro/client-framework

**The client side of [sincpro_framework](https://github.com/Sincpro-SRL/sincpro_framework), for
every platform.** Write a use case once — a `Feature`, or an `ApplicationService` that composes
Features — and run it in a browser, on a phone, in a server-side render, in a script or in a test.
Every use case is traced and every unexpected error reported, continuing the backend's trace,
without its author writing either. A service's client contract becomes typed code for each of
its domains.

> **Status: 0.x, the first cut.** The API may still change before 1.0. In: the client, the
> generator, `Feature` and `ApplicationService` with their interceptors, and the ports for tracing
> and error reporting. Read the [manifesto](MANIFESTO.md) for what this package is responsible
> for, what it is not and where it is going.

## A use case, traced and reported by default

```ts
import {
  ApplicationService,
  bindServices,
  createRuntime,
  Feature,
} from "@sincpro/client-framework";

class SendIssue extends Feature<{ project: ProjectClient }> {
  execute(input: dto.CommandSendIssue) {
    return this.deps.project.sendIssue(input); // carries this run's traceparent
  }
}

class CloseIssue extends ApplicationService<{ preview: PreviewClose; send: SendIssue }> {
  async execute(input: CloseIssueInput) {
    const preview = await this.features.preview.execute(input); // a child span
    if (preview.warnings.length > 0) return { blocked: preview };
    return this.features.send.execute({ ...input, message: "closed" }); // another child
  }
}

const runtime = createRuntime({ tracer, reporter, context: () => ({ tenant_id: "acme" }) });
const project = bindServices(runtime, "project", {
  closeIssue: new CloseIssue({ preview: new PreviewClose(deps), send: new SendIssue(deps) }),
});
await project.closeIssue.execute(input); // project/closeIssue → project/preview, project/send
```

`tracer` and `reporter` are the platform's: OpenTelemetry and GlitchTip in a browser, a queue on
a phone, `memoryTracer()` and `memoryReporter()` (`@sincpro/client-framework/testing`) in a test.
A use case that was never bound runs too, with nothing tracing.

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
