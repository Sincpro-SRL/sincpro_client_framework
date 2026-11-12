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
  BoundedContext,
  Command,
  configureProcess,
  Feature,
  processContext,
  restTransport,
  TransportError,
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

class WaitCommand extends Command<number> {
  constructor(readonly ms: number) {
    super();
  }
}
class FailCommand extends Command<never> {}
class RefuseCommand extends Command<never> {}
class BothCommand extends Command<number> {}

class Wait extends Feature<WaitCommand, number> {
  async execute(command: WaitCommand) {
    await new Promise((done) => setTimeout(done, command.ms));
    return command.ms;
  }
}

class Fail extends Feature<FailCommand, never> {
  async execute(): Promise<never> {
    throw new TypeError("undefined is not a function");
  }
}

class Refuse extends Feature<RefuseCommand, never> {
  async execute(): Promise<never> {
    throw new TransportError("/issues/1", 409, null);
  }
}

class Both extends ApplicationService<BothCommand, number> {
  async execute() {
    await this.featureBus.execute(new WaitCommand(1));
    return this.featureBus.execute(new WaitCommand(1));
  }
}

const project = new BoundedContext("project");
project.feature(WaitCommand)(Wait);
project.feature(FailCommand)(Fail);
project.feature(RefuseCommand)(Refuse);
project.appService(BothCommand)(Both);

test("an ApplicationService and its Features are one OpenTelemetry trace, parent to children", async () => {
  const { exporter, tracer } = applicationProvider();
  configureProcess({ tracer });
  await project.execute(new BothCommand());
  const spans = exporter.getFinishedSpans();
  const parent = spans.find((one) => one.name === "project/Both");
  const children = spans.filter((one) => one.name !== "project/Both");
  assert.deepEqual(
    children.map((one) => one.name),
    ["project/Wait", "project/Wait"],
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
  await assert.rejects(project.execute(new FailCommand()));
  await assert.rejects(project.execute(new RefuseCommand()));
  const [failed, refused] = exporter.getFinishedSpans();
  assert.equal(failed?.status.code, 2); // ERROR
  assert.equal(failed?.events[0]?.name, "exception");
  // sincpro_framework's keys: the outcome is the failure's kind, with its fault and its type.
  assert.equal(failed?.attributes["sincpro.outcome"], "internal");
  assert.equal(failed?.attributes["sincpro.fault"], true);
  assert.equal(failed?.attributes["error.type"], "TypeError");
  assert.equal(refused?.status.code, 0); // UNSET: the business answered
  assert.equal(refused?.attributes["sincpro.outcome"], "conflict");
  assert.equal(refused?.attributes["sincpro.fault"], false);
  assert.equal(refused?.attributes["error.type"], "TransportError");
  assert.equal(refused?.events.length, 0, "an expected answer records no exception");
});

type Sent = Record<string, string>;
const recording = (sent: Sent[]): typeof fetch =>
  (async (_url: string, init?: RequestInit) => {
    sent.push({ ...(init?.headers as Sent) });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

type Asking = { transport: ReturnType<typeof restTransport> };

class AskCommand extends Command<unknown> {}
class Ask extends Feature<AskCommand, unknown> {
  declare readonly transport: Asking["transport"];
  execute() {
    return this.transport.send("POST", "/issues", {});
  }
}

/** A bounded context whose one service asks a server that keeps what each request carried. */
function asking(sent: Sent[]) {
  const context = new BoundedContext<Asking>("project").addDependency(
    "transport",
    restTransport({ document: null, fetch: recording(sent) }),
  );
  context.feature(AskCommand)(Ask);
  return context;
}

test("the request carries the span OpenTelemetry recorded — the id the backend continues", async () => {
  const sent: Sent[] = [];
  const { exporter, tracer } = applicationProvider();
  configureProcess({ tracer });
  await asking(sent).execute(new AskCommand());
  const [span] = exporter.getFinishedSpans();
  const ids = span?.spanContext();
  assert.equal(sent[0]?.["traceparent"], `00-${ids?.traceId}-${ids?.spanId}-01`);
});

test("with OpenTelemetry's API and no provider, nothing is claimed: no ids, no traceparent", async () => {
  const sent: Sent[] = [];
  configureProcess({
    tracer: openTelemetryTracer(trace.getTracer("nobody-registered-a-provider")),
  });
  await asking(sent).execute(new AskCommand());
  assert.equal(sent[0]?.["traceparent"], undefined);
});

test("a trace the application's sampler drops is said dropped, so the backend drops it too", async () => {
  const sent: Sent[] = [];
  const { exporter, tracer } = applicationProvider({ sampler: new AlwaysOffSampler() });
  configureProcess({ tracer });
  await asking(sent).execute(new AskCommand());
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
  await assert.rejects(project.execute(new FailCommand()));
  await assert.rejects(project.execute(new RefuseCommand()));
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
