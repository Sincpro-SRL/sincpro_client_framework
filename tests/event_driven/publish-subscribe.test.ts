import assert from "node:assert/strict";

import {
  BoundedContext,
  Command,
  configureProcess,
  DomainEvent,
  type Envelope,
  Feature,
  type MessageQueue,
  Publisher,
  Subscriber,
  syncQueue,
} from "@sincpro/client-framework";
import { memoryTracer } from "@sincpro/client-framework/testing";
import { beforeEach, test } from "vitest";

class OrderPaid extends DomainEvent {
  static readonly eventName = "shop.order.v1.paid";
  constructor(
    readonly order_id: string,
    readonly fail?: Error,
  ) {
    super();
  }
}

class CommandPay extends Command<string> {
  constructor(readonly order_id: string) {
    super();
  }
}

/** Pays, and tells whoever listens. */
class Pay extends Feature<CommandPay, string> {
  declare readonly publisher: Publisher;
  async execute(command: CommandPay): Promise<string> {
    await this.publisher.publish(new OrderPaid(command.order_id));
    return command.order_id;
  }
}

class SendReceipt extends Feature<OrderPaid, string> {
  declare readonly sent: string[];
  execute(event: OrderPaid): string {
    if (event.fail) throw event.fail;
    this.sent.push(`receipt ${event.order_id}`);
    return "sent";
  }
}

class Reserve extends Feature<OrderPaid, string> {
  declare readonly sent: string[];
  execute(event: OrderPaid): string {
    this.sent.push(`reserved ${event.order_id}`);
    return "reserved";
  }
}

function application() {
  const sent: string[] = [];
  const mail = new BoundedContext<{ sent: string[] }>("mail");
  mail.addDependency("sent", sent).feature(OrderPaid)(SendReceipt);
  const stock = new BoundedContext<{ sent: string[] }>("stock");
  stock.addDependency("sent", sent).feature(OrderPaid)(Reserve);
  const subscriber = new Subscriber(mail, stock);
  const shop = new BoundedContext<{ publisher: Publisher }>("shop");
  shop.addDependency("publisher", new Publisher(syncQueue(subscriber)));
  shop.feature(CommandPay)(Pay);
  return { shop, mail, stock, subscriber, sent };
}

beforeEach(() => configureProcess({ logger: { engine: false } }));

test("what a Feature publishes, every bounded context that hears it executes, in the same flow", async () => {
  const tracer = memoryTracer();
  configureProcess({ tracer, logger: { engine: false } });
  const { shop, sent } = application();
  assert.equal(await shop.execute(new CommandPay("o-1")), "o-1");
  assert.deepEqual(sent, ["receipt o-1", "reserved o-1"]);
  const [pay, receipt, reserve] = tracer.spans;
  assert.deepEqual(
    tracer.spans.map((span) => span.name),
    ["shop/Pay", "mail/SendReceipt", "stock/Reserve"],
  );
  const flow = pay?.attributes["sincpro.correlation_id"];
  for (const subscriber of [receipt, reserve]) {
    assert.equal(subscriber?.attributes["sincpro.correlation_id"], flow);
    assert.equal(subscriber?.attributes["sincpro.event"], "shop.order.v1.paid");
    assert.notEqual(subscriber?.attributes["sincpro.causation_id"], undefined);
  }
});

test("the envelope names the event, its flow and the run that published it", async () => {
  const put: Envelope[] = [];
  const recording: MessageQueue = {
    put: (_event, envelope) => void put.push(envelope),
    send: (_command, envelope) => void put.push(envelope),
  };
  const shop = new BoundedContext<{ publisher: Publisher }>("shop");
  shop.addDependency("publisher", new Publisher(recording)).feature(CommandPay)(Pay);
  const tracer = memoryTracer();
  configureProcess({ tracer, logger: { engine: false } });
  await shop.execute(new CommandPay("o-2"));
  const [envelope] = put;
  assert.equal(envelope?.name, "shop.order.v1.paid");
  assert.equal(envelope?.causationId, tracer.spans[0]?.attributes["sincpro.execution_id"]);
  assert.equal(
    envelope?.correlationId,
    tracer.spans[0]?.attributes["sincpro.correlation_id"],
  );
  assert.match(envelope?.publishedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
  // Outside a run, an event is the head of its own flow.
  const head = await new Publisher(recording).publish(new OrderPaid("o-3"));
  assert.equal(head.correlationId, head.id);
  assert.equal(head.causationId, null);
});

test("a subscriber that fails does not stop the others; the in-call queue then tells the publisher", async () => {
  const { mail, stock, subscriber, sent } = application();
  const broken = new Error("mail server down");
  const handled = await subscriber.handle(new OrderPaid("o-4", broken));
  assert.deepEqual(handled, [
    { boundedContext: "mail", error: broken },
    { boundedContext: "stock", answer: "reserved" },
  ]);
  assert.deepEqual(sent, ["reserved o-4"]);
  const queue = syncQueue(new Subscriber(mail, stock));
  await assert.rejects(
    async () =>
      queue.put(new OrderPaid("o-5", broken), {
        name: "shop.order.v1.paid",
        id: "e-5",
        correlationId: "e-5",
        causationId: null,
        publishedAt: new Date().toISOString(),
      }),
    /mail server down/,
  );
});

test("a queue rebuilds a stored event by the class its name is heard as", () => {
  const { subscriber } = application();
  assert.equal(subscriber.eventTypeOf("shop.order.v1.paid"), OrderPaid);
  assert.equal(subscriber.eventTypeOf("shop.order.v1.refunded"), undefined);
});

test("an event nobody hears is delivered to nobody, and one without a name is not published", async () => {
  class Unheard extends DomainEvent {
    static readonly eventName = "shop.order.v1.unheard";
  }
  class Nameless extends DomainEvent {}
  const { subscriber } = application();
  assert.deepEqual(await subscriber.handle(new Unheard()), []);
  await assert.rejects(
    new Publisher(syncQueue(subscriber)).publish(new Nameless()),
    /no eventName/,
  );
});
