import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";

import {
  bindable,
  configureProcess,
  memoryTransport,
  processContext,
  restOperations,
  restTransport,
  type Tracer,
  TransportError,
} from "@sincpro/client-framework";
import {
  ApplicationService,
  BoundedContext,
  Command,
  Feature,
} from "@sincpro/client-framework/core";
import { memoryReporter, memoryTracer } from "@sincpro/client-framework/testing";
import { beforeEach, test } from "vitest";

import { clientOf } from "../support/forge-contract/project/client";
import { project } from "../support/project";
import {
  CancelAndNotify,
  CancelIssue,
  RunningWith,
  SendIssue,
} from "../support/project/domain";
import { signedIn } from "../support/project/infrastructure/dependencies";

beforeEach(() => configureProcess());
const later = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a registered command is one use case with a stable service identity", async () => {
  const tracer = memoryTracer();
  configureProcess({ tracer });
  await project.execute(new CancelIssue("acme-3"));
  const span = tracer.spans[0];
  assert.equal(span?.name, "project/Cancel");
  assert.equal(span?.outcome, "ok");
  assert.equal(span?.attributes["sincpro.use_case"], "project.Cancel");
  assert.equal(span?.attributes["sincpro.layer"], "feature");
  assert.match(String(span?.attributes["sincpro.execution_id"]), /^[0-9a-f]{32}$/);
});

test("an ApplicationService's Features are children on the same trace", async () => {
  const tracer = memoryTracer();
  configureProcess({ tracer });
  const context = project.fresh();
  const outbox = { sent: [] as string[] };
  context.addDependency("outbox", outbox, { replaces: context.deps.outbox });
  assert.deepEqual(await context.execute(new CancelAndNotify("acme-3")), {
    issue_id: "acme-3",
    resolution: "cancelled",
  });
  assert.deepEqual(outbox.sent, ["acme-3 cancelled"]);
  const [parent, ...children] = tracer.spans;
  assert.deepEqual(
    tracer.spans.map((span) => span.name),
    ["project/CancelAndNotify", "project/Cancel", "project/Tell"],
  );
  for (const child of children) {
    assert.equal(child.parentSpanId, parent?.spanId);
    assert.equal(child.traceId, parent?.traceId);
  }
});

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
class Wait extends Feature<WaitCommand, number> {
  static readonly serviceName = "Wait";
  async execute(dto: WaitCommand) {
    await later(dto.ms);
    return dto.ms;
  }
}
class Twice extends ApplicationService<TwiceCommand, number> {
  static readonly serviceName = "Twice";
  async execute(dto: TwiceCommand) {
    await this.featureBus.execute(new WaitCommand(dto.ms));
    return this.featureBus.execute(new WaitCommand(dto.ms));
  }
}

test("two asynchronous runs never take each other as parent", async () => {
  const tracer = memoryTracer();
  configureProcess({ tracer });
  const context = new BoundedContext("timing");
  context.feature(WaitCommand)(Wait);
  context.appService(TwiceCommand)(Twice);
  await Promise.all([
    context.execute(new TwiceCommand(20)),
    context.execute(new TwiceCommand(2)),
  ]);
  const parents = tracer.spans.filter((span) => span.name === "timing/Twice");
  assert.equal(parents.length, 2);
  for (const parent of parents) {
    const children = tracer.spans.filter((span) => span.parentSpanId === parent.spanId);
    assert.equal(children.length, 2);
    assert.ok(children.every((child) => child.traceId === parent.traceId));
  }
  assert.notEqual(parents[0]?.traceId, parents[1]?.traceId);
});

test("an injected generated client carries its execution's trace; direct calls do not", async () => {
  const sent: Headers[] = [];
  const tracer = memoryTracer();
  configureProcess({ tracer });
  processContext.set({ tenant_id: "acme" });
  const client = clientOf(
    restOperations(
      restTransport({
        document: null,
        fetch: async (_url, init) => {
          sent.push(new Headers(init?.headers));
          return Response.json({});
        },
      }),
    ),
  );
  const context = project.fresh();
  context.addDependency("client", client, { replaces: context.deps.client });
  await context.execute(new SendIssue("acme-3", "message"));
  const span = tracer.spans[0];
  assert.equal(sent[0]?.get("traceparent"), `00-${span?.traceId}-${span?.spanId}-01`);
  assert.equal(sent[0]?.get("sincpro-context"), '{"tenant_id":"acme"}');
  await client.sendIssue({ issue_id: "acme-3", message: "direct" });
  assert.equal(sent[1]?.get("traceparent"), null);
});

test("context precedence is process, bounded context, then execution scope", async () => {
  processContext.set({ tenant_id: "acme", company_id: 1 });
  assert.deepEqual(await project.execute(new RunningWith()), {
    tenant_id: "acme",
    company_id: 1,
  });
  project.context.set({ company_id: 2 });
  assert.deepEqual(await project.execute(new RunningWith()), {
    tenant_id: "acme",
    company_id: 2,
  });
  assert.deepEqual(await project.scoped({ company_id: 3 }).execute(new RunningWith()), {
    tenant_id: "acme",
    company_id: 3,
  });
  assert.deepEqual(await project.execute(new RunningWith()), {
    tenant_id: "acme",
    company_id: 2,
  });
});

class ContextCommand extends Command<Readonly<Record<string, unknown>>> {}
class DelayedContext extends Command<Readonly<Record<string, unknown>>> {}
class ReadContext extends Feature<ContextCommand, Readonly<Record<string, unknown>>> {
  static readonly serviceName = "ReadContext";
  execute() {
    return this.context;
  }
}
class ReadLater extends ApplicationService<
  DelayedContext,
  Readonly<Record<string, unknown>>
> {
  static readonly serviceName = "ReadLater";
  async execute() {
    await later(5);
    return this.featureBus.execute(new ContextCommand());
  }
}

test("a root snapshots context once and children retain it after an await", async () => {
  const context = new BoundedContext("snapshot");
  context.feature(ContextCommand)(ReadContext);
  context.appService(DelayedContext)(ReadLater);
  processContext.set({ tenant_id: "acme" });
  const running = context.execute(new DelayedContext());
  processContext.set({ tenant_id: "beta" });
  assert.deepEqual(await running, { tenant_id: "acme" });
  assert.deepEqual(await context.execute(new DelayedContext()), { tenant_id: "beta" });
});

class FailCommand extends Command<never> {}
class Fail extends Feature<FailCommand, never> {
  static readonly serviceName = "Fail";
  declare readonly error: unknown;
  execute(): never {
    throw this.error;
  }
}
function failing(error: unknown) {
  const context = new BoundedContext<{ error: unknown }>("failure");
  context.addDependency("error", error);
  context.feature(FailCommand)(Fail);
  return context;
}

test("only unexpected errors are reported; refusals and aborts retain their outcomes", async () => {
  const tracer = memoryTracer();
  const reporter = memoryReporter();
  configureProcess({ tracer, reporter });
  const conflict = new TransportError("/x", 409, null);
  const broken = new TypeError("broken");
  const aborted = Object.assign(new Error("stop"), { name: "AbortError" });
  const down = new TransportError("/x", 503, null);
  for (const error of [conflict, broken, aborted, down]) {
    await assert.rejects(
      failing(error).execute(new FailCommand()),
      (value) => value === error,
    );
  }
  assert.deepEqual(
    tracer.spans.map((span) => span.outcome),
    ["refused", "failed", "aborted", "failed"],
  );
  assert.deepEqual(
    reporter.reports.map((report) => report.error),
    [broken, down],
  );
  assert.equal(reporter.reports[0]?.about.traceId, tracer.spans[1]?.traceId);
});

test("throwing observability adapters do not replace business outcomes", async () => {
  const tracer: Tracer = {
    start() {
      throw new Error("exporter down");
    },
  };
  configureProcess({
    tracer,
    reporter: {
      report() {
        throw new Error("reporter down");
      },
    },
  });
  assert.equal((await project.execute(new CancelIssue("acme-3"))).resolution, "cancelled");
  await assert.rejects(
    failing(new Error("business failure")).execute(new FailCommand()),
    /business failure/,
  );
});

class HelperCommand extends Command<string> {}
class Helpers extends Feature<HelperCommand, string> {
  static readonly serviceName = "Helpers";
  execute() {
    return this.helper();
  }
  private helper() {
    return "helper";
  }
}
test("helpers stay inside the single execute span", async () => {
  const tracer = memoryTracer();
  configureProcess({ tracer });
  const context = new BoundedContext("helpers");
  context.feature(HelperCommand)(Helpers);
  assert.equal(await context.execute(new HelperCommand()), "helper");
  assert.deepEqual(
    tracer.spans.map((span) => span.name),
    ["helpers/Helpers"],
  );
});

test("registration checks layers, duplicate service names and reserved dependencies", () => {
  const context = new BoundedContext("invalid");
  assert.throws(() => context.feature(TwiceCommand)(Twice), /not an feature/);
  assert.throws(() => context.appService(WaitCommand)(Wait), /not an application_service/);
  context.feature(WaitCommand)(Wait);
  assert.throws(() => context.feature(TwiceCommand)(Wait), /Service name already registered/);
  const reserved = new BoundedContext<{ featureBus: number }>("invalid");
  assert.throws(() => reserved.addDependency("featureBus", 1), /Reserved/);
});

class ProbeCommand extends Command<{ now: number; bound: boolean; custom: boolean }> {}
test("plain dependencies retain identity; transports and custom bindables receive the run", async () => {
  const clock = { now: () => 42 };
  const transport = memoryTransport({});
  const client = bindable(transport, (through) => ({ through }));
  class Probe extends Feature<
    ProbeCommand,
    { now: number; bound: boolean; custom: boolean }
  > {
    static readonly serviceName = "Probe";
    declare readonly clock: typeof clock;
    declare readonly transport: typeof transport;
    declare readonly client: typeof client;
    execute() {
      return {
        now: this.clock === clock ? this.clock.now() : -1,
        bound: this.transport !== transport,
        custom: this.client !== client,
      };
    }
  }
  configureProcess({ tracer: memoryTracer() });
  const context = new BoundedContext<{
    clock: typeof clock;
    transport: typeof transport;
    client: typeof client;
  }>("probe");
  context
    .addDependency("clock", clock)
    .addDependency("transport", transport)
    .addDependency("client", client);
  context.feature(ProbeCommand)(Probe);
  assert.deepEqual(await context.execute(new ProbeCommand()), {
    now: 42,
    bound: true,
    custom: true,
  });
});

class ComposedFailure extends Command<never> {}
class Composed extends ApplicationService<ComposedFailure, never> {
  static readonly serviceName = "Composed";
  execute() {
    return this.featureBus.execute(new FailCommand());
  }
}
test("a composed error reports its origin once while both executions fail", async () => {
  const tracer = memoryTracer();
  const reporter = memoryReporter();
  configureProcess({ tracer, reporter });
  const context = failing(new Error("boom"));
  context.appService(ComposedFailure)(Composed);
  await assert.rejects(context.execute(new ComposedFailure()), /boom/);
  assert.deepEqual(
    reporter.reports.map((report) => report.about.useCase),
    ["failure.Fail"],
  );
  assert.deepEqual(
    tracer.spans.map((span) => span.outcome),
    ["failed", "failed"],
  );
});

test("independent roots can report the same Error instance without suppressing a later incident", async () => {
  const reporter = memoryReporter();
  configureProcess({ reporter });
  const context = failing(new Error("reused adapter error"));
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(context.execute(new FailCommand()), /reused adapter error/);
  }
  assert.equal(reporter.reports.length, 2);
  assert.notEqual(
    reporter.reports[0]?.about.executionId,
    reporter.reports[1]?.about.executionId,
  );
});

test("primitive failures are reported once while propagating through nested services", async () => {
  const reporter = memoryReporter();
  configureProcess({ reporter });
  const context = failing(undefined);
  context.appService(ComposedFailure)(Composed);
  await assert.rejects(
    context.execute(new ComposedFailure()),
    (error) => error === undefined,
  );
  assert.equal(reporter.reports.length, 1);
  assert.equal(reporter.reports[0]?.error, undefined);
});

test("construction is once per generation and scopes share its instances", async () => {
  let made = 0;
  class Counted extends Helpers {
    constructor() {
      super();
      made++;
    }
  }
  const context = new BoundedContext<Record<never, never>, { company_id: number }>("counted");
  context.feature(HelperCommand)(Counted);
  assert.equal(made, 0);
  await context.execute(new HelperCommand());
  await context.scoped({ company_id: 2 }).execute(new HelperCommand());
  assert.equal(made, 1);
  await context.fresh().execute(new HelperCommand());
  assert.equal(made, 2);
});

test("dependencies registered after build reach the next generation", async () => {
  const context = project.fresh();
  await context.execute(new CancelIssue("acme-3"));
  context.addDependency("session", signedIn(null), { replaces: context.deps.session });
  await assert.rejects(context.execute(new CancelIssue("acme-3")), /sign in first/);
});

class CountCommand extends Command<number> {}
class Counter extends Feature<CountCommand, number> {
  static readonly serviceName = "Counter";
  private count = 0;
  execute() {
    return ++this.count;
  }
}
test("instance state persists in a generation, never becoming request-local implicitly", async () => {
  const context = new BoundedContext<Record<never, never>, { company_id: number }>("counter");
  context.feature(CountCommand)(Counter);
  assert.equal(await context.execute(new CountCommand()), 1);
  assert.equal(await context.scoped({ company_id: 2 }).execute(new CountCommand()), 2);
});

test("scope values and Command arguments stay typed", () => {
  const typeChecks = () => {
    // @ts-expect-error Context scope values remain typed.
    project.scoped({ company_id: "two" });
    // @ts-expect-error DTO constructor arguments remain typed.
    void project.execute(new CancelIssue(42));
  };
  assert.equal(typeof typeChecks, "function");
});

test("an absent injected dependency fails explicitly inside execution", async () => {
  const reporter = memoryReporter();
  configureProcess({ reporter });
  const context = new BoundedContext("missing");
  context.feature(FailCommand)(Fail);
  await assert.rejects(context.execute(new FailCommand()), /not registered: error/);
  assert.equal(reporter.reports.length, 1);
});

test("foreign Promise implementations remain inside the execution span until settlement", async () => {
  const tracer = memoryTracer();
  configureProcess({ tracer });
  class ForeignCommand extends Command<number> {}
  const foreign: Promise<number> = runInNewContext("Promise.resolve(42)");
  class Foreign extends Feature<ForeignCommand, number> {
    static readonly serviceName = "Foreign";
    execute() {
      return foreign;
    }
  }
  const context = new BoundedContext("foreign");
  context.feature(ForeignCommand)(Foreign);
  assert.equal(await context.execute(new ForeignCommand()), 42);
  assert.equal(tracer.spans[0]?.outcome, "ok");
});
