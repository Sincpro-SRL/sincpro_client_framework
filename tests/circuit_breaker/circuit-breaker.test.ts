import assert from "node:assert/strict";

import {
  CircuitBreaker,
  CircuitOpen,
  failureOf,
  guardedTransport,
  memoryTransport,
  outcomeOf,
  TransportError,
} from "@sincpro/client-framework";
import { test } from "vitest";

const down = () => Promise.reject(new TransportError("/x", 503, null));
const refused = () => Promise.reject(new TransportError("/x", 422, null));

function clocked(failures = 2, openFor = 30_000) {
  let now = 1_000_000;
  const breaker = new CircuitBreaker("odoo", { failures, openFor, clock: () => now });
  return { breaker, pass: (ms: number) => (now += ms) };
}

test("it opens after the failures in a row, and then fails at once with the time left", async () => {
  const { breaker, pass } = clocked();
  let calls = 0;
  const call = () => breaker.call(() => (calls++, down()));
  await assert.rejects(call(), TransportError);
  assert.equal(breaker.state(), "closed");
  await assert.rejects(call(), TransportError);
  assert.equal(breaker.state(), "open");
  pass(10_000);
  const refusal = await call().catch((error: unknown) => error);
  assert.ok(refusal instanceof CircuitOpen);
  assert.equal(refusal.retryAfter, 20);
  assert.equal(calls, 2);
  const failure = failureOf(refusal);
  assert.deepEqual(
    [failure.kind, failure.reason, failure.retryAfter, failure.retryable],
    ["unavailable", "CIRCUIT_OPEN", 20, true],
  );
  assert.equal(outcomeOf(refusal), "failed");
});

test("a refusal is an answer: it never counts, and an answer resets the streak", async () => {
  const { breaker } = clocked(2);
  await assert.rejects(breaker.call(down));
  await assert.rejects(breaker.call(refused));
  assert.equal(breaker.state(), "closed");
  assert.equal(await breaker.call(() => "ok"), "ok");
  await assert.rejects(breaker.call(down));
  assert.equal(breaker.state(), "closed");
});

test("half-open lets one call try: an answer closes it, a counted failure opens it again", async () => {
  const { breaker, pass } = clocked(1, 1000);
  await assert.rejects(breaker.call(down));
  pass(1000);
  assert.equal(breaker.state(), "half_open");
  let release: (value: string) => void = () => {};
  const probe = breaker.call(() => new Promise<string>((resolve) => (release = resolve)));
  await assert.rejects(
    breaker.call(() => "second"),
    CircuitOpen,
  );
  release("back");
  assert.equal(await probe, "back");
  assert.equal(breaker.state(), "closed");
  await assert.rejects(breaker.call(down));
  pass(1000);
  await assert.rejects(breaker.call(down), TransportError);
  assert.equal(breaker.state(), "open");
});

test("a wrapped function and a guarded transport go through the circuit", async () => {
  const { breaker } = clocked(1);
  const send = breaker.wrap((amount: number) =>
    amount > 0 ? down() : Promise.resolve("zero"),
  );
  assert.equal(await send(0), "zero");
  await assert.rejects(send(1), TransportError);
  await assert.rejects(send(0), CircuitOpen);
  breaker.reset();
  const transport = guardedTransport(memoryTransport({}), breaker);
  await assert.rejects(transport.one("/missing/1"), TransportError);
  assert.equal(breaker.state(), "closed"); // a 404 is an answer
});

test("a circuit needs a failure and some time", () => {
  assert.throws(() => new CircuitBreaker("x", { failures: 0 }), /failures/);
  assert.throws(() => new CircuitBreaker("x", { openFor: 0 }), /openFor/);
});
