import assert from "node:assert/strict";

import {
  ApplicationService,
  bindServices,
  createRuntime,
  Feature,
  memoryTransport,
  restTransport,
  type Tracer,
  TransportError,
} from "@sincpro/client-framework";
import { memoryReporter, memoryTracer } from "@sincpro/client-framework/testing";
import { test } from "vitest";

import { clientOf } from "./support/forge-contract/project/client";

type Sent = { url: string; headers: Record<string, string> };

/** A server that answers every request with `{}` and keeps what each one carried. */
function recording(sent: Sent[]): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    sent.push({ url, headers: { ...(init?.headers as Record<string, string>) } });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
}

const later = (ms: number) => new Promise((done) => setTimeout(done, ms));

class Echo extends Feature {
  execute(text: string) {
    return `«${text}»`;
  }
}

class Wait extends Feature {
  async execute(ms: number) {
    await later(ms);
    return ms;
  }
}

class Twice extends ApplicationService<{ first: Wait; second: Wait }> {
  async execute(ms: number) {
    await this.features.first.execute(ms);
    return this.features.second.execute(ms);
  }
}

test("a Feature constructed and called runs as written — nothing traces until it is bound", () => {
  assert.equal(new Echo().execute("hola"), "«hola»");
});

test("a bound use case is traced as <domain>/<key>, said what it is, and ends ok", async () => {
  const tracer = memoryTracer();
  const runtime = createRuntime({ tracer });
  const project = bindServices(runtime, "project", { echo: new Echo(), wait: new Wait() });
  assert.equal(project.echo.execute("x"), "«x»");
  assert.equal(await project.wait.execute(1), 1);
  assert.deepEqual(
    tracer.spans.map(({ name, outcome }) => [name, outcome]),
    [
      ["project/echo", "ok"],
      ["project/wait", "ok"],
    ],
  );
  assert.equal(tracer.spans[0]?.attributes["sincpro.layer"], "feature");
  assert.equal(tracer.spans[0]?.attributes["sincpro.domain"], "project");
  assert.match(String(tracer.spans[0]?.attributes["sincpro.execution_id"]), /^[0-9a-f]{32}$/);
});

test("an ApplicationService's Features are children of its run, on the same trace", async () => {
  const tracer = memoryTracer();
  const runtime = createRuntime({ tracer });
  const project = bindServices(runtime, "project", {
    twice: new Twice({ first: new Wait(), second: new Wait() }),
  });
  await project.twice.execute(1);
  const [parent, first, second] = tracer.spans;
  assert.deepEqual(
    tracer.spans.map((one) => one.name),
    ["project/twice", "project/first", "project/second"],
  );
  assert.equal(parent?.attributes["sincpro.layer"], "application_service");
  for (const child of [first, second]) {
    assert.equal(child?.parentSpanId, parent?.spanId);
    assert.equal(child?.traceId, parent?.traceId);
  }
});

test("two runs at once never take each other as parent", async () => {
  const tracer = memoryTracer();
  const runtime = createRuntime({ tracer });
  const project = bindServices(runtime, "project", {
    twice: new Twice({ first: new Wait(), second: new Wait() }),
  });
  // The slow one starts first and ends last: a global stack would hang the fast one's Features
  // from the slow one's span, and pop the wrong entry when the fast one ends.
  await Promise.all([project.twice.execute(30), project.twice.execute(5)]);
  const parents = tracer.spans.filter((one) => one.name === "project/twice");
  assert.equal(parents.length, 2);
  for (const parent of parents) {
    const children = tracer.spans.filter((one) => one.parentSpanId === parent.spanId);
    assert.equal(children.length, 2);
    for (const child of children) assert.equal(child.traceId, parent.traceId);
  }
  assert.notEqual(parents[0]?.traceId, parents[1]?.traceId);
});

class SendIssue extends Feature<{ project: ReturnType<typeof clientOf> }> {
  execute(message: string) {
    return this.deps.project.sendIssue({ issue_id: "acme-3", message });
  }
}

test("the request a use case sends carries its trace and its context — generated client and all", async () => {
  const sent: Sent[] = [];
  const tracer = memoryTracer();
  const runtime = createRuntime({ tracer, context: () => ({ tenant_id: "acme" }) });
  const client = clientOf(restTransport({ document: null, fetch: recording(sent) }));
  const project = bindServices(runtime, "project", {
    sendIssue: new SendIssue({ project: client }),
  });
  await project.sendIssue.execute("y el reporte");
  const span = tracer.spans[0];
  assert.equal(sent[0]?.url, "/issues/acme-3/messages");
  assert.equal(sent[0]?.headers["traceparent"], `00-${span?.traceId}-${span?.spanId}-01`);
  assert.equal(sent[0]?.headers["sincpro-context"], JSON.stringify({ tenant_id: "acme" }));
  // The client itself is untouched: called outside a use case, it sends no trace.
  await client.sendIssue({ issue_id: "acme-3", message: "a mano" });
  assert.equal(sent[1]?.headers["traceparent"], undefined);
});

class ReadContext extends Feature {
  execute() {
    return this.context;
  }
}

class Context extends ApplicationService<{ read: ReadContext }> {
  execute() {
    return this.features.read.execute();
  }
}

test("the context is read once where the gesture starts, and every Feature it runs sees it", () => {
  let reads = 0;
  const runtime = createRuntime({ context: () => ({ tenant_id: "acme", read: ++reads }) });
  const project = bindServices(runtime, "project", {
    context: new Context({ read: new ReadContext() }),
  });
  assert.deepEqual(project.context.execute(), { tenant_id: "acme", read: 1 });
  assert.equal(reads, 1);
});

class Refuse extends Feature<{ error: unknown }> {
  async execute() {
    throw this.deps.error;
  }
}

test("only what nobody expected is reported — with its trace; a refusal or an abort is not", async () => {
  const tracer = memoryTracer();
  const reporter = memoryReporter();
  const runtime = createRuntime({ tracer, reporter, context: () => ({ tenant_id: "acme" }) });
  const conflict = new TransportError("/issues/1", 409, null);
  const broken = new TypeError("undefined is not a function");
  const aborted = Object.assign(new Error("stopped"), { name: "AbortError" });
  const project = bindServices(runtime, "project", {
    conflict: new Refuse({ error: conflict }),
    broken: new Refuse({ error: broken }),
    aborted: new Refuse({ error: aborted }),
    down: new Refuse({ error: new TransportError("/issues", 503, null) }),
  });
  await assert.rejects(project.conflict.execute(), conflict);
  await assert.rejects(project.broken.execute(), broken);
  await assert.rejects(project.aborted.execute(), aborted);
  await assert.rejects(project.down.execute());
  assert.deepEqual(
    tracer.spans.map(({ name, outcome }) => [name, outcome]),
    [
      ["project/conflict", "refused"],
      ["project/broken", "failed"],
      ["project/aborted", "aborted"],
      ["project/down", "failed"],
    ],
  );
  assert.deepEqual(
    reporter.reports.map(({ about }) => about.useCase),
    ["project/broken", "project/down"],
  );
  const [report] = reporter.reports;
  assert.equal(report?.error, broken);
  assert.equal(report?.about.traceId, tracer.spans[1]?.traceId);
  assert.deepEqual(report?.about.context, { tenant_id: "acme" });
});

test("a tracer or a reporter that throws never changes what the use case answers", async () => {
  const throwing: Tracer = {
    start: () => {
      throw new Error("the exporter is down");
    },
  };
  const runtime = createRuntime({
    tracer: throwing,
    reporter: {
      report: () => {
        throw new Error("the reporter is down");
      },
    },
  });
  const project = bindServices(runtime, "project", {
    echo: new Echo(),
    broken: new Refuse({ error: new Error("boom") }),
  });
  assert.equal(project.echo.execute("x"), "«x»");
  await assert.rejects(project.broken.execute(), /boom/);
});

class Several extends Feature {
  execute() {
    return this._helper();
  }
  preview() {
    return "preview";
  }
  _helper() {
    return "helper";
  }
}

test("execute is the use case; another public method is traced by its name; `_` is not", () => {
  const tracer = memoryTracer();
  const project = bindServices(createRuntime({ tracer }), "project", {
    several: new Several(),
  });
  assert.equal(project.several.execute(), "helper");
  assert.equal(project.several.preview(), "preview");
  assert.equal(project.several._helper(), "helper");
  assert.deepEqual(
    tracer.spans.map((one) => one.name),
    ["project/several", "project/several.preview"],
  );
});

test("an ApplicationService that composes another ApplicationService is refused when made", () => {
  const inner = new Twice({ first: new Wait(), second: new Wait() });
  assert.throws(
    () => new Twice({ first: inner as unknown as Wait, second: new Wait() }),
    /"first" is an ApplicationService — an ApplicationService executes Features/,
  );
});

test("a dependency that is not a transport nor bindable is handed as it is", async () => {
  const clock = { now: () => 42 };
  class Now extends Feature<{ clock: typeof clock }> {
    execute() {
      return this.deps.clock === clock ? this.deps.clock.now() : -1;
    }
  }
  const memory = memoryTransport({});
  class Bound extends Feature<{ transport: typeof memory }> {
    execute() {
      return this.deps.transport !== memory;
    }
  }
  const tracer = memoryTracer();
  const project = bindServices(createRuntime({ tracer }), "project", {
    now: new Now({ clock }),
    bound: new Bound({ transport: memory }),
  });
  assert.equal(project.now.execute(), 42);
  // A raw transport in `deps` is bound too: its requests carry the run's trace.
  assert.equal(project.bound.execute(), true);
});
