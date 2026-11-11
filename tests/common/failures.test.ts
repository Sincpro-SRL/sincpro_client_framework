import assert from "node:assert/strict";

import {
  BoundedContext,
  Command,
  configureProcess,
  failureOf,
  Feature,
  kindOfGrpcCode,
  kindOfHttpStatus,
  kindOfJsonRpcCode,
  outcomeOf,
  TransportError,
} from "@sincpro/client-framework";
import { memoryReporter } from "@sincpro/client-framework/testing";
import type { Problem } from "@sincpro/criteria";
import { beforeEach, test } from "vitest";

const conflict: Problem = {
  kind: "conflict",
  reason: "ISSUE_CHANGED",
  status: 409,
  next_step: "refresh_and_retry",
  retryable: true,
  errors: [],
  extensions: {},
};

beforeEach(() => configureProcess({ logger: { engine: false } }));

test("what the server said is the failure — the same Problem over any wire", () => {
  const failure = failureOf(new TransportError("/issues/1", 409, conflict));
  assert.deepEqual(
    [failure.kind, failure.reason, failure.nextStep, failure.retryable, failure.fault],
    ["conflict", "ISSUE_CHANGED", "refresh_and_retry", true, false],
  );
  assert.equal(failure.retryAfter, 1);
  assert.equal(failure.problem, conflict);
  // A JSON-RPC or gRPC transport hands the Problem it read the same way.
  const overRpc = Object.assign(new Error("closed"), {
    problem: { ...conflict, kind: "domain", next_step: "do_not_retry", retryable: false },
  });
  assert.deepEqual([failureOf(overRpc).kind, failureOf(overRpc).permanent], ["domain", true]);
});

test("a REST answer without a problem is read by its status; no answer may have run", () => {
  assert.equal(failureOf(new TransportError("/x", 404, null)).kind, "not_found");
  assert.equal(failureOf(new TransportError("/x", 429, null)).kind, "exhausted");
  assert.equal(failureOf(new TransportError("/x", 503, null)).kind, "unavailable");
  const unanswered = failureOf(new TransportError("/x", null, null));
  assert.deepEqual(
    [unanswered.kind, unanswered.nextStep, unanswered.fault, unanswered.retryable],
    ["unknown_outcome", "verify_then_retry", true, false],
  );
});

test("an error declares its own kind — on itself or on its class —, as the backend's do", () => {
  class IssueClosed extends Error {
    static readonly failureKind = "domain";
  }
  class Throttled extends Error {
    readonly failureKind = "exhausted";
    readonly retryAfter = 30;
    readonly reason = "PRINTER_BUSY";
  }
  const closed = failureOf(new IssueClosed());
  assert.deepEqual(
    [closed.kind, closed.reason, closed.permanent, closed.fault],
    ["domain", "DOMAIN", true, false],
  );
  const throttled = failureOf(new Throttled());
  assert.deepEqual(
    [throttled.kind, throttled.reason, throttled.retryAfter],
    ["exhausted", "PRINTER_BUSY", 30],
  );
  // A kind that is not one is not trusted.
  assert.equal(
    failureOf(Object.assign(new Error(), { failureKind: "maybe" })).kind,
    "internal",
  );
});

test("a cancelled call is nobody's failure; anything else unknown is a fault", () => {
  const aborted = failureOf(Object.assign(new Error("stop"), { name: "AbortError" }));
  assert.deepEqual([aborted.aborted, aborted.fault, aborted.permanent], [true, false, false]);
  const broken = failureOf(new TypeError("undefined is not a function"));
  assert.deepEqual([broken.kind, broken.fault, broken.retryable], ["internal", true, true]);
  assert.equal(failureOf("a string").kind, "internal");
});

test("each wire's codes read back as the backend's kinds", () => {
  assert.deepEqual([401, 403, 409, 422, 502, 504, 500].map(kindOfHttpStatus), [
    "unauthenticated",
    "permission_denied",
    "conflict",
    "invalid",
    "unavailable",
    "unknown_outcome",
    "internal",
  ]);
  assert.deepEqual([3, 16, 7, 5, 10, 9, 8, 14, 4, 13].map(kindOfGrpcCode), [
    "invalid",
    "unauthenticated",
    "permission_denied",
    "not_found",
    "conflict",
    "domain",
    "exhausted",
    "unavailable",
    "unknown_outcome",
    "internal",
  ]);
  assert.deepEqual(
    [
      -32602, -32001, -32003, -32004, -32009, -32010, -32022, -32024, -32029, -32000, -32603,
    ].map(kindOfJsonRpcCode),
    [
      "invalid",
      "unauthenticated",
      "permission_denied",
      "not_found",
      "conflict",
      "domain",
      "key_reused",
      "unknown_outcome",
      "exhausted",
      "unavailable",
      "internal",
    ],
  );
});

test("the outcome follows the failure: a declared refusal is not reported", async () => {
  class IssueClosed extends Error {
    static readonly failureKind = "domain";
  }
  class CommandClose extends Command<void> {}
  class Close extends Feature<CommandClose, void> {
    execute(): void {
      throw new IssueClosed("already closed");
    }
  }
  const reporter = memoryReporter();
  configureProcess({ reporter, logger: { engine: false } });
  const project = new BoundedContext("project");
  project.feature(CommandClose)(Close);
  await assert.rejects(project.execute(new CommandClose()), IssueClosed);
  assert.equal(reporter.reports.length, 0);
  assert.equal(outcomeOf(new IssueClosed()), "refused");
  assert.equal(outcomeOf(new TransportError("/x", 500, null)), "failed");
  assert.equal(outcomeOf(Object.assign(new Error(), { name: "AbortError" })), "aborted");
});
