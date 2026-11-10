import assert from "node:assert/strict";

import {
  combineLoggers,
  configureLogger,
  configureProcess,
  type LayerLogger,
  logger as globalLogger,
  loggerAdapter,
  loggerApplicationService,
  loggerCronJobs,
  loggerFeature,
  loggerFor,
  loggerQueueProcessor,
  loggerRepositories,
  loggerTransport,
  loggerUseCases,
  processContext,
  TransportError,
} from "@sincpro/client-framework";
import { BoundedContext, Command, Feature } from "@sincpro/client-framework/core";
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

beforeEach(() => configureProcess({ logger: false }));
afterEach(() => {
  configureProcess({ logger: false });
  vi.restoreAllMocks();
});

test("layer loggers created before configuration read the process sink when called", () => {
  const repositories = loggerFor("repositories");
  repositories.info("unconfigured");
  const logger = memoryLogger();
  configureProcess({ logger });
  repositories.info("stored", { rows: 2 });
  assert.equal(logger.records.length, 1);
  assert.equal(logger.records[0]?.layer, "repositories");
  assert.deepEqual(logger.records[0]?.attributes, { rows: 2 });
  assert.equal(logger.records[0]?.executionId, undefined);
  assert.equal(logger.records[0]?.traceId, undefined);
});

test("each service execution emits start/end records with its own trace and span", async () => {
  const logger = memoryLogger();
  const tracer = memoryTracer();
  configureProcess({ logger, tracer });
  const { context } = application();
  await context.execute(new CommandRequestCancellation("x"));
  assert.deepEqual(
    logger.records.map((record) => [record.event, record.layer, record.level]),
    [
      ["execution.started", "application_service", "debug"],
      ["execution.started", "feature", "debug"],
      ["execution.finished", "feature", "info"],
      ["execution.finished", "application_service", "info"],
    ],
  );
  for (const record of logger.records) {
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
  declare readonly repositoryLogger: LayerLogger;
  async execute() {
    await Promise.resolve();
    this.logger.info("Business milestone", { count: 1 });
    this.logger.forLayer("transport").debug("Transport milestone");
    this.repositoryLogger.warn("Repository milestone");
  }
}

test("built-in and injected layer loggers keep explicit execution correlation after awaits", async () => {
  const logger = memoryLogger();
  const tracer = memoryTracer();
  configureProcess({ logger, tracer });
  const context = new BoundedContext<{ repositoryLogger: LayerLogger }>("layers");
  context.addDependency("repositoryLogger", loggerRepositories);
  context.feature(LogCommand)(LogFeature);
  await context.execute(new LogCommand());
  const application = logger.records.filter((record) => !record.event);
  assert.deepEqual(
    application.map((record) => record.layer),
    ["feature", "transport", "repositories"],
  );
  assert.equal(application.length, 3);
  assert.ok(
    application.every((record) => record.executionId === logger.records[0]?.executionId),
  );
  assert.ok(application.every((record) => record.spanId === tracer.spans[0]?.spanId));
});

test("automatic records do not include DTOs, results, errors or session context", async () => {
  const logger = memoryLogger();
  configureProcess({ logger });
  processContext.set({ authorization: "do-not-log-session" });
  const context = new BoundedContext<{ repositoryLogger: LayerLogger }>("privacy");
  context.addDependency("repositoryLogger", loggerRepositories);
  context.feature(LogCommand)(LogFeature);
  await context.execute(new LogCommand());
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
  const text = JSON.stringify(logger.records);
  for (const marker of [
    "do-not-log-this-dto",
    "do-not-log-session",
    "do-not-log-error-body",
    "do-not-log-id",
  ]) {
    assert.equal(text.includes(marker), false);
  }
  assert.ok(logger.records.every((record) => !("context" in record) && !("error" in record)));
  assert.ok(
    logger.records.every(
      (record) => record.traceId === undefined && record.spanId === undefined,
    ),
  );
});

test("failure, refusal and abort levels follow the execution outcome, not console settings", async () => {
  const logger = memoryLogger();
  const reporter = memoryReporter();
  configureProcess({ logger, reporter });
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
    const finished = logger.records.at(-1);
    assert.equal(finished?.outcome, expected.outcome);
    assert.equal(finished?.level, expected.level);
  }
  assert.equal(reporter.reports.length, 1);
});

test("concurrent executions never borrow another run's logging identity", async () => {
  const logger = memoryLogger();
  const tracer = memoryTracer();
  configureProcess({ logger, tracer });
  const context = new BoundedContext<{ repositoryLogger: LayerLogger }>("parallel");
  context.addDependency("repositoryLogger", loggerFor("repositories"));
  context.feature(LogCommand)(LogFeature);
  await Promise.all([context.execute(new LogCommand()), context.execute(new LogCommand())]);
  const started = logger.records.filter((record) => record.event === "execution.started");
  assert.equal(started.length, 2);
  assert.notEqual(started[0]?.executionId, started[1]?.executionId);
  assert.notEqual(started[0]?.traceId, started[1]?.traceId);
  for (const start of started) {
    const records = logger.records.filter(
      (record) => record.executionId === start.executionId,
    );
    assert.equal(records.length, 5);
    assert.ok(
      records.every(
        (record) => record.traceId === start.traceId && record.spanId === start.spanId,
      ),
    );
  }
});

test("sync and async sink failures neither fail business work nor block another sink", async () => {
  const logger = memoryLogger();
  const reporter = memoryReporter();
  configureProcess({
    logger: combineLoggers(
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
      logger,
    ),
    reporter,
  });
  const { context } = application();
  assert.equal((await context.execute(new CommandCancelIssue("x"))).resolution, "cancelled");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(logger.records.length, 2);
  assert.equal(reporter.reports.length, 0);
});

test("logging can be explicitly disabled for a fresh process configuration", async () => {
  const logger = memoryLogger();
  configureProcess({ logger });
  const { context } = application();
  await context.execute(new CommandCancelIssue("x"));
  assert.equal(logger.records.length, 2);
  configureProcess({ logger: false });
  await context.execute(new CommandCancelIssue("x"));
  assert.equal(logger.records.length, 2);
});

test("execution duration is recorded without requiring a metrics SDK", async () => {
  const logger = memoryLogger();
  configureProcess({ logger });
  vi.spyOn(Date, "now").mockReturnValueOnce(1000).mockReturnValue(1025);
  const { context } = application();
  await context.execute(new CommandCancelIssue("x"));
  assert.equal(logger.records.at(-1)?.durationMs, 25);
});

test("explicit structured attributes are copied at the logging boundary", () => {
  const logger = memoryLogger();
  configureProcess({ logger });
  const attributes = { count: 1 };
  loggerFor("adapter").info("Result", attributes);
  attributes.count = 2;
  assert.equal(logger.records[0]?.attributes?.count, 1);
});

test("logger is reserved execution state, not a replaceable service dependency", () => {
  const context = new BoundedContext<{ logger: LayerLogger }>("reserved");
  assert.throws(() => context.addDependency("logger", loggerFor("global")), /Reserved/);
});

test("predefined loggers are usable directly from any module through one engine", () => {
  const engine = memoryLogger();
  configureLogger({ engine });
  const predefined = [
    [globalLogger, "global"],
    [loggerUseCases, "use_cases"],
    [loggerFeature, "feature"],
    [loggerApplicationService, "application_service"],
    [loggerAdapter, "adapter"],
    [loggerRepositories, "repositories"],
    [loggerTransport, "transport"],
    [loggerQueueProcessor, "event_bus"],
    [loggerCronJobs, "cron"],
  ] as const;
  for (const [logger] of predefined) logger.info("Module initialized");
  assert.deepEqual(
    engine.records.map((record) => record.layer),
    predefined.map(([, layer]) => layer),
  );
});

test("already imported loggers follow a centrally replaced engine", () => {
  const first = memoryLogger();
  const next = memoryLogger();
  configureLogger({ engine: first });
  loggerRepositories.info("First engine");
  configureLogger({ engine: next });
  loggerRepositories.info("Next engine");
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
  loggerRepositories.info("Still using the configured engine");
  assert.equal(engine.records.length, 1);
});

test("console is the default engine without per-logger construction or configuration", () => {
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  configureProcess();
  loggerRepositories.info("Default console");
  assert.equal(output.mock.calls.length, 1);
  assert.match(String(output.mock.calls[0]?.[0]), /\[repositories\] INFO/);
  configureLogger({ engine: false });
  loggerRepositories.info("Disabled");
  assert.equal(output.mock.calls.length, 1);
  configureLogger();
  loggerRepositories.info("Console restored");
  assert.equal(output.mock.calls.length, 2);
});

test("central production configuration silences the default engine", () => {
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  configureLogger({ mode: "production" });
  loggerAdapter.info("Quiet in production");
  loggerUseCases.error("Also quiet in production");
  assert.equal(output.mock.calls.length, 0);
  assert.equal(errors.mock.calls.length, 0);
});

test("changing only the logger preserves tracing, reporting and process context", async () => {
  const engine = memoryLogger();
  const tracer = memoryTracer();
  const reporter = memoryReporter();
  configureProcess({ tracer, reporter, logger: false });
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
