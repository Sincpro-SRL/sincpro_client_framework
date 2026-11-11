import assert from "node:assert/strict";

import {
  ApplicationService,
  BoundedContext,
  Command,
  configureProcess,
  DomainEvent,
  Feature,
} from "@sincpro/client-framework";
import { memoryReporter, memoryTracer } from "@sincpro/client-framework/testing";
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

class OrderShipped extends DomainEvent {
  static readonly eventName = "shop.order.v1.shipped";
  constructor(readonly order_id: string) {
    super();
  }
}

class CommandNotify extends Command<string> {
  constructor(readonly text: string) {
    super();
  }
}

class Notify extends Feature<CommandNotify, string> {
  declare readonly sent: string[];
  execute(command: CommandNotify): string {
    this.sent.push(command.text);
    return command.text;
  }
}

class ThankCustomer extends Feature<OrderPaid, string> {
  declare readonly sent: string[];
  execute(event: OrderPaid): string {
    if (event.fail) throw event.fail;
    this.sent.push(`thanks for ${event.order_id}`);
    return event.order_id;
  }
}

class ShipAndNotify extends ApplicationService<OrderShipped, void> {
  async execute(event: OrderShipped): Promise<void> {
    await this.featureBus.execute(new CommandNotify(`shipped ${event.order_id}`));
    await this.featureBus.execute(new OrderPaid(event.order_id));
  }
}

function shop() {
  const sent: string[] = [];
  const context = new BoundedContext<{ sent: string[] }>("shop");
  context.addDependency("sent", sent);
  context.feature(CommandNotify)(Notify);
  context.feature(OrderPaid)(ThankCustomer);
  context.appService(OrderShipped)(ShipAndNotify);
  return { context, sent };
}

beforeEach(() => configureProcess({ logger: { engine: false } }));

test("an event is executed by its subscriber, as a use case: its span says which event", async () => {
  const tracer = memoryTracer();
  configureProcess({ tracer, logger: { engine: false } });
  const { context, sent } = shop();
  const event = new OrderPaid("o-1");
  assert.equal(event.name, "shop.order.v1.paid");
  assert.equal(await context.execute(event), "o-1");
  assert.deepEqual(sent, ["thanks for o-1"]);
  const [span] = tracer.spans;
  assert.equal(span?.name, "shop/ThankCustomer");
  assert.equal(span?.attributes["sincpro.event"], "shop.order.v1.paid");
  assert.equal(span?.attributes["sincpro.layer"], "feature");
  assert.equal(span?.outcome, "ok");
});

test("an ApplicationService subscribed to an event composes Features, Commands and events alike", async () => {
  const tracer = memoryTracer();
  configureProcess({ tracer, logger: { engine: false } });
  const { context, sent } = shop();
  await context.execute(new OrderShipped("o-2"));
  assert.deepEqual(sent, ["shipped o-2", "thanks for o-2"]);
  const [parent, ...children] = tracer.spans;
  assert.deepEqual(
    tracer.spans.map((span) => span.name),
    ["shop/ShipAndNotify", "shop/Notify", "shop/ThankCustomer"],
  );
  for (const child of children) assert.equal(child.parentSpanId, parent?.spanId);
});

test("a subscriber's failure is reported once and answered by the bounded context's handlers", async () => {
  const reporter = memoryReporter();
  configureProcess({ reporter, logger: { engine: false } });
  const { context } = shop();
  await assert.rejects(context.execute(new OrderPaid("o-3", new Error("mail down"))), /mail/);
  assert.equal(reporter.reports[0]?.about.useCase, "shop.ThankCustomer");
  class Bounced extends Error {}
  context.expectErrors(Bounced).addFeatureErrorHandler(() => "skipped");
  assert.equal(await context.execute(new OrderPaid("o-4", new Bounced())), "skipped");
  assert.equal(reporter.reports.length, 1);
});

test("eventTypeOf tells which class a wire name is rebuilt as here, or that nothing here hears it", () => {
  const { context } = shop();
  assert.equal(context.eventTypeOf("shop.order.v1.paid"), OrderPaid);
  assert.equal(context.eventTypeOf("shop.order.v1.shipped"), OrderShipped);
  assert.equal(context.eventTypeOf("billing.invoice.v1.paid"), undefined);
  assert.equal(context.handlerOf(OrderPaid), ThankCustomer);
});

test("an event needs its name, one name means one event, and one event has one subscriber here", () => {
  class Nameless extends DomainEvent {}
  class Again extends DomainEvent {
    static readonly eventName = "shop.order.v1.paid";
  }
  class Listener extends Feature<DomainEvent, void> {
    execute() {}
  }
  class Other extends Feature<DomainEvent, void> {
    execute() {}
  }
  const { context } = shop();
  // @ts-expect-error An event class declares its eventName.
  assert.throws(() => context.feature(Nameless)(Listener), /eventName/);
  assert.throws(() => context.feature(Again)(Listener), /Event name already registered/);
  assert.throws(() => context.feature(OrderPaid)(Other), /already registered/);
  assert.equal(new Nameless().name, "");
});

test("only a Command or a DomainEvent class has a service", () => {
  class Plain {}
  class Listener extends Feature<CommandNotify, string> {
    execute() {
      return "";
    }
  }
  const { context } = shop();
  // @ts-expect-error A plain class is neither a Command nor a DomainEvent.
  assert.throws(() => context.feature(Plain)(Listener), /Command or a DomainEvent/);
});
