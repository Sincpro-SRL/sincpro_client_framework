import assert from "node:assert/strict";

import {
  BoundedContext,
  combineLoggers,
  Command,
  configureLogger,
  configureProcess,
  Feature,
  type LayerLogger,
  logger as infrastructure,
  loggerAdapter,
  processContext,
  TransportError,
} from "@sincpro/client-framework";
import {
  memoryLogger,
  memoryReporter,
  memoryTracer,
} from "@sincpro/client-framework/testing";
import { afterEach, beforeEach, test, vi } from "vitest";

import {
  CommandCancelIssue,
  CommandRequestCancellation,
  type ProjectDependencies,
  projectOf,
} from "../support/core";

function application() {
  const dependencies: ProjectDependencies = {
    client: {
      async cancelIssue(dto) {
        return { issue_id: dto.issue_id, resolution: "cancelled" };
      },
      async sendIssue(dto) {
        return { issue_id: dto.issue_id, run_id: "r", status: dto.message };
      },
    },
    access: { requireCancellation() {} },
  };
  return { context: projectOf(dependencies), dependencies };
}

beforeEach(() => configureProcess({ logger: { engine: false } }));
afterEach(() => {
  configureProcess({ logger: { engine: false } });
  vi.restoreAllMocks();
});

test("the predefined loggers are the infrastructure's and the adapters' — nothing of the application layer", async () => {
  const framework = await import("@sincpro/client-framework");
  const predefined = Object.keys(framework).filter((name) => /^logger/.test(name));
  assert.deepEqual(predefined.sort(), ["logger", "loggerAdapter"]);
  const engine = memoryLogger();
  configureLogger({ engine });
  infrastructure.info("Database opened");
  loggerAdapter.info("Printer answered", { ms: 12 });
  assert.deepEqual(
    engine.records.map((record) => [record.layer, record.message]),
    [
      ["infrastructure", "Database opened"],
      ["adapter", "Printer answered"],
    ],
  );
  assert.ok(engine.records.every((record) => record.executionId === undefined));
});

test("loggers imported before the process is configured read its sink when they write", () => {
  const engine = memoryLogger();
  configureProcess({ logger: { engine } });
  loggerAdapter.info("stored", { rows: 2 });
  assert.equal(engine.records.length, 1);
  assert.deepEqual(engine.records[0]?.attributes, { rows: 2 });
  assert.equal(engine.records[0]?.traceId, undefined);
});

test("a bounded context has its own logger, named after it, outside any use case", () => {
  const engine = memoryLogger();
  configureProcess({ logger: { engine } });
  const catalog = new BoundedContext("catalog");
  catalog.logger.info("Catalog preloaded");
  assert.deepEqual(engine.records[0], {
    timestamp: engine.records[0]?.timestamp,
    level: "info",
    layer: "bounded_context",
    message: "Catalog preloaded",
    boundedContext: "catalog",
  });
});

test("each service execution emits start/end records with its own trace and span", async () => {
  const engine = memoryLogger();
  const tracer = memoryTracer();
  configureProcess({ logger: { engine }, tracer });
  const { context } = application();
  await context.execute(new CommandRequestCancellation("x"));
  assert.deepEqual(
    engine.records.map((record) => [record.event, record.layer, record.level]),
    [
      ["execution.started", "application_service", "debug"],
      ["execution.started", "feature", "debug"],
      ["execution.finished", "feature", "info"],
      ["execution.finished", "application_service", "info"],
    ],
  );
  for (const record of engine.records) {
    const span = tracer.spans.find((candidate) => candidate.spanId === record.spanId);
    assert.ok(span);
    assert.equal(record.traceId, span.traceId);
    assert.equal(record.executionId, span.attributes["sincpro.execution_id"]);
    assert.equal(record.boundedContext, "project");
    if (record.event === "execution.finished") {
      assert.equal(record.outcome, "ok");
      assert.ok(record.durationMs !== undefined && record.durationMs >= 0);
    }
  }
});

class LogCommand extends Command<void> {
  constructor(readonly token = "do-not-log-this-dto") {
    super();
  }
}
class LogFeature extends Feature<LogCommand, void> {
  static readonly serviceName = "LogFeature";
  declare readonly adapterLogger: LayerLogger;
  async execute() {
    await Promise.resolve();
    this.logger.info("Business milestone", { count: 1 });
    this.adapterLogger.warn("Adapter milestone");
  }
}

function logging(name: string) {
  const context = new BoundedContext<{ adapterLogger: LayerLogger }>(name);
  context.addDependency("adapterLogger", loggerAdapter);
  context.feature(LogCommand)(LogFeature);
  return context;
}

test("this.logger and an injected predefined logger carry the run after awaits", async () => {
  const engine = memoryLogger();
  const tracer = memoryTracer();
  configureProcess({ logger: { engine }, tracer });
  await logging("layers").execute(new LogCommand());
  const written = engine.records.filter((record) => !record.event);
  assert.deepEqual(
    written.map((record) => [record.layer, record.useCase]),
    [
      ["feature", "layers.LogFeature"],
      ["adapter", "layers.LogFeature"],
    ],
  );
  assert.ok(written.every((record) => record.executionId === engine.records[0]?.executionId));
  assert.ok(written.every((record) => record.spanId === tracer.spans[0]?.spanId));
});

test("automatic records do not include DTOs, results, errors or session context", async () => {
  const engine = memoryLogger();
  configureProcess({ logger: { engine } });
  processContext.set({ authorization: "do-not-log-session" });
  await logging("privacy").execute(new LogCommand());
  const { context: failing, dependencies } = application();
  failing.addDependency(
    "client",
    {
      ...dependencies.client,
      async cancelIssue() {
        throw new Error("do-not-log-error-body");
      },
    },
    { replaces: dependencies.client },
  );
  await assert.rejects(failing.execute(new CommandCancelIssue("do-not-log-id")));
  const text = JSON.stringify(engine.records);
  for (const marker of [
    "do-not-log-this-dto",
    "do-not-log-session",
    "do-not-log-error-body",
    "do-not-log-id",
  ]) {
    assert.equal(text.includes(marker), false);
  }
  assert.ok(engine.records.every((record) => !("context" in record) && !("error" in record)));
});

test("failure, refusal and abort levels follow the execution outcome, not console settings", async () => {
  const engine = memoryLogger();
  const reporter = memoryReporter();
  configureProcess({ logger: { engine }, reporter });
  const outcomes = [
    { error: new Error("unexpected"), outcome: "failed", level: "error" },
    { error: new TransportError("/x", 409, null), outcome: "refused", level: "warn" },
    {
      error: Object.assign(new Error("stop"), { name: "AbortError" }),
      outcome: "aborted",
      level: "info",
    },
  ];
  for (const expected of outcomes) {
    const { context, dependencies } = application();
    context.addDependency(
      "client",
      {
        ...dependencies.client,
        async cancelIssue() {
          throw expected.error;
        },
      },
      { replaces: dependencies.client },
    );
    await assert.rejects(context.execute(new CommandCancelIssue("x")));
    const finished = engine.records.at(-1);
    assert.equal(finished?.outcome, expected.outcome);
    assert.equal(finished?.level, expected.level);
  }
  assert.equal(reporter.reports.length, 1);
});

test("concurrent executions never borrow another run's logging identity", async () => {
  const engine = memoryLogger();
  const tracer = memoryTracer();
  configureProcess({ logger: { engine }, tracer });
  const context = logging("parallel");
  await Promise.all([context.execute(new LogCommand()), context.execute(new LogCommand())]);
  const started = engine.records.filter((record) => record.event === "execution.started");
  assert.equal(started.length, 2);
  assert.notEqual(started[0]?.executionId, started[1]?.executionId);
  assert.notEqual(started[0]?.traceId, started[1]?.traceId);
  for (const start of started) {
    const records = engine.records.filter(
      (record) => record.executionId === start.executionId,
    );
    assert.equal(records.length, 4);
    assert.ok(
      records.every(
        (record) => record.traceId === start.traceId && record.spanId === start.spanId,
      ),
    );
  }
});

test("sync and async sink failures neither fail business work nor block another sink", async () => {
  const engine = memoryLogger();
  const reporter = memoryReporter();
  configureProcess({
    logger: {
      engine: combineLoggers(
        {
          log() {
            throw new Error("console unavailable");
          },
        },
        {
          async log() {
            throw new Error("destination unavailable");
          },
        },
        engine,
      ),
    },
    reporter,
  });
  const { context } = application();
  assert.equal((await context.execute(new CommandCancelIssue("x"))).resolution, "cancelled");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(engine.records.length, 2);
  assert.equal(reporter.reports.length, 0);
});

test("logging can be explicitly disabled for a fresh process configuration", async () => {
  const engine = memoryLogger();
  configureProcess({ logger: { engine } });
  const { context } = application();
  await context.execute(new CommandCancelIssue("x"));
  assert.equal(engine.records.length, 2);
  configureProcess({ logger: { engine: false } });
  await context.execute(new CommandCancelIssue("x"));
  assert.equal(engine.records.length, 2);
});

test("execution duration is recorded without requiring a metrics SDK", async () => {
  const engine = memoryLogger();
  configureProcess({ logger: { engine } });
  vi.spyOn(Date, "now").mockReturnValueOnce(1000).mockReturnValue(1025);
  const { context } = application();
  await context.execute(new CommandCancelIssue("x"));
  assert.equal(engine.records.at(-1)?.durationMs, 25);
});

test("explicit structured attributes are copied at the logging boundary", () => {
  const engine = memoryLogger();
  configureProcess({ logger: { engine } });
  const attributes = { count: 1 };
  loggerAdapter.info("Result", attributes);
  attributes.count = 2;
  assert.equal(engine.records[0]?.attributes?.count, 1);
});

test("logger is reserved execution state, not a replaceable service dependency", () => {
  const context = new BoundedContext<{ logger: LayerLogger }>("reserved");
  assert.throws(() => context.addDependency("logger", infrastructure), /Reserved/);
});

test("already imported loggers follow a centrally replaced engine", () => {
  const first = memoryLogger();
  const next = memoryLogger();
  configureLogger({ engine: first });
  loggerAdapter.info("First engine");
  configureLogger({ engine: next });
  loggerAdapter.info("Next engine");
  assert.deepEqual(
    first.records.map((record) => record.message),
    ["First engine"],
  );
  assert.deepEqual(
    next.records.map((record) => record.message),
    ["Next engine"],
  );
});

test("an invalid engine is rejected without replacing the active engine", () => {
  const engine = memoryLogger();
  configureLogger({ engine });
  assert.throws(
    () =>
      configureLogger({
        // @ts-expect-error Runtime JavaScript can supply a malformed engine.
        engine: {},
      }),
    /implement log/,
  );
  loggerAdapter.info("Still using the configured engine");
  assert.equal(engine.records.length, 1);
});

test("console is the default engine without per-logger construction or configuration", () => {
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  configureProcess();
  loggerAdapter.info("Default console");
  assert.equal(output.mock.calls.length, 1);
  assert.match(String(output.mock.calls[0]?.[0]), /\[adapter\] INFO/);
  configureLogger({ engine: false });
  loggerAdapter.info("Disabled");
  assert.equal(output.mock.calls.length, 1);
  configureLogger();
  loggerAdapter.info("Console restored");
  assert.equal(output.mock.calls.length, 2);
});

test("configureProcess and configureLogger take the same logging configuration", () => {
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  configureProcess({ logger: { mode: "development", layers: { adapter: false } } });
  loggerAdapter.info("Hidden by the mask");
  infrastructure.info("Shown");
  configureLogger({ mode: "development", layers: { adapter: false } });
  loggerAdapter.info("Hidden by the same mask");
  infrastructure.info("Shown again");
  assert.deepEqual(
    output.mock.calls.map((call) => call[1]),
    ["Shown", "Shown again"],
  );
});

test("central production configuration silences the default engine", () => {
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  configureLogger({ mode: "production" });
  loggerAdapter.info("Quiet in production");
  infrastructure.error("Also quiet in production");
  assert.equal(output.mock.calls.length, 0);
  assert.equal(errors.mock.calls.length, 0);
});

test("changing only the logger preserves tracing, reporting and process context", async () => {
  const engine = memoryLogger();
  const tracer = memoryTracer();
  const reporter = memoryReporter();
  configureProcess({ tracer, reporter, logger: { engine: false } });
  processContext.set({ tenant_id: "acme" });
  configureLogger({ engine });
  const { context, dependencies } = application();
  context.addDependency(
    "client",
    {
      ...dependencies.client,
      async cancelIssue() {
        throw new Error("failed");
      },
    },
    { replaces: dependencies.client },
  );
  await assert.rejects(context.execute(new CommandCancelIssue("x")), /failed/);
  assert.deepEqual(processContext.values, { tenant_id: "acme" });
  assert.equal(tracer.spans.length, 1);
  assert.equal(reporter.reports.length, 1);
  assert.equal(engine.records.length, 2);
  assert.equal(engine.records[0]?.traceId, tracer.spans[0]?.traceId);
});
