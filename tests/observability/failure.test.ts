import assert from "node:assert/strict";

import {
  ApplicationService,
  BoundedContext,
  Command,
  configureProcess,
  Feature,
  processContext,
  TransportError,
} from "@sincpro/client-framework";
import { consoleLogger } from "@sincpro/client-framework/console";
import { sentryReporter } from "@sincpro/client-framework/sentry";
import { memoryLogger, memoryTracer } from "@sincpro/client-framework/testing";
import { beforeEach, test, vi } from "vitest";

beforeEach(() => configureProcess());

class CommandSave extends Command<void> {}
class CommandSaveAll extends Command<void> {}
class CommandRefuse extends Command<void> {}

function saving() {
  const savingBoundedContext = new BoundedContext("odoo");
  savingBoundedContext.feature(CommandSave)(
    class SaveServer extends Feature<CommandSave, void> {
      execute(): void {
        throw new TypeError("server is undefined");
      }
    },
  );
  savingBoundedContext.appService(CommandSaveAll)(
    class SaveAll extends ApplicationService<CommandSaveAll, void> {
      async execute(): Promise<void> {
        await this.featureBus.execute(new CommandSave());
      }
    },
  );
  savingBoundedContext.feature(CommandRefuse)(
    class Refuse extends Feature<CommandRefuse, void> {
      execute(): void {
        throw new TransportError("/servers", 409, null);
      }
    },
  );
  return savingBoundedContext;
}

test("a failure is described once, where it was raised: type, message, the use case's own line and its stack", async () => {
  const lines = memoryLogger();
  const tracer = memoryTracer();
  configureProcess({ logger: { engine: lines }, tracer });

  await assert.rejects(saving().execute(new CommandSaveAll()), TypeError);

  const finished = lines.records.filter((record) => record.event === "execution.finished");
  const [inner, outer] = finished;
  assert.equal(inner?.useCase, "odoo.SaveServer");
  assert.equal(inner?.failure?.type, "TypeError");
  assert.equal(inner?.failure?.message, "server is undefined");
  assert.match(
    inner?.failure?.at ?? "",
    /failure\.test\.ts/,
    "the use case's own line, not the framework's",
  );
  assert.ok(inner?.failure?.stack);
  assert.match(inner?.message ?? "", /^Execution failed: TypeError: server is undefined at /);

  assert.equal(outer?.useCase, "odoo.SaveAll");
  assert.equal(
    outer?.failure?.failedIn,
    "odoo.SaveServer",
    "the run it crossed says where it failed",
  );
  assert.equal(outer?.failure?.stack, undefined, "the stack is told once");

  const [feature, service] = [
    tracer.spans.find((span) => span.name === "odoo/SaveServer"),
    tracer.spans.find((span) => span.name === "odoo/SaveAll"),
  ];
  assert.ok(
    feature?.error instanceof TypeError,
    "the exception is on the span where it was raised",
  );
  assert.equal(service?.error, undefined, "the span it crossed takes only the error status");
  assert.equal(service?.outcome, "failed");
  assert.equal(feature?.attributes["error.type"], "TypeError");
  assert.equal(feature?.attributes["sincpro.outcome"], "internal");
});

test("an expected failure is information: its type and kind, never its message or a stack", async () => {
  const lines = memoryLogger();
  configureProcess({ logger: { engine: lines } });

  await assert.rejects(saving().execute(new CommandRefuse()), TransportError);

  const finished = lines.records.find((record) => record.event === "execution.finished");
  assert.equal(finished?.level, "info");
  assert.deepEqual(finished?.failure, {
    type: "TransportError",
    kind: "conflict",
    fault: false,
  });
  assert.equal(finished?.message, "Execution refused: TransportError");
});

test("tenant and user are optional, read from the keys the application names", async () => {
  const tracer = memoryTracer();
  const lines = memoryLogger();
  const save = () =>
    saving()
      .execute(new CommandRefuse())
      .catch(() => undefined);

  configureProcess({ identity: { release: "app:1.0" }, tracer, logger: { engine: lines } });
  processContext.set({ company_id: 3 });
  await save();
  assert.equal(tracer.spans.at(-1)?.attributes.tenant, undefined, "no key named, none sent");

  configureProcess({
    identity: { release: "app:1.0", keys: { tenant: "company_id", user: "uid" } },
    tracer,
    logger: { engine: lines },
  });
  processContext.set({ company_id: 3, uid: 7 });
  await save();
  assert.equal(tracer.spans.at(-1)?.attributes.tenant, "3");
  assert.equal(tracer.spans.at(-1)?.attributes.user_id, "7");
  assert.equal(lines.records.at(-1)?.userId, "7");

  configureProcess({
    identity: { release: "app:1.0", keys: { tenant: "tenant_ids" } },
    tracer,
  });
  processContext.set({ tenant_ids: ["acme", "dispel"] });
  await save();
  assert.equal(tracer.spans.at(-1)?.attributes.tenant, "acme,dispel");
});

test("GlitchTip gets sincpro_framework's tags, the event's user and its trace", async () => {
  const hints: { captureContext: Record<string, unknown> }[] = [];
  const tracer = memoryTracer();
  configureProcess({
    identity: { release: "sincpro-mobile-tickets:0.3.0" },
    tracer,
    reporter: sentryReporter({
      captureException: (_error, hint) => {
        hints.push(hint as { captureContext: Record<string, unknown> });
        return "id";
      },
    }),
  });
  processContext.set({ user_id: 42 });

  await assert.rejects(saving().execute(new CommandSave()));

  const { tags, user, contexts } = hints[0]!.captureContext as {
    tags: Record<string, string>;
    user: { id: string };
    contexts: { trace: { trace_id: string; span_id: string } };
  };
  assert.deepEqual(
    {
      context: tags["sincpro.context"],
      layer: tags["sincpro.layer"],
      outcome: tags["sincpro.outcome"],
      type: tags["error.type"],
      service: tags.service_name,
      version: tags.service_version,
      user: tags.user_id,
    },
    {
      context: "odoo",
      layer: "feature",
      outcome: "internal",
      type: "TypeError",
      service: "sincpro-mobile-tickets",
      version: "0.3.0",
      user: "42",
    },
  );
  assert.deepEqual(user, { id: "42" });
  assert.equal(contexts.trace.trace_id, tracer.spans[0]?.traceId);
  assert.equal(contexts.trace.span_id, tracer.spans[0]?.spanId);
});

test("in development the console prints an unexpected failure as an Error, with its stack", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    configureProcess({ logger: { engine: consoleLogger({ mode: "development" }) } });
    await assert.rejects(saving().execute(new CommandSave()));
    const [line, shown, ...rest] = error.mock.calls.at(-1) ?? [];
    assert.match(
      String(line),
      /ERROR \[feature\] ✖ \S+ TypeError: server is undefined \d+ms #/,
    );
    assert.equal(rest.length, 0, "the record is not dumped after the line");
    // An Error — what LogBox and Expo's terminal print with its code frame, never `null null`.
    assert.ok(shown instanceof Error);
    assert.equal(shown.name, "TypeError");
    assert.equal(shown.message, "server is undefined");
    assert.match(shown.stack ?? "", /TypeError: server is undefined\n/);
  } finally {
    error.mockRestore();
  }
});

test("observability that fails — Loki or OTLP down, offline — never fails a use case", async () => {
  configureProcess({
    identity: { release: "app:1.0" },
    tracer: {
      start: () => ({
        traceId: "",
        spanId: "",
        sampled: false,
        set: () => {
          throw new Error("collector down");
        },
        end: () => {
          throw new Error("collector down");
        },
      }),
    },
    reporter: {
      report: () => {
        throw new Error("GlitchTip unreachable");
      },
    },
    logger: {
      engine: {
        log: () => {
          throw new Error("Loki unreachable");
        },
      },
    },
  });

  // The use case's own error, and only it, reaches the caller.
  await assert.rejects(saving().execute(new CommandSave()), /server is undefined/);
  await assert.rejects(saving().execute(new CommandRefuse()), TransportError);
});
