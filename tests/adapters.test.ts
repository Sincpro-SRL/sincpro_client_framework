import assert from "node:assert/strict";

import { trace } from "@opentelemetry/api";
import {
  AlwaysOffSampler,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
} from "@opentelemetry/sdk-trace";
import {
  ApplicationService,
  configureProcess,
  Feature,
  processContext,
  restTransport,
  TransportError,
  UseBoundedContext,
} from "@sincpro/client-framework";
import { openTelemetryTracer } from "@sincpro/client-framework/opentelemetry";
import { type ExceptionClient, sentryReporter } from "@sincpro/client-framework/sentry";
import { beforeEach, test } from "vitest";

/** What the application builds with its own configuration — never this package. */
function applicationProvider(options: { sampler?: AlwaysOffSampler } = {}) {
  const exporter = new InMemorySpanExporter();
  const provider = new TracerProvider({
    spanProcessors: [new SimpleSpanProcessor({ exporter })],
    ...(options.sampler ? { sampler: options.sampler } : {}),
  });
  return { exporter, tracer: openTelemetryTracer(provider.getTracer("an-application")) };
}

beforeEach(() => configureProcess());

class Wait extends Feature {
  async for(ms: number) {
    await new Promise((done) => setTimeout(done, ms));
    return ms;
  }
}

class Fail extends Feature {
  async execute() {
    throw new TypeError("undefined is not a function");
  }
}

class Refuse extends Feature {
  async execute() {
    throw new TransportError("/issues/1", 409, null);
  }
}

class Both extends ApplicationService<Record<never, never>, { Wait: typeof Wait }> {
  async execute() {
    await this.feature.Wait.for(1);
    return this.feature.Wait.for(1);
  }
}

const project = new UseBoundedContext("project").register({
  features: { Wait, Fail, Refuse },
  applicationServices: { Both },
});

test("an ApplicationService and its Features are one OpenTelemetry trace, parent to children", async () => {
  const { exporter, tracer } = applicationProvider();
  configureProcess({ tracer });
  await project.Both.execute();
  const spans = exporter.getFinishedSpans();
  const parent = spans.find((one) => one.name === "project/Both");
  const children = spans.filter((one) => one.name !== "project/Both");
  assert.deepEqual(
    children.map((one) => one.name),
    ["project/Wait.for", "project/Wait.for"],
  );
  for (const child of children) {
    assert.equal(child.spanContext().traceId, parent?.spanContext().traceId);
    assert.equal(child.parentSpanContext?.spanId, parent?.spanContext().spanId);
    assert.equal(child.attributes["sincpro.outcome"], "ok");
  }
  assert.equal(parent?.attributes["sincpro.layer"], "application_service");
});

test("a failure is an error with its exception; a refusal is an outcome, never an error", async () => {
  const { exporter, tracer } = applicationProvider();
  configureProcess({ tracer });
  await assert.rejects(project.Fail.execute());
  await assert.rejects(project.Refuse.execute());
  const [failed, refused] = exporter.getFinishedSpans();
  assert.equal(failed?.status.code, 2); // ERROR
  assert.equal(failed?.events[0]?.name, "exception");
  assert.equal(refused?.status.code, 0); // UNSET: the business answered
  assert.equal(refused?.attributes["sincpro.outcome"], "refused");
});

type Sent = Record<string, string>;
const recording = (sent: Sent[]): typeof fetch =>
  (async (_url: string, init?: RequestInit) => {
    sent.push({ ...(init?.headers as Sent) });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

type Asking = { transport: ReturnType<typeof restTransport> };

class Ask extends Feature<Asking> {
  execute() {
    return this.transport.send("POST", "/issues", {});
  }
}

/** A bounded context whose one service asks a server that keeps what each request carried. */
function asking(sent: Sent[]) {
  return new UseBoundedContext<Asking>("project")
    .addDependency("transport", restTransport({ document: null, fetch: recording(sent) }))
    .register({ features: { Ask } });
}

test("the request carries the span OpenTelemetry recorded — the id the backend continues", async () => {
  const sent: Sent[] = [];
  const { exporter, tracer } = applicationProvider();
  configureProcess({ tracer });
  await asking(sent).Ask.execute();
  const [span] = exporter.getFinishedSpans();
  const ids = span?.spanContext();
  assert.equal(sent[0]?.["traceparent"], `00-${ids?.traceId}-${ids?.spanId}-01`);
});

test("with OpenTelemetry's API and no provider, nothing is claimed: no ids, no traceparent", async () => {
  const sent: Sent[] = [];
  configureProcess({
    tracer: openTelemetryTracer(trace.getTracer("nobody-registered-a-provider")),
  });
  await asking(sent).Ask.execute();
  assert.equal(sent[0]?.["traceparent"], undefined);
});

test("a trace the application's sampler drops is said dropped, so the backend drops it too", async () => {
  const sent: Sent[] = [];
  const { exporter, tracer } = applicationProvider({ sampler: new AlwaysOffSampler() });
  configureProcess({ tracer });
  await asking(sent).Ask.execute();
  assert.equal(exporter.getFinishedSpans().length, 0);
  assert.match(sent[0]?.["traceparent"] ?? "", /^00-[0-9a-f]{32}-[0-9a-f]{16}-00$/);
});

test("an unexpected error reaches the application's Sentry-compatible client with where it happened", async () => {
  const captured: { error: unknown; hint: unknown }[] = [];
  const client: ExceptionClient = {
    captureException: (error, hint) => void captured.push({ error, hint }),
  };
  const { tracer } = applicationProvider();
  configureProcess({ tracer, reporter: sentryReporter(client) });
  processContext.set({ tenant_id: "acme" });
  await assert.rejects(project.Fail.execute());
  await assert.rejects(project.Refuse.execute());
  assert.equal(captured.length, 1); // the refusal was the business answering
  const hint = captured[0]?.hint as {
    captureContext: {
      tags: Record<string, string>;
      contexts: { sincpro: Record<string, unknown> };
    };
  };
  assert.equal(hint.captureContext.tags["sincpro.use_case"], "project.Fail");
  assert.match(hint.captureContext.tags["trace_id"] ?? "", /^[0-9a-f]{32}$/);
  assert.deepEqual(hint.captureContext.contexts.sincpro["context"], { tenant_id: "acme" });
});
