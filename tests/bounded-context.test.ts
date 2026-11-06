import assert from "node:assert/strict";

import {
  ApplicationService,
  configureProcess,
  Feature,
  memoryTransport,
  processContext,
  restTransport,
  type Tracer,
  TransportError,
  UseBoundedContext,
} from "@sincpro/client-framework";
import { memoryReporter, memoryTracer } from "@sincpro/client-framework/testing";
import { beforeEach, test } from "vitest";

import { clientOf } from "./support/forge-contract/project/client";
import { project } from "./support/project";
import { signedIn } from "./support/project/infrastructure/dependencies";

type Sent = { url: string; headers: Record<string, string> };

/** A server that answers every request with `{}` and keeps what each one carried. */
function recording(sent: Sent[]): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    sent.push({ url, headers: { ...(init?.headers as Record<string, string>) } });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
}

const later = (ms: number) => new Promise((done) => setTimeout(done, ms));

// Each test starts from a process of its own: nothing traced, an empty context.
beforeEach(() => configureProcess());

test("a service is reached by its name; each public method is a use case named as the backend names one", async () => {
  const tracer = memoryTracer();
  configureProcess({ tracer });
  await project.Issues.cancel({ issue_id: "acme-3" });
  const [span] = tracer.spans;
  assert.equal(span?.name, "project/Issues.cancel");
  assert.equal(span?.outcome, "ok");
  assert.equal(span?.attributes["sincpro.use_case"], "project.Issues.cancel");
  assert.equal(span?.attributes["sincpro.context"], "project");
  assert.equal(span?.attributes["sincpro.layer"], "feature");
  assert.match(String(span?.attributes["sincpro.execution_id"]), /^[0-9a-f]{32}$/);
});

test("an ApplicationService's Features are children of its run, on the same trace", async () => {
  const tracer = memoryTracer();
  configureProcess({ tracer });
  const outbox = { sent: [] as string[] };
  const answer = await project
    .with({ outbox })
    .CancelAndNotify.execute({ issue_id: "acme-3" });
  assert.deepEqual(answer, { issue_id: "acme-3", resolution: "cancelled" });
  assert.deepEqual(outbox.sent, ["acme-3 cancelled"]);
  const [parent, ...children] = tracer.spans;
  assert.deepEqual(
    tracer.spans.map((one) => one.name),
    ["project/CancelAndNotify", "project/Issues.cancel", "project/Notices.tell"],
  );
  assert.equal(parent?.attributes["sincpro.layer"], "application_service");
  for (const child of children) {
    assert.equal(child.parentSpanId, parent?.spanId);
    assert.equal(child.traceId, parent?.traceId);
  }
});

class Wait extends Feature {
  async for(ms: number) {
    await later(ms);
    return ms;
  }
}

class Twice extends ApplicationService<Record<never, never>, { Wait: typeof Wait }> {
  async execute(ms: number) {
    await this.feature.Wait.for(ms);
    return this.feature.Wait.for(ms);
  }
}

const timing = new UseBoundedContext("timing").register({
  features: { Wait },
  applicationServices: { Twice },
});

test("two runs at once never take each other as parent", async () => {
  const tracer = memoryTracer();
  configureProcess({ tracer });
  // The slow one starts first and ends last: a global stack would hang the fast one's Features
  // from the slow one's span, and pop the wrong entry when the fast one ends.
  await Promise.all([timing.Twice.execute(30), timing.Twice.execute(5)]);
  const parents = tracer.spans.filter((one) => one.name === "timing/Twice");
  assert.equal(parents.length, 2);
  for (const parent of parents) {
    const children = tracer.spans.filter((one) => one.parentSpanId === parent.spanId);
    assert.equal(children.length, 2);
    for (const child of children) assert.equal(child.traceId, parent.traceId);
  }
  assert.notEqual(parents[0]?.traceId, parents[1]?.traceId);
});

test("the request a use case sends carries its trace and its context — generated client and all", async () => {
  const sent: Sent[] = [];
  const tracer = memoryTracer();
  configureProcess({ tracer });
  processContext.set({ tenant_id: "acme" });
  const client = clientOf(restTransport({ document: null, fetch: recording(sent) }));
  await project.with({ client }).Issues.send({ issue_id: "acme-3", message: "y el reporte" });
  const span = tracer.spans[0];
  assert.equal(sent[0]?.url, "/issues/acme-3/messages");
  assert.equal(sent[0]?.headers["traceparent"], `00-${span?.traceId}-${span?.spanId}-01`);
  assert.equal(sent[0]?.headers["sincpro-context"], JSON.stringify({ tenant_id: "acme" }));
  // The client itself is untouched: called outside a use case, it sends no trace.
  await client.sendIssue({ issue_id: "acme-3", message: "a mano" });
  assert.equal(sent[1]?.headers["traceparent"], undefined);
});

test("the context: the process's, under it the bounded context's, under it a scope's", () => {
  processContext.set({ tenant_id: "acme", company_id: 1 });
  assert.deepEqual(project.Issues.runningWith(), { tenant_id: "acme", company_id: 1 });
  project.context.set({ company_id: 2 });
  assert.deepEqual(project.Issues.runningWith(), { tenant_id: "acme", company_id: 2 });
  const window = project.scoped({ company_id: 3 });
  assert.deepEqual(window.Issues.runningWith(), { tenant_id: "acme", company_id: 3 });
  // A scope is its own: the bounded context it came from keeps its context.
  assert.deepEqual(project.Issues.runningWith(), { tenant_id: "acme", company_id: 2 });
  // Another bounded context sees the process's, never «project»'s.
  assert.deepEqual(
    new UseBoundedContext("other")
      .register({
        features: {
          Issues: class extends Feature {
            runningWith() {
              return this.context;
            }
          },
        },
      })
      .Issues.runningWith(),
    { tenant_id: "acme", company_id: 1 },
  );
});

class Seen extends Feature {
  tenant() {
    return this.context["tenant_id"];
  }
}

class SeenLater extends ApplicationService<Record<never, never>, { Seen: typeof Seen }> {
  async execute() {
    await later(5);
    return this.feature.Seen.tenant();
  }
}

test("the context is read once where the gesture starts: a change mid-run is for the next one", async () => {
  const seen = new UseBoundedContext("seen").register({
    features: { Seen },
    applicationServices: { SeenLater },
  });
  processContext.set({ tenant_id: "acme" });
  const running = seen.SeenLater.execute();
  processContext.set({ tenant_id: "beta" });
  assert.equal(await running, "acme");
  assert.equal(await seen.SeenLater.execute(), "beta");
});

class Refuse extends Feature<{ error: unknown }> {
  async now() {
    throw this.error;
  }
}

const failing = new UseBoundedContext<{ error: unknown }>("project").register({
  features: { Refuse },
});

test("only what nobody expected is reported — with its trace; a refusal or an abort is not", async () => {
  const tracer = memoryTracer();
  const reporter = memoryReporter();
  configureProcess({ tracer, reporter });
  processContext.set({ tenant_id: "acme" });
  const conflict = new TransportError("/issues/1", 409, null);
  const broken = new TypeError("undefined is not a function");
  const aborted = Object.assign(new Error("stopped"), { name: "AbortError" });
  const down = new TransportError("/issues", 503, null);
  for (const error of [conflict, broken, aborted, down])
    await assert.rejects(failing.with({ error }).Refuse.now(), error);
  assert.deepEqual(
    tracer.spans.map(({ outcome }) => outcome),
    ["refused", "failed", "aborted", "failed"],
  );
  assert.deepEqual(
    reporter.reports.map(({ error }) => error),
    [broken, down],
  );
  const [report] = reporter.reports;
  assert.equal(report?.about.useCase, "project.Refuse.now");
  assert.equal(report?.about.traceId, tracer.spans[1]?.traceId);
  assert.deepEqual(report?.about.context, { tenant_id: "acme" });
});

test("a tracer or a reporter that throws never changes what the use case answers", async () => {
  const throwing: Tracer = {
    start: () => {
      throw new Error("the exporter is down");
    },
  };
  configureProcess({
    tracer: throwing,
    reporter: {
      report: () => {
        throw new Error("the reporter is down");
      },
    },
  });
  assert.deepEqual(await project.Issues.cancel({ issue_id: "acme-3" }), {
    issue_id: "acme-3",
    resolution: "cancelled",
  });
  await assert.rejects(failing.with({ error: new Error("boom") }).Refuse.now(), /boom/);
});

class Several extends Feature {
  execute() {
    return this._helper();
  }
  preview() {
    return this.execute();
  }
  _helper() {
    return "helper";
  }
}

test("execute is the use case; another public method is traced by its name; `_` is not; a call inside is the same run", () => {
  const tracer = memoryTracer();
  configureProcess({ tracer });
  const several = new UseBoundedContext("project").register({ features: { Several } });
  assert.equal(several.Several.execute(), "helper");
  assert.equal(several.Several.preview(), "helper");
  // @ts-expect-error a `_` helper is the service's own: its holder does not see it
  assert.equal(several.Several._helper(), "helper");
  assert.deepEqual(
    tracer.spans.map((one) => one.name),
    ["project/Several", "project/Several.preview"],
  );
});

test("what a bounded context holds is checked when it is registered", () => {
  class Composes extends ApplicationService {
    execute() {
      return 1;
    }
  }
  const bc = () => new UseBoundedContext("project");
  assert.throws(
    () => bc().register({ features: { Composes } }),
    /"Composes" is not a Feature — an ApplicationService goes in applicationServices/,
  );
  assert.throws(
    () => bc().register({ features: {}, applicationServices: { Wait } }),
    /"Wait" is not an ApplicationService — a Feature goes in features/,
  );
  assert.throws(
    () => bc().register({ features: { Wait }, applicationServices: { Wait: Twice } }),
    /two services are called "Wait"/,
  );
  assert.throws(
    () => bc().register({ features: { context: Wait } }),
    /no service can be called "context"/,
  );
  assert.throws(
    () => new UseBoundedContext<{ feature: number }>("project").addDependency("feature", 1),
    /a dependency cannot be called "feature"/,
  );
  assert.throws(() => new UseBoundedContext("pro/ject"), /not a bounded context's name/);
});

test("a dependency that is not a transport nor bindable is handed as it is; a raw transport is bound", () => {
  const clock = { now: () => 42 };
  const memory = memoryTransport({});
  class Probe extends Feature<{ clock: typeof clock; transport: typeof memory }> {
    now() {
      return this.clock === clock ? this.clock.now() : -1;
    }
    bound() {
      return this.transport !== memory;
    }
  }
  configureProcess({ tracer: memoryTracer() });
  const probe = new UseBoundedContext<{ clock: typeof clock; transport: typeof memory }>(
    "probe",
  )
    .addDependency("clock", clock)
    .addDependency("transport", memory)
    .register({ features: { Probe } });
  assert.equal(probe.Probe.now(), 42);
  // A raw transport is bound too: its requests carry the run's trace.
  assert.equal(probe.Probe.bound(), true);
});

class Composed extends ApplicationService<{ error: unknown }, { Refuse: typeof Refuse }> {
  execute() {
    return this.feature.Refuse.now();
  }
}

test("an error thrown through an ApplicationService is reported once, where it happened", async () => {
  const tracer = memoryTracer();
  const reporter = memoryReporter();
  configureProcess({ tracer, reporter });
  const broken = new TypeError("undefined is not a function");
  const composed = new UseBoundedContext<{ error: unknown }>("project")
    .addDependency("error", broken)
    .register({ features: { Refuse }, applicationServices: { Composed } });
  await assert.rejects(composed.Composed.execute(), broken);
  assert.deepEqual(
    reporter.reports.map(({ about }) => about.useCase),
    ["project.Refuse.now"],
  );
  // Both runs still say they failed.
  assert.deepEqual(
    tracer.spans.map(({ name, outcome }) => [name, outcome]),
    [
      ["project/Composed", "failed"],
      ["project/Refuse.now", "failed"],
    ],
  );
});

test("a bounded context holds references: each service made once, when first asked, and shared by what derives from it", () => {
  let made = 0;
  class Counted extends Feature {
    constructor() {
      super();
      made += 1;
    }
    id() {
      return this;
    }
  }
  const counted = new UseBoundedContext("counted").register({ features: { Counted } });
  assert.equal(made, 0);
  assert.equal(counted.Counted, counted.Counted);
  // A method is the same function each time it is read: a screen can keep it.
  assert.equal(counted.Counted.id, counted.Counted.id);
  counted.Counted.id();
  counted.with({}).Counted.id();
  counted.scoped({ company_id: 2 }).Counted.id();
  assert.equal(made, 1);
});

test("a dependency added after the bounded context was registered is seen; `with` wins over it", () => {
  const bc = new UseBoundedContext<{ session: ReturnType<typeof signedIn> }>("late");
  class Who extends Feature<{ session: ReturnType<typeof signedIn> }> {
    user() {
      return this.session.user;
    }
  }
  const late = bc.register({ features: { Who } });
  bc.addDependency("session", signedIn("ana"));
  assert.equal(late.Who.user(), "ana");
  assert.equal(late.with({ session: signedIn("beto") }).Who.user(), "beto");
});

test("what a method writes on `this` stays on the service: it is the bounded context's, as in sincpro_framework", () => {
  class Counter extends Feature {
    count = 0;
    add() {
      this.count += 1;
      return this.count;
    }
  }
  const counter = new UseBoundedContext("counter").register({ features: { Counter } });
  counter.Counter.add();
  assert.equal(counter.Counter.add(), 2);
  assert.equal(counter.with({}).Counter.add(), 3);
});

test("what a bounded context offers is typed: the services' methods, never their dependencies", () => {
  // @ts-expect-error a dependency is the service's own, not its holder's
  assert.equal(project.Issues.client, undefined);
  // @ts-expect-error neither is its context
  assert.equal(project.Issues.context, undefined);
  // @ts-expect-error a name nothing was registered under
  assert.equal(project.Nobody, undefined);
  // Only the compiler reads these: run, they would fail before the assertion could.
  const refused = () => {
    // @ts-expect-error a body the generated client refuses
    void project.Issues.cancel({ issue: "acme-3" });
    // @ts-expect-error `with` takes the bounded context's dependencies only
    project.with({ clock: 1 });
    // @ts-expect-error and `scoped` its context
    project.scoped({ company_id: "two" });
  };
  assert.equal(typeof refused, "function");
});
