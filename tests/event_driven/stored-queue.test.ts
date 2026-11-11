import assert from "node:assert/strict";

import {
  BoundedContext,
  configureProcess,
  DomainEvent,
  Feature,
  memoryEventStore,
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
    static readonly serviceName = `Hear${name}`;
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
    static readonly serviceName = "Close";
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
