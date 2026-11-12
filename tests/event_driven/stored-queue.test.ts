import assert from "node:assert/strict";

import {
  BoundedContext,
  CircuitBreaker,
  configureProcess,
  DomainEvent,
  Feature,
  memoryMessageStore,
  Money,
  Publisher,
  type StoredMessage,
  storedQueue,
  Subscriber,
  TransportError,
  verdictOf,
} from "@sincpro/client-framework";
import { memoryTracer } from "@sincpro/client-framework/testing";
import { beforeEach, test } from "vitest";

class OrderPaid extends DomainEvent {
  static readonly eventName = "shop.order.v1.paid";
  constructor(readonly order_id: string) {
    super();
  }
}

class InvoiceVoided extends DomainEvent {
  static readonly eventName = "billing.invoice.v1.voided";
  constructor(readonly invoice_id: string) {
    super();
  }
}

class RouteClosed extends DomainEvent {
  static readonly eventName = "distribution.route.v1.closed";
  static fromJSON(values: { route: string }) {
    return new RouteClosed(`${values.route}!`);
  }
  constructor(readonly route: string) {
    super();
  }
}

class Refused extends Error {
  static readonly failureKind = "domain";
}

/** Fails as told, in order, then answers: a backend that is down, then back. */
function flaky(name: string, failures: unknown[], seen: string[]) {
  class Hear extends Feature<OrderPaid, string> {
    execute(event: OrderPaid): string {
      const failure = failures.shift();
      if (failure !== undefined) throw failure;
      seen.push(`${name} ${event.order_id} ${event instanceof OrderPaid}`);
      return name;
    }
  }
  const context = new BoundedContext(name);
  context.feature(OrderPaid)(Hear);
  return context;
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => configureProcess({ logger: { engine: false } }));

test("publish returns once stored; the event is delivered, rebuilt as its class, in its flow", async () => {
  const tracer = memoryTracer();
  configureProcess({ tracer, logger: { engine: false } });
  const seen: string[] = [];
  const store = memoryMessageStore();
  const queue = storedQueue({ store, subscriber: new Subscriber(flaky("mail", [], seen)) });
  const envelope = await new Publisher(queue).publish(new OrderPaid("o-1"));
  assert.equal(store.messages[0]?.envelope.id, envelope.id);
  await queue.drain();
  assert.deepEqual(seen, ["mail o-1 true"]);
  assert.equal(store.messages[0]?.state, "delivered");
  assert.equal(tracer.spans[0]?.attributes["sincpro.causation_id"], envelope.id);
});

test("a message with retries is sent again after a failure; a context that has it is not run twice", async () => {
  const seen: string[] = [];
  const store = memoryMessageStore();
  const settled: StoredMessage[] = [];
  const queue = storedQueue({
    store,
    subscriber: new Subscriber(
      flaky("mail", [], seen),
      flaky("stock", [new TransportError("/stock", 503, null)], seen),
    ),
    policy: { retries: 1 },
    wait: 5,
    onSettled: (one) => settled.push(one),
  });
  await queue.put(new OrderPaid("o-2"), envelope("e-2"));
  await queue.drain();
  assert.equal(store.messages[0]?.state, "pending");
  assert.deepEqual(store.messages[0]?.reached, ["mail"]);
  assert.deepEqual(
    store.messages[0]?.failures.map((one) => [one.boundedContext, one.kind]),
    [["stock", "unavailable"]],
  );
  await pause(1100);
  await queue.drain();
  assert.equal(store.messages[0]?.state, "delivered");
  assert.deepEqual(seen, ["mail o-2 true", "stock o-2 true"]);
  assert.deepEqual(
    settled.map((one) => one.state),
    ["pending", "delivered"],
  );
});

test("a failure every attempt would repeat is set aside, and does not hold back what follows", async () => {
  const seen: string[] = [];
  const store = memoryMessageStore();
  const queue = storedQueue({
    store,
    subscriber: new Subscriber(flaky("mail", [new Refused("no customer email")], seen)),
  });
  await queue.put(new OrderPaid("o-3"), envelope("e-3"));
  await queue.put(new OrderPaid("o-4"), envelope("e-4"));
  await queue.drain();
  assert.deepEqual(
    store.messages.map((one) => one.state),
    ["set_aside", "delivered"],
  );
  assert.deepEqual(store.messages[0]?.failures[0], {
    boundedContext: "mail",
    kind: "domain",
    reason: "DOMAIN",
    message: "no customer email",
  });
  assert.deepEqual(seen, ["mail o-4 true"]);
});

test("an event not ready waits while the rest go on; nobody hearing it is no failure", async () => {
  const seen: string[] = [];
  const store = memoryMessageStore();
  let online = false;
  const queue = storedQueue({
    store,
    subscriber: new Subscriber(flaky("mail", [], seen)),
    ready: (one) => online || one.envelope.name !== "shop.order.v1.paid",
  });
  await queue.put(new OrderPaid("o-5"), envelope("e-5", "shop.order.v1.paid"));
  await queue.put(new InvoiceVoided("i-1"), envelope("e-6", "billing.invoice.v1.voided"));
  await queue.drain();
  assert.deepEqual(
    store.messages.map((one) => one.state),
    ["pending", "delivered"],
  );
  online = true;
  await queue.drain();
  assert.equal(store.messages[0]?.state, "delivered");
  assert.deepEqual(seen, ["mail o-5 true"]);
});

test("a class that says how to read itself is rebuilt that way", async () => {
  const heard: string[] = [];
  class Close extends Feature<RouteClosed, void> {
    execute(event: RouteClosed): void {
      heard.push(event.route);
    }
  }
  const routes = new BoundedContext("routes");
  routes.feature(RouteClosed)(Close);
  const queue = storedQueue({
    store: memoryMessageStore(),
    subscriber: new Subscriber(routes),
  });
  await queue.put(new RouteClosed("R-7"), envelope("e-7", "distribution.route.v1.closed"));
  await queue.drain();
  assert.deepEqual(heard, ["R-7!"]);
});

function envelope(id: string, name = "shop.order.v1.paid") {
  return {
    name,
    id,
    correlationId: id,
    causationId: null,
    publishedAt: new Date().toISOString(),
  };
}

test("sent once by default: a failure is set aside at once, and the next goes on", async () => {
  class PrinterOff extends Error {
    static readonly failureKind = "unavailable";
  }
  const seen: string[] = [];
  const store = memoryMessageStore();
  const queue = storedQueue({
    store,
    subscriber: new Subscriber(flaky("printer", [new PrinterOff("printer off")], seen)),
  });
  await queue.put(new OrderPaid("o-11"), envelope("e-11"));
  await queue.put(new OrderPaid("o-12"), envelope("e-12"));
  await queue.drain();
  assert.deepEqual(
    store.messages.map((one) => [one.state, one.attempts, one.retryAt]),
    [
      ["set_aside", 1, null],
      ["delivered", 1, null],
    ],
  );
  assert.equal(store.messages[0]?.failures[0]?.kind, "unavailable");
  assert.deepEqual(seen, ["printer o-12 true"]);
});

test("out of retries a failure is set aside; one waiting its time never holds the line", async () => {
  const seen: string[] = [];
  const store = memoryMessageStore();
  const queue = storedQueue({
    store,
    subscriber: new Subscriber(flaky("mail", [new TypeError("a bug")], seen)),
    policyOf: (stored) => (stored.envelope.id === "e-8" ? { retries: 1 } : undefined),
    wait: 60_000,
  });
  await queue.put(new OrderPaid("o-8"), envelope("e-8"));
  await queue.put(new OrderPaid("o-9"), envelope("e-9"));
  await queue.drain();
  assert.deepEqual(
    store.messages.map((one) => one.state),
    ["pending", "delivered"],
    "the one waiting to be sent again lets the next go",
  );
  assert.deepEqual(seen, ["mail o-9 true"]);
});

test("its work over the network: the other side not there waits, as long as it takes, until maxAttempts", async () => {
  class NoAnswer extends Error {
    static readonly failureKind = "unknown_outcome";
  }
  const store = memoryMessageStore();
  const failures = [new NoAnswer("sent, no answer"), new NoAnswer("sent, no answer")];
  const queue = storedQueue({
    store,
    subscriber: new Subscriber(flaky("sync", failures, [])),
    policy: { requiresNetwork: true, maxAttempts: 2 },
    wait: 1,
  });
  await queue.put(new OrderPaid("o-14"), envelope("e-14"));
  await queue.drain();
  assert.equal(store.messages[0]?.state, "pending", "no answer is no failure: it waits");
  assert.equal(store.messages[0]?.failures[0]?.kind, "unknown_outcome");
  await pause(20);
  await queue.drain();
  assert.deepEqual(
    [store.messages[0]?.state, store.messages[0]?.attempts],
    ["set_aside", 2],
    "maxAttempts bounds the wait",
  );
});

test("the verdict is extended by wrapping it: a dropped connection waits for ready, with no time", async () => {
  class NetworkDown extends Error {
    static readonly failureKind = "unavailable";
    readonly reason = "NETWORK_DOWN";
  }
  const seen: string[] = [];
  let online = true;
  const store = memoryMessageStore();
  const queue = storedQueue({
    store,
    subscriber: new Subscriber(flaky("sync", [new NetworkDown("offline")], seen)),
    ready: () => online,
    verdict: (delivery) =>
      delivery.errors.some(
        (error) => (error as { reason?: string }).reason === "NETWORK_DOWN",
      )
        ? { settlement: "wait" }
        : verdictOf(delivery),
  });
  await queue.put(new OrderPaid("o-15"), envelope("e-15"));
  online = false;
  await queue.drain();
  assert.deepEqual(
    [store.messages[0]?.state, store.messages[0]?.retryAt],
    ["pending", null],
    "it waits for the connection, not a time",
  );
  await queue.drain();
  assert.deepEqual(seen, [], "not ready: not sent");
  online = true;
  await queue.drain();
  assert.equal(store.messages[0]?.state, "delivered");
  assert.deepEqual(seen, ["sync o-15 true"]);
});

test("an open circuit makes a message whose work goes over the network wait what it asks", async () => {
  const breaker = new CircuitBreaker("odoo", { failures: 1, openFor: 30_000 });
  await assert.rejects(
    breaker.call(() => Promise.reject(new TransportError("/x", 503, null))),
  );
  class Push extends Feature<OrderPaid, void> {
    execute(): Promise<void> {
      return breaker.call(() => undefined);
    }
  }
  const sync = new BoundedContext("sync");
  sync.feature(OrderPaid)(Push);
  const store = memoryMessageStore();
  const queue = storedQueue({
    store,
    subscriber: new Subscriber(sync),
    policy: { requiresNetwork: true },
    wait: 1,
  });
  const before = Date.now();
  await queue.put(new OrderPaid("o-10"), envelope("e-10"));
  await queue.drain();
  const waiting = store.messages[0];
  assert.equal(waiting?.state, "pending");
  assert.equal(waiting?.failures[0]?.reason, "CIRCUIT_OPEN");
  assert.ok(Date.parse(waiting?.retryAt ?? "") - before >= 29_000);
});

test("a subscriber keys what it does by the envelope's id; fromJSON reads a Money back as one", async () => {
  class InvoicePaid extends DomainEvent {
    static readonly eventName = "billing.invoice.v1.paid";
    static fromJSON(values: {
      invoice_id: string;
      total: { amount: string; currency: string };
    }) {
      return new InvoicePaid(
        values.invoice_id,
        new Money(values.total.amount, values.total.currency),
      );
    }
    constructor(
      readonly invoice_id: string,
      readonly total: Money,
    ) {
      super();
    }
  }
  const keys: (string | undefined)[] = [];
  const totals: string[] = [];
  class Record extends Feature<InvoicePaid, void> {
    execute(event: InvoicePaid): void {
      keys.push(this.execution.causationId);
      totals.push(event.total.plus(new Money("1.00", "BOB")).amount.toString());
    }
  }
  const ledger = new BoundedContext("ledger");
  ledger.feature(InvoicePaid)(Record);
  const queue = storedQueue({
    store: memoryMessageStore(),
    subscriber: new Subscriber(ledger),
  });
  await queue.put(
    new InvoicePaid("i-1", new Money("10.50", "BOB")),
    envelope("e-11", "billing.invoice.v1.paid"),
  );
  await queue.drain();
  assert.deepEqual(keys, ["e-11"]);
  assert.deepEqual(totals, ["11.50"]);
});
