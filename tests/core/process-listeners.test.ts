import assert from "node:assert/strict";

import {
  BoundedContext,
  Command,
  configureProcess,
  Feature,
  processListeners,
} from "@sincpro/client-framework";
import { afterEach, beforeEach, test } from "vitest";

class CommandPing extends Command<string> {
  constructor(readonly fail = false) {
    super();
  }
}

class Ping extends Feature<CommandPing, string> {
  static readonly serviceName = "Ping";
  execute(command: CommandPing): string {
    if (command.fail) throw new Error("down");
    return "pong";
  }
}

function context(name: string) {
  const one = new BoundedContext(name);
  one.feature(CommandPing)(Ping);
  return one;
}

const stops: (() => void)[] = [];
beforeEach(() => configureProcess({ logger: { engine: false } }));
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

test("process listeners hear every bounded context, after each one's own", async () => {
  const heard: string[] = [];
  const shop = context("shop");
  shop.onCompletion(() => heard.push("shop's own"));
  stops.push(
    processListeners.onStart((started) => heard.push(`start ${started.execution.useCase}`)),
    processListeners.onCompletion((done) => heard.push(`done ${done.execution.useCase}`)),
    processListeners.onFailure((failed) => heard.push(`failed ${failed.execution?.useCase}`)),
  );
  await shop.execute(new CommandPing());
  await assert.rejects(context("mail").execute(new CommandPing(true)));
  assert.deepEqual(heard, [
    "start shop.Ping",
    "shop's own",
    "done shop.Ping",
    "start mail.Ping",
    "failed mail.Ping",
  ]);
});

test("a process listener stops when told, filters by class, and survives configureProcess", async () => {
  const heard: string[] = [];
  class CommandOther extends Command<string> {}
  const stop = processListeners.onCompletion(
    (done) => heard.push(done.execution.useCase),
    CommandOther,
  );
  stops.push(stop);
  await context("shop").execute(new CommandPing());
  assert.equal(heard.length, 0);
  const all = processListeners.onCompletion((done) => heard.push(done.execution.useCase));
  configureProcess({ logger: { engine: false } });
  await context("shop").execute(new CommandPing());
  all();
  await context("shop").execute(new CommandPing());
  assert.deepEqual(heard, ["shop.Ping"]);
});
