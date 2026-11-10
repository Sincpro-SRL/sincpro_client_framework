import assert from "node:assert/strict";

import { configureProcess, pack, TransportError } from "@sincpro/client-framework";
import {
  ApplicationService,
  BoundedContext,
  Command,
  Feature,
  Response,
} from "@sincpro/client-framework/core";
import { memoryReporter, memoryTracer } from "@sincpro/client-framework/testing";
import { beforeEach, test } from "vitest";

import {
  CancelIssue,
  CommandCancelIssue,
  CommandRequestCancellation,
  CommandSendIssue,
  type ProjectDependencies,
  projectOf,
  RequestCancellation,
  ResponseCancelIssue,
  ResponseSendIssue,
} from "../support/core";

function application() {
  const sent: string[] = [];
  let authorized = 0;
  const dependencies: ProjectDependencies = {
    client: {
      async cancelIssue(dto) {
        sent.push(dto.issue_id);
        return { issue_id: dto.issue_id, resolution: "cancelled" };
      },
      async sendIssue(dto) {
        return { issue_id: dto.issue_id, run_id: "run-1", status: dto.message };
      },
    },
    access: {
      requireCancellation() {
        authorized++;
      },
    },
  };
  return {
    project: projectOf(dependencies),
    dependencies,
    sent,
    authorized: () => authorized,
  };
}

beforeEach(() => configureProcess());

test("the bounded context IS the bus, routing class DTOs to either execution layer", async () => {
  const { project } = application();
  const cancelled = await project.execute(new CommandCancelIssue("issue-1"));
  assert.ok(cancelled instanceof ResponseCancelIssue);
  assert.equal(cancelled.resolution, "cancelled");
  const sent = await project.execute(new CommandSendIssue("issue-1", "hello"));
  assert.ok(sent instanceof ResponseSendIssue);
  assert.equal(sent.run_id, "run-1");
});

test("ApplicationService -> featureBus -> Feature injects dependencies as attributes", async () => {
  const tracer = memoryTracer();
  configureProcess({ tracer });
  const { project, dependencies, sent, authorized } = application();
  assert.equal(project.deps.client, dependencies.client);
  const response = await project.execute(
    new CommandRequestCancellation("issue-1"),
    ResponseCancelIssue,
  );
  assert.equal(response.resolution, "cancelled");
  assert.deepEqual(sent, ["issue-1"]);
  assert.equal(authorized(), 1);
  assert.deepEqual(
    tracer.spans.map((span) => span.name),
    ["project/RequestCancellation", "project/CancelIssue"],
  );
  assert.equal(tracer.spans[1]?.parentSpanId, tracer.spans[0]?.spanId);
  assert.equal(tracer.spans[1]?.traceId, tracer.spans[0]?.traceId);
});

test("unexpected errors propagate and are reported once across the execution layers", async () => {
  const tracer = memoryTracer();
  const reporter = memoryReporter();
  configureProcess({ tracer, reporter });
  const { project, dependencies } = application();
  const failure = new Error("backend unavailable");
  project.addDependency(
    "client",
    {
      ...dependencies.client,
      async cancelIssue() {
        throw failure;
      },
    },
    { replaces: dependencies.client },
  );
  await assert.rejects(
    project.execute(new CommandRequestCancellation("x")),
    (error) => error === failure,
  );
  assert.equal(reporter.reports.length, 1);
  assert.ok(tracer.spans.every((span) => span.outcome === "failed"));
});

test("business refusals retain the existing outcome policy and are not reported", async () => {
  const tracer = memoryTracer();
  const reporter = memoryReporter();
  configureProcess({ tracer, reporter });
  const { project, dependencies } = application();
  const failure = new TransportError("/issues/1", 409, null);
  project.addDependency(
    "client",
    {
      ...dependencies.client,
      async cancelIssue() {
        throw failure;
      },
    },
    { replaces: dependencies.client },
  );
  await assert.rejects(project.execute(new CommandRequestCancellation("x")), failure);
  assert.equal(reporter.reports.length, 0);
  assert.ok(tracer.spans.every((span) => span.outcome === "refused"));
});

test("one DTO cannot be registered twice, including across layers", () => {
  const { project } = application();
  assert.throws(() => project.feature(CommandCancelIssue)(CancelIssue), /already registered/);
  assert.throws(
    () => project.appService(CommandCancelIssue)(RequestCancellation),
    /already registered/,
  );
  assert.throws(
    () =>
      new BoundedContext("wrong").feature(CommandRequestCancellation)(RequestCancellation),
    /not an feature/,
  );
});

class UnknownCommand extends Command<ResponseCancelIssue> {}

test("unknown commands and unregistered subclasses fail without name-based fallback", async () => {
  const { project } = application();
  await assert.rejects(project.execute(new UnknownCommand()), /No executor registered/);
  class Child extends CommandCancelIssue {}
  await assert.rejects(project.execute(new Child("x")), /No executor registered/);
});

test("dependency replacement rebuilds the next generation", async () => {
  const { project, dependencies } = application();
  assert.equal((await project.execute(new CommandCancelIssue("x"))).resolution, "cancelled");
  project.addDependency(
    "client",
    {
      ...dependencies.client,
      async cancelIssue(dto) {
        return { issue_id: dto.issue_id, resolution: "replacement" };
      },
    },
    { replaces: dependencies.client },
  );
  assert.equal(
    (await project.execute(new CommandCancelIssue("x"))).resolution,
    "replacement",
  );
});

test("constructor identity survives JavaScript class renaming", async () => {
  const { project } = application();
  const original = CommandCancelIssue.name;
  Object.defineProperty(CommandCancelIssue, "name", { value: "minified" });
  try {
    assert.equal((await project.execute(new CommandCancelIssue("x"))).issue_id, "x");
  } finally {
    Object.defineProperty(CommandCancelIssue, "name", { value: original });
  }
});

test("concurrent commands retain separate trace parents", async () => {
  const tracer = memoryTracer();
  configureProcess({ tracer });
  const { project } = application();
  await Promise.all(
    ["a", "b"].map((id) => project.execute(new CommandRequestCancellation(id))),
  );
  const parents = tracer.spans.filter((span) => span.name === "project/RequestCancellation");
  assert.equal(parents.length, 2);
  assert.notEqual(parents[0]?.traceId, parents[1]?.traceId);
  for (const parent of parents) {
    const children = tracer.spans.filter((span) => span.parentSpanId === parent.spanId);
    assert.equal(children.length, 1);
    assert.equal(children[0]?.traceId, parent.traceId);
  }
});

class CounterResponse extends Response {
  constructor(readonly value: number) {
    super();
  }
}
class CounterCommand extends Command<CounterResponse> {}
class Counter extends Feature<CounterCommand, CounterResponse> {
  static readonly serviceName = "Counter";
  private count = 0;
  execute() {
    return new CounterResponse(++this.count);
  }
}

test("one service instance serves the generation, not an individual request", async () => {
  const context = new BoundedContext<{ marker: number }>("counter");
  context.feature(CounterCommand)(Counter);
  assert.equal((await context.execute(new CounterCommand())).value, 1);
  assert.equal((await context.execute(new CounterCommand())).value, 2);
  context.addDependency("marker", 1);
  assert.equal((await context.execute(new CounterCommand())).value, 1);
});

class RecursiveApplication extends ApplicationService<
  CommandRequestCancellation,
  ResponseCancelIssue
> {
  static readonly serviceName = "RecursiveApplication";
  execute(command: CommandRequestCancellation) {
    return this.featureBus.execute(command);
  }
}

test("ApplicationServices cannot compose other ApplicationServices through featureBus", async () => {
  const project = new BoundedContext("project");
  project.appService(CommandRequestCancellation)(RecursiveApplication);
  await assert.rejects(project.execute(new CommandRequestCancellation("x")), /only Features/);
});

test("in-flight execution retains its generation even before it calls a Feature", async () => {
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  class DeferredCancellation extends ApplicationService<
    CommandRequestCancellation,
    ResponseCancelIssue
  > {
    static readonly serviceName = "DeferredCancellation";
    declare readonly wait: () => Promise<void>;
    async execute(command: CommandRequestCancellation): Promise<ResponseCancelIssue> {
      await this.wait();
      return this.featureBus.execute(new CommandCancelIssue(command.issue_id));
    }
  }
  const { dependencies } = application();
  const project = new BoundedContext<ProjectDependencies & { wait: () => Promise<void> }>(
    "deferred",
  );
  project.addDependency("client", dependencies.client);
  project.addDependency("wait", async () => {
    entered();
    await waiting;
  });
  project.feature(CommandCancelIssue)(CancelIssue);
  project.appService(CommandRequestCancellation)(DeferredCancellation);
  const oldRun = project.execute(new CommandRequestCancellation("old"));
  await started;
  project.addDependency(
    "client",
    {
      ...dependencies.client,
      async cancelIssue(dto) {
        return { issue_id: dto.issue_id, resolution: "new" };
      },
    },
    { replaces: dependencies.client },
  );
  assert.equal((await project.execute(new CommandCancelIssue("new"))).resolution, "new");
  release();
  assert.equal((await oldRun).resolution, "cancelled");
});

test("dependency locator is live and read-only; missing and invalid registrations are explicit", () => {
  const context = new BoundedContext<ProjectDependencies>("project");
  const locator = context.deps;
  assert.throws(() => locator.client, /not registered/);
  const { dependencies } = application();
  context.addDependency("client", dependencies.client);
  assert.equal(locator.client, dependencies.client);
  assert.throws(
    () => context.addDependency("client", dependencies.client),
    /already registered/,
  );
  assert.throws(
    () =>
      context.addDependency("client", dependencies.client, {
        replaces: { ...dependencies.client },
      }),
    /does not match/,
  );
  assert.throws(() => Reflect.set(locator, "client", dependencies.client), /read-only/);
  assert.throws(() => Object.defineProperty(locator, "client", { value: null }), /read-only/);
});

test("fresh shares dependencies but owns independent service instances", async () => {
  const context = new BoundedContext<{ marker: object }>("counter");
  const marker = {};
  context.addDependency("marker", marker);
  context.feature(CounterCommand)(Counter);
  await context.execute(new CounterCommand());
  const fresh = context.fresh();
  assert.equal(fresh.deps.marker, marker);
  assert.equal((await fresh.execute(new CounterCommand())).value, 1);
  assert.equal((await context.execute(new CounterCommand())).value, 2);
});

test("registration returns the class unchanged, without requiring decorator syntax", () => {
  const context = new BoundedContext("project");
  assert.equal(context.feature(CommandCancelIssue)(CancelIssue), CancelIssue);
});

test("type-only response association leaves existing wire serialization unchanged", () => {
  const command = new CommandCancelIssue("issue-1");
  assert.equal(pack(command), '{"issue_id":"issue-1"}');
  assert.equal(Object.hasOwn(command, "responseType"), false);
});

test("invalid context names and reserved dependencies fail at registration", () => {
  assert.throws(() => new BoundedContext("  "), /nonempty/);
  assert.throws(() => new BoundedContext("a/b"), /without/);
  const context = new BoundedContext<{ featureBus: number }>("reserved");
  assert.throws(() => context.addDependency("featureBus", 1), /Reserved/);
});

test("building eagerly constructs services once and is idempotent within a generation", () => {
  let made = 0;
  class Built extends Counter {
    constructor() {
      super();
      made++;
    }
  }
  const context = new BoundedContext("build");
  context.feature(CounterCommand)(Built);
  assert.equal(made, 0);
  context.buildRootBus();
  context.buildRootBus();
  assert.equal(made, 1);
});
