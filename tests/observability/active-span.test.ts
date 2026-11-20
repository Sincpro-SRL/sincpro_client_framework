import assert from "node:assert/strict";

import { context, trace, TraceFlags } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
  TracerProvider,
} from "@opentelemetry/sdk-trace";
import {
  ApplicationService,
  BoundedContext,
  Command,
  configureProcess,
  Feature,
} from "@sincpro/client-framework";
import {
  openTelemetryTracer,
  type OpenTelemetryTracerOptions,
} from "@sincpro/client-framework/opentelemetry";
import { afterEach, beforeEach, test } from "vitest";

/**
 * A server's process: OpenTelemetry's context follows its awaits, as `NodeSDK` or `@vercel/otel`
 * register it — the span a platform makes active (Next.js around a render) is there for the code
 * it runs.
 */
beforeEach(() => {
  configureProcess();
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
});
afterEach(() => context.disable());

/** What the application builds — its provider, its tracer — and what its platform does around
 *  a request: a span of its own, active while the page renders. */
function application(options?: OpenTelemetryTracerOptions) {
  const exporter = new InMemorySpanExporter();
  const provider = new TracerProvider({
    spanProcessors: [new SimpleSpanProcessor({ exporter })],
  });
  const tracer = provider.getTracer("an-application");
  configureProcess({ tracer: openTelemetryTracer(tracer, options) });
  return {
    spans: () => exporter.getFinishedSpans(),
    render: <T>(page: string, run: () => Promise<T>): Promise<T> =>
      tracer.startActiveSpan(page, async (span) => {
        try {
          return await run();
        } finally {
          span.end();
        }
      }),
  };
}

class WaitCommand extends Command<number> {
  constructor(readonly ms: number) {
    super();
  }
}
class TwiceCommand extends Command<number> {
  constructor(readonly ms: number) {
    super();
  }
}
class ElsewhereCommand extends Command<number> {}

class Wait extends Feature<WaitCommand, number> {
  async execute(command: WaitCommand) {
    await new Promise((done) => setTimeout(done, command.ms));
    return command.ms;
  }
}

class Twice extends ApplicationService<TwiceCommand, number> {
  async execute(command: TwiceCommand) {
    await this.featureBus.execute(new WaitCommand(command.ms));
    return this.featureBus.execute(new WaitCommand(command.ms));
  }
}

/** A span something else made active inside the use case — a library's, a request's. */
const ELSEWHERE = {
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
  spanId: "00f067aa0ba902b7",
  traceFlags: TraceFlags.SAMPLED,
};

class Elsewhere extends ApplicationService<ElsewhereCommand, number> {
  execute() {
    return context.with(trace.setSpanContext(context.active(), ELSEWHERE), () =>
      this.featureBus.execute(new WaitCommand(1)),
    );
  }
}

const project = new BoundedContext("project");
project.feature(WaitCommand)(Wait);
project.appService(TwiceCommand)(Twice);
project.appService(ElsewhereCommand)(Elsewhere);

function named(spans: ReadableSpan[], name: string): ReadableSpan[] {
  return spans.filter((one) => one.name === name);
}

function one(spans: ReadableSpan[], name: string): ReadableSpan {
  const [found, ...more] = named(spans, name);
  assert.ok(found, `no span ${name}`);
  assert.equal(more.length, 0, `more than one span ${name}`);
  return found;
}

function assertChild(child: ReadableSpan, parent: ReadableSpan): void {
  assert.equal(child.spanContext().traceId, parent.spanContext().traceId);
  assert.equal(child.parentSpanContext?.spanId, parent.spanContext().spanId);
}

test("adoptActiveSpan: a use case run while a page renders is the render's child — one trace", async () => {
  const { spans, render } = application({ adoptActiveSpan: true });
  assert.equal(await render("GET /cursos", () => project.execute(new TwiceCommand(1))), 1);
  const page = one(spans(), "GET /cursos");
  const twice = one(spans(), "project/Twice");
  assertChild(twice, page);
  // Its Features keep the parent they are given — their ApplicationService, not the render.
  const waits = named(spans(), "project/Wait");
  assert.equal(waits.length, 2);
  for (const wait of waits) assertChild(wait, twice);
});

test("without the option, a use case starts a trace of its own whatever is active, as before", async () => {
  const { spans, render } = application();
  await render("GET /cursos", () => project.execute(new TwiceCommand(1)));
  const page = one(spans(), "GET /cursos");
  const twice = one(spans(), "project/Twice");
  assert.equal(twice.parentSpanContext, undefined);
  assert.notEqual(twice.spanContext().traceId, page.spanContext().traceId);
  for (const wait of named(spans(), "project/Wait")) assertChild(wait, twice);
});

test("a run given a parent keeps it, even when another span is active where it starts", async () => {
  const { spans, render } = application({ adoptActiveSpan: true });
  await render("GET /cursos", () => project.execute(new ElsewhereCommand()));
  const elsewhere = one(spans(), "project/Elsewhere");
  const wait = one(spans(), "project/Wait");
  assertChild(wait, elsewhere);
  assert.notEqual(wait.spanContext().traceId, ELSEWHERE.traceId);
});

test("a run that continues a delivered message keeps the message's trace, not the active one", async () => {
  const { spans, render } = application({ adoptActiveSpan: true });
  const traceId = "0af7651916cd43dd8448eb211c80319c";
  const spanId = "b7ad6b7169203331";
  await render("GET /cursos", () =>
    project.execute(new WaitCommand(1), {
      cause: { id: "m-1", correlationId: "c-1", traceparent: `00-${traceId}-${spanId}-01` },
    }),
  );
  const wait = one(spans(), "project/Wait");
  assert.equal(wait.spanContext().traceId, traceId);
  assert.equal(wait.parentSpanContext?.spanId, spanId);
});

test("a span given a parent that traces nothing stays at the root — never the active span", () => {
  const exporter = new InMemorySpanExporter();
  const provider = new TracerProvider({
    spanProcessors: [new SimpleSpanProcessor({ exporter })],
  });
  const otel = provider.getTracer("an-application");
  const tracer = openTelemetryTracer(otel, { adoptActiveSpan: true });
  const silent = { traceId: "", spanId: "", sampled: false, set: () => {}, end: () => {} };
  otel.startActiveSpan("GET /cursos", (page) => {
    tracer.start("project/Wait", { parent: silent }).end("ok");
    page.end();
  });
  const wait = one(exporter.getFinishedSpans(), "project/Wait");
  assert.equal(wait.parentSpanContext, undefined);
});

test("two runs at once, each inside its own render, never take each other's span", async () => {
  const { spans, render } = application({ adoptActiveSpan: true });
  // The slow one starts first and ends last: the other runs entirely between its awaits.
  await Promise.all([
    render("GET /a", () => project.execute(new TwiceCommand(8))),
    render("GET /b", () => project.execute(new TwiceCommand(1))),
  ]);
  const runs = named(spans(), "project/Twice");
  assert.equal(runs.length, 2);
  for (const page of [one(spans(), "GET /a"), one(spans(), "GET /b")]) {
    const tree = spans().filter(
      (span) => span.spanContext().traceId === page.spanContext().traceId,
    );
    assert.deepEqual(tree.map((span) => span.name).sort(), [
      page.name,
      "project/Twice",
      "project/Wait",
      "project/Wait",
    ]);
    const twice = one(tree, "project/Twice");
    assertChild(twice, page);
    for (const wait of named(tree, "project/Wait")) assertChild(wait, twice);
  }
});

test("with no context manager — a browser that registers none — the option changes nothing", async () => {
  context.disable();
  const { spans, render } = application({ adoptActiveSpan: true });
  await render("GET /cursos", () => project.execute(new TwiceCommand(1)));
  const page = one(spans(), "GET /cursos");
  const twice = one(spans(), "project/Twice");
  assert.equal(twice.parentSpanContext, undefined);
  assert.notEqual(twice.spanContext().traceId, page.spanContext().traceId);
});
