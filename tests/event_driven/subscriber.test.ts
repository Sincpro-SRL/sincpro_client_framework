import assert from "node:assert/strict";

import {
  BoundedContext,
  Command,
  commandFrom,
  commandMessageOf,
  CommandNotConsumed,
  configureProcess,
  DomainEvent,
  envelopeOf,
  eventFrom,
  eventMessageOf,
  failureOf,
  Feature,
  memoryEventStore,
  Money,
  storedQueue,
  Subscriber,
} from "@sincpro/client-framework";
import { memoryTracer } from "@sincpro/client-framework/testing";
import { beforeEach, test } from "vitest";

class InvoiceIssued extends DomainEvent {
  static readonly eventName = "billing.invoice.v1.issued";
  static fromJSON(values: {
    invoice_id: string;
    total: { amount: string; currency: string };
  }) {
    return new InvoiceIssued(
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

class InvoiceVoided extends DomainEvent {
  static readonly eventName = "billing.invoice.v1.voided";
  constructor(readonly invoice_id: string) {
    super();
  }
}

class CommandIssueInvoice extends Command<string> {
  static readonly commandName = "billing.CommandIssueInvoice";
  constructor(readonly order_id: string) {
    super();
  }
}

class CommandWithoutIdentity extends Command<string> {}

/** A backend's event, generated: a type and its entry — no class. */
type OrderShipped = { name: "shop.order.v1.shipped"; order_id: string };
const events = {
  OrderShipped: { name: "shop.order.v1.shipped", recorded: false, handled: true },
} as const;

function application() {
  const heard: string[] = [];
  class Book extends Feature<InvoiceIssued | InvoiceVoided | OrderShipped, void> {
    execute(event: InvoiceIssued | InvoiceVoided | OrderShipped): void {
      const total = event instanceof InvoiceIssued ? ` ${event.total.amount.toString()}` : "";
      heard.push(`accounting ${event.name}${total}`);
    }
  }
  class IssueInvoice extends Feature<CommandIssueInvoice | InvoiceVoided, string> {
    execute(input: CommandIssueInvoice | InvoiceVoided): string {
      const said = input instanceof CommandIssueInvoice ? input.order_id : input.invoice_id;
      heard.push(`billing ${said} ${this.execution.correlationId}`);
      return `invoice for ${said}`;
    }
  }
  const accountingBoundedContext = new BoundedContext("accounting");
  accountingBoundedContext.feature([InvoiceIssued, InvoiceVoided, events.OrderShipped])(Book);
  const billingBoundedContext = new BoundedContext("billing");
  billingBoundedContext.feature([CommandIssueInvoice, InvoiceVoided])(IssueInvoice);
  return { heard, accountingBoundedContext, billingBoundedContext };
}

beforeEach(() => configureProcess({ logger: { engine: false } }));

test("the subscriber hears every event its bounded contexts registered, and hands each to all who did", async () => {
  const { heard, accountingBoundedContext, billingBoundedContext } = application();
  const subscriber = new Subscriber(accountingBoundedContext, billingBoundedContext);
  const voided = new InvoiceVoided("i-1");
  const handled = await subscriber.receive(eventMessageOf(voided, envelopeOf(voided)));
  assert.deepEqual(
    handled.map((one) => one.boundedContext),
    ["accounting", "billing"],
  );
  assert.equal(heard[0], "accounting billing.invoice.v1.voided");
  assert.match(heard[1] ?? "", /^billing i-1 /);
});

test("an event is rebuilt as its class — fromJSON for its values —, a generated one as its data", async () => {
  const { heard, accountingBoundedContext } = application();
  const subscriber = new Subscriber(accountingBoundedContext);
  const issued = new InvoiceIssued("i-2", new Money("10.50", "BOB"));
  const message = JSON.parse(JSON.stringify(eventMessageOf(issued, envelopeOf(issued))));
  await subscriber.receive(message);
  const shipped = { name: "shop.order.v1.shipped", order_id: "o-1" } satisfies OrderShipped;
  await subscriber.receive(eventMessageOf(shipped, envelopeOf(shipped)));
  assert.deepEqual(heard, [
    "accounting billing.invoice.v1.issued 10.50",
    "accounting shop.order.v1.shipped",
  ]);
  const rebuilt = eventFrom(InvoiceIssued, message.data);
  assert.ok(rebuilt instanceof InvoiceIssued && rebuilt.total instanceof Money);
});

test("a subscriber may hear only the events it names", async () => {
  const { heard, accountingBoundedContext } = application();
  const subscriber = new Subscriber({
    boundedContexts: [accountingBoundedContext],
    events: [InvoiceVoided],
  });
  assert.equal(subscriber.eventTypeOf("billing.invoice.v1.issued"), undefined);
  const issued = new InvoiceIssued("i-3", new Money("1", "BOB"));
  assert.deepEqual(await subscriber.receive(eventMessageOf(issued, envelopeOf(issued))), []);
  const voided = new InvoiceVoided("i-3");
  await subscriber.receive(eventMessageOf(voided, envelopeOf(voided)));
  assert.deepEqual(heard, ["accounting billing.invoice.v1.voided"]);
});

test("a Command from the queue runs only when declared, in the one bus that registered it, continuing its flow", async () => {
  const tracer = memoryTracer();
  configureProcess({ tracer, logger: { engine: false } });
  const { heard, accountingBoundedContext, billingBoundedContext } = application();
  const message = JSON.parse(
    JSON.stringify(
      commandMessageOf(new CommandIssueInvoice("o-9"), {
        id: "cause",
        correlationId: "flow",
      }),
    ),
  );
  assert.equal(message.type, "billing.CommandIssueInvoice");
  const everything = new Subscriber(accountingBoundedContext, billingBoundedContext);
  await assert.rejects(everything.receive(message), (error: unknown) => {
    assert.ok(error instanceof CommandNotConsumed);
    assert.equal(failureOf(error).kind, "permission_denied");
    return true;
  });
  const consuming = new Subscriber({
    boundedContexts: [accountingBoundedContext, billingBoundedContext],
    commands: [CommandIssueInvoice],
  });
  assert.deepEqual(await consuming.receive(message), [
    { boundedContext: "billing", answer: "invoice for o-9" },
  ]);
  assert.deepEqual(heard, ["billing o-9 flow"]);
  assert.equal(tracer.spans.at(-1)?.attributes["sincpro.causation_id"], message.id);
});

test("a Command travels by its identity: one without it does not travel", () => {
  assert.throws(() => commandMessageOf(new CommandWithoutIdentity()), /has no identity/);
  const message = commandMessageOf(new CommandIssueInvoice("o-1"));
  assert.equal(message.correlationid, message.id);
  assert.equal(message.causationid, undefined);
  const rebuilt = commandFrom(CommandIssueInvoice, message.data);
  assert.ok(rebuilt instanceof CommandIssueInvoice && rebuilt.order_id === "o-1");
});

test("the stored queue delivers a generated event through the subscriber, rebuilt as its data", async () => {
  const { heard, accountingBoundedContext } = application();
  const store = memoryEventStore();
  const queue = storedQueue({ store, subscriber: new Subscriber(accountingBoundedContext) });
  const shipped = { name: "shop.order.v1.shipped", order_id: "o-2" } satisfies OrderShipped;
  await queue.put(shipped, envelopeOf(shipped));
  await queue.drain();
  assert.equal(store.events[0]?.state, "delivered");
  assert.deepEqual(heard, ["accounting shop.order.v1.shipped"]);
});

test("the same bus added twice is one; another bus of the same name is delivered to as well, under its own key", async () => {
  const { billingBoundedContext } = application();
  const otherBilling = new BoundedContext("billing");
  const heardByOther: string[] = [];
  class AlsoIssue extends Feature<InvoiceVoided, void> {
    execute(event: InvoiceVoided): void {
      heardByOther.push(event.invoice_id);
    }
  }
  otherBilling.feature(InvoiceVoided)(AlsoIssue);
  const subscriber = new Subscriber(
    billingBoundedContext,
    billingBoundedContext,
    otherBilling,
  );
  const handled = await subscriber.handle(new InvoiceVoided("i-9"));
  assert.deepEqual(
    handled.map((one) => one.boundedContext),
    ["billing", "billing#2"],
  );
  assert.deepEqual(heardByOther, ["i-9"]);
});
