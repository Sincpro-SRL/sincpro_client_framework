import assert from "node:assert/strict";

import {
  ApplicationService,
  BoundedContext,
  Command,
  configureProcess,
  Feature,
  Response,
} from "@sincpro/client-framework";
import {
  memoryLogger,
  memoryReporter,
  memoryTracer,
} from "@sincpro/client-framework/testing";
import { beforeEach, test } from "vitest";

class IssueNotFound extends Error {}
class IssueClosed extends Error {}

class ResponseIssue extends Response {
  constructor(readonly found: boolean) {
    super();
  }
}
class CommandFind extends Command<ResponseIssue> {
  constructor(readonly error?: Error) {
    super();
  }
}
class CommandFindTwice extends Command<ResponseIssue> {
  constructor(readonly error?: Error) {
    super();
  }
}

class Find extends Feature<CommandFind, ResponseIssue> {
  execute(command: CommandFind): ResponseIssue {
    if (command.error) throw command.error;
    return new ResponseIssue(true);
  }
}
class FindTwice extends ApplicationService<CommandFindTwice, ResponseIssue> {
  async execute(command: CommandFindTwice): Promise<ResponseIssue> {
    const first = await this.featureBus.execute(new CommandFind(command.error));
    return new ResponseIssue(first.found);
  }
}

function issues() {
  const context = new BoundedContext("issues");
  context.feature(CommandFind)(Find);
  context.appService(CommandFindTwice)(FindTwice);
  return context;
}

const notFound = (error: unknown) => {
  if (error instanceof IssueNotFound) return new ResponseIssue(false);
  throw error;
};

beforeEach(() => configureProcess({ logger: { engine: false } }));

test("a feature handler answers the failure: observed where it happened, then answered", async () => {
  const tracer = memoryTracer();
  const reporter = memoryReporter();
  const engine = memoryLogger();
  configureProcess({ tracer, reporter, logger: { engine } });
  const context = issues().addFeatureErrorHandler(notFound);
  const error = new IssueNotFound("acme-3");
  const answer = await context.execute(new CommandFind(error));
  assert.deepEqual(answer, new ResponseIssue(false));
  assert.equal(tracer.spans[0]?.outcome, "failed");
  assert.equal(reporter.reports.length, 1);
  assert.equal(reporter.reports[0]?.error, error);
  assert.deepEqual(
    engine.records.map((record) => [record.event, record.layer]),
    [
      ["execution.started", "feature"],
      ["execution.finished", "feature"],
      ["error.handled", "feature"],
    ],
  );
  assert.equal(engine.records[2]?.executionId, engine.records[0]?.executionId);
});

test("a feature handler answers inside an ApplicationService, which goes on", async () => {
  const tracer = memoryTracer();
  configureProcess({ tracer });
  const context = issues().addFeatureErrorHandler(notFound);
  const answer = await context.execute(new CommandFindTwice(new IssueNotFound()));
  assert.equal(answer.found, false);
  assert.deepEqual(
    tracer.spans.map((span) => [span.name, span.outcome]),
    [
      ["issues/FindTwice", "ok"],
      ["issues/Find", "failed"],
    ],
  );
});

test("handlers run first-registered-first; each receives what the one before it threw", async () => {
  const seen: string[] = [];
  const context = issues()
    .addAppServiceErrorHandler((error) => {
      seen.push(`first ${String((error as Error).message)}`);
      throw new IssueNotFound("mapped");
    })
    .addAppServiceErrorHandler((error) => {
      seen.push(`second ${String((error as Error).message)}`);
      return notFound(error);
    });
  const answer = await context.execute(new CommandFindTwice(new Error("raw")));
  assert.equal(answer.found, false);
  assert.deepEqual(seen, ["first raw", "second mapped"]);
});

test("with no handler that answers, the last error thrown reaches the caller", async () => {
  const context = issues().addFeatureErrorHandler(notFound);
  await assert.rejects(
    context.execute(new CommandFind(new Error("unexpected"))),
    /unexpected/,
  );
  const mapped = issues().addFeatureErrorHandler(() => {
    throw new IssueClosed("mapped");
  });
  await assert.rejects(mapped.execute(new CommandFind(new Error("raw"))), IssueClosed);
});

test("a global handler answers what reaches execute, after every layer's, and a scope's too", async () => {
  const order: string[] = [];
  const context = issues()
    .addFeatureErrorHandler((error) => {
      order.push("feature");
      throw error;
    })
    .addAppServiceErrorHandler((error) => {
      order.push("application_service");
      throw error;
    })
    .addGlobalErrorHandler((error) => {
      order.push("global");
      return notFound(error);
    });
  assert.equal(
    (await context.execute(new CommandFindTwice(new IssueNotFound()))).found,
    false,
  );
  assert.deepEqual(order, ["feature", "application_service", "global"]);
  const scoped = context.scoped({ tenant_id: "acme" });
  assert.equal((await scoped.execute(new CommandFind(new IssueNotFound()))).found, false);
});

test("an unregistered command reaches the global handlers", async () => {
  class CommandUnknown extends Command<ResponseIssue> {}
  const context = issues().addGlobalErrorHandler(() => new ResponseIssue(false));
  assert.equal((await context.execute(new CommandUnknown())).found, false);
});

test("expected errors end refused: no error span, no report, still thrown", async () => {
  const tracer = memoryTracer();
  const reporter = memoryReporter();
  configureProcess({ tracer, reporter });
  const context = issues().expectErrors(IssueClosed);
  await assert.rejects(context.execute(new CommandFind(new IssueClosed())), IssueClosed);
  assert.equal(tracer.spans[0]?.outcome, "refused");
  assert.equal(reporter.reports.length, 0);
  // Another bounded context does not expect it.
  await assert.rejects(issues().execute(new CommandFind(new IssueClosed())), IssueClosed);
  assert.equal(reporter.reports.length, 1);
});

test("handlers and expected errors added after a call answer from the next one, and fresh() keeps them", async () => {
  const context = issues();
  await assert.rejects(context.execute(new CommandFind(new IssueNotFound())));
  context.addFeatureErrorHandler(notFound).expectErrors(IssueClosed);
  assert.equal((await context.execute(new CommandFind(new IssueNotFound()))).found, false);
  const reporter = memoryReporter();
  configureProcess({ reporter });
  const copy = context.fresh();
  assert.equal((await copy.execute(new CommandFind(new IssueNotFound()))).found, false);
  await assert.rejects(copy.execute(new CommandFind(new IssueClosed())));
  assert.equal(reporter.reports.length, 1);
});

test("an error handler and an expected error must be what they say", () => {
  const context = issues();
  // @ts-expect-error Runtime JavaScript can pass something else.
  assert.throws(() => context.addGlobalErrorHandler("nope"), /function/);
  // @ts-expect-error Runtime JavaScript can pass something else.
  assert.throws(() => context.expectErrors("IssueClosed"), /class/);
});
