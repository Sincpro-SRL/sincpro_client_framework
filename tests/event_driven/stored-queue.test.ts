import assert from "node:assert/strict";

import {
  BoundedContext,
  CircuitBreaker,
  configureProcess,
  DomainEvent,
  Feature,
  memoryEventStore,
  Money,
  Publisher,
  type StoredEvent,
  storedQueue,
  Subscriber,
  TransportError,
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
  const store = memoryEventStore();
  const queue = storedQueue({ store, subscriber: new Subscriber(flaky("mail", [], seen)) });
  const envelope = await new Publisher(queue).publish(new OrderPaid("o-1"));
  assert.equal(store.events[0]?.envelope.id, envelope.id);
  await queue.drain();
  assert.deepEqual(seen, ["mail o-1 true"]);
  assert.equal(store.events[0]?.state, "delivered");
  assert.equal(tracer.spans[0]?.attributes["sincpro.causation_id"], envelope.id);
});

test("a failure a retry may fix waits and tries again; a context that has it is not run twice", async () => {
  const seen: string[] = [];
  const store = memoryEventStore();
  const settled: StoredEvent[] = [];
  const queue = storedQueue({
    store,
    subscriber: new Subscriber(
      flaky("mail", [], seen),
      flaky("stock", [new TransportError("/stock", 503, null)], seen),
    ),
    wait: 5,
    onSettled: (one) => settled.push(one),
  });
  await queue.put(new OrderPaid("o-2"), envelope("e-2"));
  await queue.drain();
  assert.equal(store.events[0]?.state, "pending");
  assert.deepEqual(store.events[0]?.reached, ["mail"]);
  assert.deepEqual(
    store.events[0]?.failures.map((one) => [one.boundedContext, one.kind]),
    [["stock", "unavailable"]],
  );
  await pause(1100);
  await queue.drain();
  assert.equal(store.events[0]?.state, "delivered");
  assert.deepEqual(seen, ["mail o-2 true", "stock o-2 true"]);
  assert.deepEqual(
    settled.map((one) => one.state),
    ["pending", "delivered"],
  );
});

test("a failure every attempt would repeat is set aside, and does not hold back what follows", async () => {
  const seen: string[] = [];
  const store = memoryEventStore();
  const queue = storedQueue({
    store,
    subscriber: new Subscriber(flaky("mail", [new Refused("no customer email")], seen)),
  });
  await queue.put(new OrderPaid("o-3"), envelope("e-3"));
  await queue.put(new OrderPaid("o-4"), envelope("e-4"));
  await queue.drain();
  assert.deepEqual(
    store.events.map((one) => one.state),
    ["set_aside", "delivered"],
  );
  assert.deepEqual(store.events[0]?.failures[0], {
    boundedContext: "mail",
    kind: "domain",
    reason: "DOMAIN",
    message: "no customer email",
  });
  assert.deepEqual(seen, ["mail o-4 true"]);
});

test("an event not ready waits while the rest go on; nobody hearing it is no failure", async () => {
  const seen: string[] = [];
  const store = memoryEventStore();
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
    store.events.map((one) => one.state),
    ["pending", "delivered"],
  );
  online = true;
  await queue.drain();
  assert.equal(store.events[0]?.state, "delivered");
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
    store: memoryEventStore(),
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

test("an event that keeps failing in a way a retry might fix is set aside after maxAttempts", async () => {
  const seen: string[] = [];
  const store = memoryEventStore();
  const queue = storedQueue({
    store,
    subscriber: new Subscriber(
      flaky("mail", [new TypeError("a bug"), new TypeError("a bug")], seen),
    ),
    maxAttempts: 2,
    wait: 1,
  });
  await queue.put(new OrderPaid("o-8"), envelope("e-8"));
  await queue.put(new OrderPaid("o-9"), envelope("e-9"));
  await queue.drain();
  assert.equal(store.events[0]?.state, "pending");
  await pause(1100);
  await queue.drain();
  assert.deepEqual(
    store.events.map((one) => [one.state, one.attempts]),
    [
      ["set_aside", 2],
      ["delivered", 1],
    ],
  );
  assert.equal(store.events[0]?.failures[0]?.kind, "internal");
  assert.deepEqual(seen, ["mail o-9 true"]);
});

test("an open circuit makes the queue wait what the circuit asks", async () => {
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
  const store = memoryEventStore();
  const queue = storedQueue({ store, subscriber: new Subscriber(sync), wait: 1 });
  const before = Date.now();
  await queue.put(new OrderPaid("o-10"), envelope("e-10"));
  await queue.drain();
  const waiting = store.events[0];
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
    store: memoryEventStore(),
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
