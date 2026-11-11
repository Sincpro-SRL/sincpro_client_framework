import assert from "node:assert/strict";

import {
  ApplicationService,
  BoundedContext,
  type CallOptions,
  Command,
  configureProcess,
  Feature,
  memoryTransport,
  type Transport,
} from "@sincpro/client-framework";
import { memoryReporter, memoryTracer } from "@sincpro/client-framework/testing";
import { beforeEach, test } from "vitest";

class CommandSlow extends Command<string> {}
class CommandBoth extends Command<string> {}

const never = () => new Promise<string>(() => {});

/** A service that ignores its signal: the caller stops waiting anyway. */
class Slow extends Feature<CommandSlow, string> {
  static readonly serviceName = "Slow";
  execute(): Promise<string> {
    return never();
  }
}

class Both extends ApplicationService<CommandBoth, string> {
  static readonly serviceName = "Both";
  execute(): Promise<string> {
    return this.featureBus.execute(new CommandSlow());
  }
}

function slow() {
  const context = new BoundedContext("slow");
  context.feature(CommandSlow)(Slow);
  context.appService(CommandBoth)(Both);
  return context;
}

beforeEach(() => configureProcess({ logger: { engine: false } }));

test("a cancelled run ends aborted at once, its span says so, and nothing is reported", async () => {
  const tracer = memoryTracer();
  const reporter = memoryReporter();
  configureProcess({ tracer, reporter, logger: { engine: false } });
  const screen = new AbortController();
  const running = slow().execute(new CommandSlow(), { signal: screen.signal });
  screen.abort();
  await assert.rejects(running, { name: "AbortError" });
  assert.equal(tracer.spans[0]?.outcome, "aborted");
  assert.equal(reporter.reports.length, 0);
});

test("a run executed with a signal already aborted does not reach its service", async () => {
  let reached = false;
  class CommandMark extends Command<void> {}
  class Mark extends Feature<CommandMark, void> {
    static readonly serviceName = "Mark";
    execute(): void {
      reached = true;
    }
  }
  const context = new BoundedContext("mark");
  context.feature(CommandMark)(Mark);
  await assert.rejects(context.execute(new CommandMark(), { signal: AbortSignal.abort() }), {
    name: "AbortError",
  });
  assert.equal(reached, false);
});

test("a Feature inherits its ApplicationService's signal, and so does a scope", async () => {
  const tracer = memoryTracer();
  configureProcess({ tracer, logger: { engine: false } });
  const screen = new AbortController();
  const running = slow().execute(new CommandBoth(), { signal: screen.signal });
  await Promise.resolve();
  screen.abort();
  await assert.rejects(running, { name: "AbortError" });
  assert.deepEqual(
    tracer.spans.map((span) => [span.name, span.outcome]),
    [
      ["slow/Both", "aborted"],
      ["slow/Slow", "aborted"],
    ],
  );
  const scoped = slow().scoped({ tenant_id: "acme" });
  await assert.rejects(scoped.execute(new CommandSlow(), { signal: AbortSignal.abort() }), {
    name: "AbortError",
  });
});

test("the run's requests are cancelled with it: the bound transport carries its signal", async () => {
  const seen: (AbortSignal | undefined)[] = [];
  const memory = memoryTransport({});
  const watching: Transport = {
    ...memory,
    send: <T>(
      method: Parameters<Transport["send"]>[0],
      route: string,
      body: unknown,
      signal?: AbortSignal,
      options?: CallOptions,
    ) => {
      seen.push(signal);
      return memory.send<T>(method, route, body, signal, options);
    },
  };
  class CommandSend extends Command<unknown> {}
  class Send extends Feature<CommandSend, unknown> {
    static readonly serviceName = "Send";
    declare readonly transport: Transport;
    execute(): Promise<unknown> {
      assert.equal(this.signal, screen.signal);
      return this.transport.send("POST", "/x", {}).catch(() => null);
    }
  }
  const screen = new AbortController();
  const context = new BoundedContext<{ transport: Transport }>("send");
  context.addDependency("transport", watching).feature(CommandSend)(Send);
  await context.execute(new CommandSend(), { signal: screen.signal });
  assert.equal(seen[0], screen.signal);
});

test("signal is a run's own member, never a dependency", () => {
  const context = new BoundedContext<{ signal: AbortSignal }>("reserved");
  assert.throws(() => context.addDependency("signal", AbortSignal.abort()), /Reserved/);
});
