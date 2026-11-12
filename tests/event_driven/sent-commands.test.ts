import assert from "node:assert/strict";

import {
  BoundedContext,
  combined,
  Command,
  configureProcess,
  DEFAULT_DELIVERY_POLICY,
  type Delivery,
  Feature,
  memoryMessageStore,
  Publisher,
  storedQueue,
  Subscriber,
  syncQueue,
  verdictOf,
} from "@sincpro/client-framework";
import { beforeEach, test } from "vitest";

beforeEach(() => configureProcess({ logger: { engine: false } }));

class CommandSendMessage extends Command<{ readonly id: string }> {
  constructor(
    readonly chat: string,
    readonly text: string,
  ) {
    super();
  }
}

class Refused extends Error {
  static readonly failureKind = "domain";
}

/** A chat whose server answers, refuses or is not there, as told; it records the key it got. */
function chat(outcomes: unknown[], keys: string[]) {
  const chatBoundedContext = new BoundedContext("chat");
  chatBoundedContext.feature(CommandSendMessage)(
    class SendMessage extends Feature<CommandSendMessage, { readonly id: string }> {
      execute(command: CommandSendMessage): { readonly id: string } {
        keys.push(this.execution.causationId ?? "");
        const outcome = outcomes.shift();
        if (outcome instanceof Error) throw outcome;
        return { id: `m-${command.text}` };
      }
    },
  );
  return chatBoundedContext;
}

test("a Command sent through the queue is stored, run by its bus, and its answer kept", async () => {
  const keys: string[] = [];
  const chatBoundedContext = chat([], keys);
  const store = memoryMessageStore();
  const queue = storedQueue({
    store,
    subscriber: new Subscriber({
      boundedContexts: [chatBoundedContext],
      commands: [CommandSendMessage],
    }),
  });
  const envelope = await new Publisher(queue).send(new CommandSendMessage("c-1", "hola"));
  await queue.drain();

  const [sent] = store.messages;
  assert.equal(sent?.kind, "command");
  assert.equal(sent?.envelope.name, "chat.CommandSendMessage");
  assert.equal(sent?.state, "delivered");
  assert.deepEqual(sent?.answer, { id: "m-hola" });
  assert.deepEqual(keys, [envelope.id], "its id is the key its use case sends");
});

test("a Command the server refuses is set aside; one nobody consumes here too", async () => {
  const store = memoryMessageStore();
  const queue = storedQueue({
    store,
    subscriber: new Subscriber({
      boundedContexts: [chat([new Refused("blocked")], [])],
      commands: [CommandSendMessage],
    }),
  });
  await new Publisher(queue).send(new CommandSendMessage("c-1", "hola"));
  await queue.drain();
  assert.equal(store.messages[0]?.state, "set_aside");
  assert.equal(store.messages[0]?.failures[0]?.kind, "domain");

  const undeclared = memoryMessageStore();
  const elsewhere = storedQueue({
    store: undeclared,
    subscriber: new Subscriber({ boundedContexts: [chat([], [])] }),
  });
  await new Publisher(elsewhere).send(new CommandSendMessage("c-1", "hola"));
  await elsewhere.drain();
  assert.equal(
    undeclared.messages[0]?.state,
    "set_aside",
    "a bus never runs what it did not ask for",
  );
});

test("sent with no answer, it waits and goes again with the same key — WhatsApp's one tick", async () => {
  class NoAnswer extends Error {
    static readonly failureKind = "unknown_outcome";
  }
  const keys: string[] = [];
  const store = memoryMessageStore();
  const queue = storedQueue({
    store,
    subscriber: new Subscriber({
      boundedContexts: [chat([new NoAnswer("timeout")], keys)],
      commands: [CommandSendMessage],
    }),
    policyOf: (stored) => (stored.kind === "command" ? { requiresNetwork: true } : undefined),
    wait: 1,
  });
  await new Publisher(queue).send(new CommandSendMessage("c-1", "hola"));
  await queue.drain();
  assert.equal(store.messages[0]?.state, "pending");
  await new Promise((resolve) => setTimeout(resolve, 20));
  await queue.drain();
  assert.equal(store.messages[0]?.state, "delivered");
  assert.deepEqual(store.messages[0]?.answer, { id: "m-hola" });
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1], "the same key: a server that keeps keys runs it once");
});

test("in the call, a sent Command runs at once and its failure reaches who sent it", async () => {
  const chatBoundedContext = chat([new Refused("blocked")], []);
  const queue = syncQueue(
    new Subscriber({ boundedContexts: [chatBoundedContext], commands: [CommandSendMessage] }),
  );
  await assert.rejects(new Publisher(queue).send(new CommandSendMessage("c", "x")), Refused);
});

test("the verdict's rules: sent once, waits only for what goes over the network, the most asking wins", () => {
  class Bug extends Error {}
  class Down extends Error {
    static readonly failureKind = "unavailable";
  }
  const delivery = (errors: unknown[], policy = {}, attempts = 1): Delivery => ({
    stored: {} as Delivery["stored"],
    attempts,
    errors,
    policy: { ...DEFAULT_DELIVERY_POLICY, ...policy },
    backoff: 1000,
  });
  assert.deepEqual(verdictOf(delivery([])), { settlement: "delivered" });
  assert.deepEqual(verdictOf(delivery([new Bug()])), { settlement: "set_aside" });
  assert.deepEqual(verdictOf(delivery([new Down()])), { settlement: "set_aside" });
  assert.deepEqual(verdictOf(delivery([new Down()], { requiresNetwork: true })), {
    settlement: "wait",
    after: 1000,
  });
  assert.deepEqual(verdictOf(delivery([new Bug()], { retries: 2 }, 2)), {
    settlement: "retry",
    after: 1000,
  });
  assert.deepEqual(verdictOf(delivery([new Bug()], { retries: 2 }, 3)), {
    settlement: "set_aside",
  });
  assert.deepEqual(
    verdictOf(delivery([new Down()], { requiresNetwork: true, maxAttempts: 3 }, 3)),
    { settlement: "set_aside" },
  );
  assert.deepEqual(
    combined([{ settlement: "set_aside" }, { settlement: "wait", after: 5 }]),
    { settlement: "wait", after: 5 },
  );
});
