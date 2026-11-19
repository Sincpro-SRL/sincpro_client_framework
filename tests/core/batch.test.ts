import assert from "node:assert/strict";

import {
  BoundedContext,
  Command,
  configureProcess,
  Feature,
  type ItemOutcome,
  runBatch,
  TransportError,
} from "@sincpro/client-framework";
import { memoryTracer } from "@sincpro/client-framework/testing";
import { beforeEach, test } from "vitest";

beforeEach(() => configureProcess({ logger: { engine: false } }));

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** What the backend answers when an invoice cannot be confirmed: a conflict. */
class AlreadyCancelled extends Error {
  static readonly failureKind = "conflict";
  readonly reason = "ALREADY_CANCELLED";
}

class CommandConfirm extends Command<string> {
  constructor(readonly number: string) {
    super();
  }
}

class Confirm extends Feature<CommandConfirm, string> {
  execute(dto: CommandConfirm): string {
    if (dto.number === "F-7") throw new AlreadyCancelled("F-7 is cancelled");
    return `${dto.number} confirmed`;
  }
}

function billing() {
  const context = new BoundedContext("billing");
  context.feature(CommandConfirm)(Confirm);
  return context;
}

test("for rec in self: a Command per record, each its own run, one outcome each in order", async () => {
  const tracer = memoryTracer();
  configureProcess({ tracer, logger: { engine: false } });
  const billingBoundedContext = billing();
  const result = await runBatch(["F-1", "F-7", "F-9"], (number, { signal }) =>
    billingBoundedContext.execute(new CommandConfirm(number), signal ? { signal } : {}),
  );
  assert.deepEqual(
    result.outcomes.map((one) => [one.item, one.status]),
    [
      ["F-1", "done"],
      ["F-7", "failed"],
      ["F-9", "done"],
    ],
  );
  assert.deepEqual([result.done, result.failed, result.skipped], [2, 1, 0]);
  const refused = result.outcomes[1];
  assert.equal(refused?.status === "failed" && refused.failure.kind, "conflict");
  assert.equal(refused?.status === "failed" && refused.failure.reason, "ALREADY_CANCELLED");
  const answered = result.outcomes[0];
  assert.equal(answered?.status === "done" && answered.answer, "F-1 confirmed");
  // Nothing escapes execution: three use cases, three spans.
  assert.deepEqual(
    tracer.spans.map((span) => span.name),
    ["billing/Confirm", "billing/Confirm", "billing/Confirm"],
  );
});

test("one at a time by default; more at once when asked, the outcomes still in the items' order", async () => {
  let running = 0;
  let most = 0;
  const step = async (ms: number) => {
    running += 1;
    most = Math.max(most, running);
    await pause(ms);
    running -= 1;
    return ms;
  };
  await runBatch([5, 5, 5], step);
  assert.equal(most, 1);
  most = 0;
  const result = await runBatch([30, 10, 20, 5], step, { concurrency: 2 });
  assert.equal(most, 2);
  assert.deepEqual(
    result.outcomes.map((one) => one.status === "done" && one.answer),
    [30, 10, 20, 5],
  );
});

test("a failure is the item's, read as the server said it — a step that throws at once too", async () => {
  const result = await runBatch(["a", "b"], (item) => {
    if (item === "a") throw new Error("synchronous");
    return Promise.reject(
      new TransportError("/invoices/b/confirm", 409, {
        kind: "conflict",
        reason: "ALREADY_CANCELLED",
        next_step: "do_not_retry",
        retryable: false,
        errors: [],
        extensions: {},
        detail: "B is cancelled.",
      }),
    );
  });
  assert.deepEqual(
    result.outcomes.map((one) => one.status === "failed" && one.failure.kind),
    ["internal", "conflict"],
  );
  const refused = result.outcomes[1];
  assert.equal(refused?.status === "failed" && refused.failure.reason, "ALREADY_CANCELLED");
});

test("stopping at the first failure skips what had not started", async () => {
  const result = await runBatch(
    [1, 2, 3, 4],
    async (n) => {
      if (n === 2) throw new Error("no");
      return n;
    },
    { stopOnFailure: true },
  );
  assert.deepEqual(
    result.outcomes.map((one) => one.status),
    ["done", "failed", "skipped", "skipped"],
  );
  assert.equal(result.skipped, 2);
});

test("cancelled midway: the running item gets the signal, the rest never start", async () => {
  const screen = new AbortController();
  const seen: (AbortSignal | undefined)[] = [];
  const result = await runBatch(
    [1, 2, 3],
    async (n, { signal }) => {
      seen.push(signal);
      if (n === 2) screen.abort();
      return n;
    },
    { signal: screen.signal },
  );
  assert.equal(seen[0], screen.signal);
  assert.deepEqual(
    result.outcomes.map((one) => one.status),
    ["done", "done", "skipped"],
  );
});

test("each outcome is heard as it settles, with the progress", async () => {
  const heard: [ItemOutcome<number, number>["status"], number, number][] = [];
  await runBatch([1, 2], async (n) => n, {
    onOutcome: (outcome, { settled, total }) => heard.push([outcome.status, settled, total]),
  });
  assert.deepEqual(heard, [
    ["done", 1, 2],
    ["done", 2, 2],
  ]);
});

test("nothing to run answers nothing; a concurrency that is not a count is refused", async () => {
  assert.deepEqual(await runBatch([], async () => 1), {
    outcomes: [],
    done: 0,
    failed: 0,
    skipped: 0,
  });
  await assert.rejects(
    runBatch([1], async () => 1, { concurrency: 0 }),
    RangeError,
  );
});
