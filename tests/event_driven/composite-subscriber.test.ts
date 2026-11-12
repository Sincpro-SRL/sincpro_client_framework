import assert from "node:assert/strict";

import {
  BoundedContext,
  Command,
  configureProcess,
  DomainEvent,
  envelopeOf,
  EventHandler,
  eventMessageOf,
  type ExecutionStarted,
  failureOf,
  Feature,
  handlersWith,
  memoryEventStore,
  processListeners,
  servicesWith,
  storedQueue,
  Subscriber,
} from "@sincpro/client-framework";
import { memoryTracer } from "@sincpro/client-framework/testing";
import { afterEach, beforeEach, test } from "vitest";

import { registerClass, type RegistrationStyle } from "../support/core-registration";

class SalePaid extends DomainEvent {
  static readonly eventName = "sales.sale.v1.paid";
  constructor(readonly saleId: string) {
    super();
  }
}

class SaleCancelled extends DomainEvent {
  static readonly eventName = "sales.sale.v1.cancelled";
  constructor(readonly saleId: string) {
    super();
  }
}

class CommandCloseSale extends Command<string> {
  constructor(readonly saleId: string) {
    super();
  }
}

class CommandIssueInvoice extends Command<string> {
  constructor(readonly saleId: string) {
    super();
  }
}

/** Raised by a handler to fail once — retryable — and then succeed. */
class StillOffline extends Error {
  static readonly failureKind = "unavailable";
  static readonly retryAfter = 0;
}

let tracer = memoryTracer();
const said: string[] = [];
const failures: unknown[] = [];

beforeEach(() => {
  tracer = memoryTracer();
  configureProcess({ tracer, logger: { engine: false } });
  said.length = 0;
  failures.length = 0;
});

afterEach(() => configureProcess({ logger: { engine: false } }));

type SalesDependencies = { ledger: { record(line: string): void } };
type InvoicingDependencies = Record<never, never>;
type AppDependencies = {
  invoicingBoundedContext: BoundedContext<InvoicingDependencies>;
  notifier: { notify(text: string): void };
};

/** The three ways an event is consumed: a use case, a bus's handler, a subscriber's handler. */
function application() {
  const sales = servicesWith<SalesDependencies>();
  const salesBoundedContext = new BoundedContext<SalesDependencies>("sales");
  salesBoundedContext.addDependency("ledger", { record: (line) => void said.push(line) });

  // 2. The use case is the handler: the event is its input.
  class RecordSale extends sales.Feature<SalePaid, void> {
    execute(event: SalePaid): void {
      this.ledger.record(`ledger ${event.saleId}`);
    }
  }
  salesBoundedContext.feature(SalePaid)(RecordSale);

  class CloseSale extends sales.Feature<CommandCloseSale, string> {
    execute(command: CommandCloseSale): string {
      said.push(`closed ${command.saleId} by ${this.execution.parent?.useCase}`);
      return `closed ${command.saleId}`;
    }
  }
  salesBoundedContext.feature(CommandCloseSale)(CloseSale);

  // 3. A handler of the bus: its dependencies, and the bus itself.
  class OnSaleChanged extends sales.EventHandler<SalePaid | SaleCancelled> {
    async handle(event: SalePaid | SaleCancelled): Promise<void> {
      const failure = failures.shift();
      if (failure !== undefined) throw failure;
      this.ledger.record(`${event.name} ${event.saleId}`);
      if (event instanceof SalePaid)
        await this.boundedContext.execute(new CommandCloseSale(event.saleId));
    }
  }
  salesBoundedContext.handler([SalePaid, SaleCancelled])(OnSaleChanged);

  const invoicingBoundedContext = new BoundedContext<InvoicingDependencies>("invoicing");
  class IssueInvoice extends Feature<CommandIssueInvoice, string> {
    execute(command: CommandIssueInvoice): string {
      said.push(`invoice ${command.saleId} caused by ${this.execution.parent?.useCase}`);
      return `invoice ${command.saleId}`;
    }
  }
  invoicingBoundedContext.feature(CommandIssueInvoice)(IssueInvoice);

  // 1. A subscriber of its own: explicit dependencies, a bus to call among them.
  const { EventHandler: AppHandler } = handlersWith<AppDependencies>();
  const appSubscriber = new Subscriber<AppDependencies>("app");
  appSubscriber.addDependency("invoicingBoundedContext", invoicingBoundedContext);
  appSubscriber.addDependency("notifier", { notify: (text) => void said.push(text) });
  appSubscriber.addBus(salesBoundedContext);

  class NotifySalePaid extends AppHandler<SalePaid> {
    async handle(event: SalePaid): Promise<void> {
      said.push(`message ${this.execution.causationId}`);
      await this.invoicingBoundedContext.execute(new CommandIssueInvoice(event.saleId));
      this.notifier.notify(`paid ${event.saleId}`);
    }
  }
  appSubscriber.handler([SalePaid])(NotifySalePaid);

  return { appSubscriber, salesBoundedContext, invoicingBoundedContext };
}

test("one event, three consumers: the subscriber's handler, the bus's use case and the bus's handler", async () => {
  const { appSubscriber } = application();
  const paid = new SalePaid("s-1");
  const envelope = envelopeOf(paid);
  const handled = await appSubscriber.handle(paid, envelope);

  assert.deepEqual(
    handled.map((one) => one.boundedContext),
    ["app/NotifySalePaid", "sales", "sales/OnSaleChanged"],
  );
  assert.ok(handled.every((one) => !("error" in one)));
  assert.deepEqual(said, [
    `message ${envelope.id}`,
    "invoice s-1 caused by app.NotifySalePaid",
    "paid s-1",
    "ledger s-1",
    "sales.sale.v1.paid s-1",
    "closed s-1 by sales.OnSaleChanged",
  ]);
  const names = tracer.spans.map((one) => one.name);
  assert.deepEqual(names, [
    "app/NotifySalePaid",
    "invoicing/IssueInvoice",
    "sales/RecordSale",
    "sales/OnSaleChanged",
    "sales/CloseSale",
  ]);
  const [notify, invoice] = tracer.spans;
  assert.equal(
    invoice?.parentSpanId,
    notify?.spanId,
    "a bus called by a handler is its child",
  );
  assert.equal(notify?.attributes["sincpro.layer"], "event_handler");
  assert.equal(notify?.attributes["sincpro.correlation_id"], envelope.correlationId);
});

test("a handler takes N events; an event only some handlers list reaches only them", async () => {
  const { appSubscriber } = application();
  const handled = await appSubscriber.handle(new SaleCancelled("s-2"));
  assert.deepEqual(
    handled.map((one) => one.boundedContext),
    ["sales/OnSaleChanged"],
  );
  assert.deepEqual(said, ["sales.sale.v1.cancelled s-2"]);
});

test("addBus delivers, addDependency injects: two levels, never mixed", async () => {
  const { salesBoundedContext, invoicingBoundedContext } = application();
  const subscriber = new Subscriber<{ notifier: { notify(text: string): void } }>("probe");
  subscriber.addBus(salesBoundedContext).addBus(salesBoundedContext);
  const { EventHandler: ProbeHandler } = handlersWith<{
    notifier: { notify(text: string): void };
  }>();
  class ReachForTheBus extends ProbeHandler<SalePaid> {
    handle(): void {
      // An added bus is not a dependency: nothing named after it is on `this`.
      void Reflect.get(this, "salesBoundedContext");
    }
  }
  subscriber.handler([SalePaid])(ReachForTheBus);
  subscriber.addDependency("notifier", { notify: () => undefined });

  const handled = await subscriber.handle(new SalePaid("s-3"));
  assert.deepEqual(
    handled.map((one) => one.boundedContext),
    ["probe/ReachForTheBus", "sales", "sales/OnSaleChanged"],
    "the same bus added twice is delivered to once",
  );
  const reached = handled[0];
  assert.ok(reached && "error" in reached);
  assert.match(String(reached.error), /not registered: salesBoundedContext/);

  // A bus that is only a dependency is called, never delivered to.
  const onlyCalls = new Subscriber<AppDependencies>("calls");
  onlyCalls.addDependency("invoicingBoundedContext", invoicingBoundedContext);
  assert.deepEqual(await onlyCalls.handle(new SalePaid("s-4")), []);
});

test("the stored queue retries only the consumer that failed; the others are never run again", async () => {
  const { appSubscriber } = application();
  const store = memoryEventStore();
  const queue = storedQueue({ store, subscriber: appSubscriber, wait: 1 });
  failures.push(new StillOffline("no network"));
  const paid = new SalePaid("s-5");
  await queue.put(paid, envelopeOf(paid));
  await queue.drain();

  const [waiting] = store.events;
  assert.equal(waiting?.state, "pending");
  assert.deepEqual(waiting?.reached, ["app/NotifySalePaid", "sales"]);
  assert.equal(waiting?.failures[0]?.boundedContext, "sales/OnSaleChanged");
  assert.equal(waiting?.failures[0]?.kind, "unavailable");

  said.length = 0;
  // Until its retry is due — a fixed sleep lost the race under a loaded machine.
  for (let tries = 0; tries < 100 && store.events[0]?.state !== "delivered"; tries++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    await queue.drain();
  }
  assert.equal(store.events[0]?.state, "delivered");
  assert.deepEqual(said, ["sales.sale.v1.paid s-5", "closed s-5 by sales.OnSaleChanged"]);
});

test("a message from outside reaches the handlers too, continuing its flow", async () => {
  const { appSubscriber } = application();
  const paid = new SalePaid("s-6");
  const envelope = envelopeOf(paid);
  const handled = await appSubscriber.receive(eventMessageOf(paid, envelope));
  assert.equal(handled.length, 3);
  assert.equal(said[0], `message ${envelope.id}`);
});

test("the process hears a handler's run, in its own layer", async () => {
  const { appSubscriber } = application();
  const started: ExecutionStarted[] = [];
  const stop = processListeners.onStart((heard) => void started.push(heard));
  try {
    await appSubscriber.handle(new SaleCancelled("s-7"));
  } finally {
    stop();
  }
  assert.deepEqual(
    started.map((one) => `${one.layer} ${one.execution.useCase}`),
    ["event_handler sales.OnSaleChanged"],
  );
});

const STYLES: readonly RegistrationStyle[] = ["function", "decorator", "legacy-decorator"];

for (const style of STYLES) {
  test(`a handler registers the same way with ${style}, on a bus and on a subscriber`, async () => {
    const heard: string[] = [];
    const busBoundedContext = new BoundedContext("styles");
    class OnBus extends EventHandler<SalePaid> {
      handle(event: SalePaid): void {
        heard.push(`bus ${event.saleId}`);
      }
    }
    registerClass(style, OnBus, busBoundedContext.handler([SalePaid]));

    const subscriber = new Subscriber("styled");
    class OnSubscriber extends EventHandler<SalePaid> {
      handle(event: SalePaid): void {
        heard.push(`subscriber ${event.saleId}`);
      }
    }
    registerClass(style, OnSubscriber, subscriber.handler([SalePaid]));
    subscriber.addBus(busBoundedContext);

    const handled = await subscriber.handle(new SalePaid("s-8"));
    assert.deepEqual(
      handled.map((one) => one.boundedContext),
      ["styled/OnSubscriber", "styles/OnBus"],
    );
    assert.deepEqual(heard, ["subscriber s-8", "bus s-8"]);
  });
}

test("a generated event is handled by its entry, received as its data", async () => {
  const entry = { name: "shop.order.v1.shipped" } as const;
  type OrderShipped = { name: "shop.order.v1.shipped"; order_id: string };
  const subscriber = new Subscriber("shop");
  class OnShipped extends EventHandler<OrderShipped> {
    handle(event: OrderShipped): void {
      said.push(`shipped ${event.order_id}`);
    }
  }
  subscriber.handler<OrderShipped>(entry)(OnShipped);
  assert.equal(subscriber.eventTypeOf("shop.order.v1.shipped"), entry);
  await subscriber.handle({ name: "shop.order.v1.shipped", order_id: "o-1" } as OrderShipped);
  assert.deepEqual(said, ["shipped o-1"]);
});

test("a handler is registered once, for events, under a name no service of its bus has", () => {
  const boundedContext = new BoundedContext("rules");
  class Same extends Feature<CommandCloseSale, string> {
    execute(): string {
      return "";
    }
  }
  boundedContext.feature(CommandCloseSale)(Same);
  class Handles extends EventHandler<SalePaid> {
    handle(): void {}
  }
  assert.throws(
    () => boundedContext.handler([CommandCloseSale as never])(Handles),
    /registered for events/,
  );
  assert.throws(() => boundedContext.handler([])(Handles), /one event at least/);
  assert.throws(() => boundedContext.handler([SalePaid, SalePaid])(Handles), /twice/);
  boundedContext.handler([SalePaid])(Handles);
  assert.throws(
    () => boundedContext.handler([SaleCancelled])(Handles),
    /list all its events/,
  );
  const collides = {
    Same: class extends EventHandler<SalePaid> {
      handle(): void {}
    },
  };
  Object.defineProperty(collides.Same, "name", { value: "Same" });
  assert.throws(() => boundedContext.handler([SalePaid])(collides.Same), /name already/);
  class NotAHandler {
    handle(): void {}
  }
  assert.throws(
    () => boundedContext.handler([SalePaid])(NotAHandler),
    /extends EventHandler/,
  );
  assert.throws(
    () =>
      new Subscriber(boundedContext).handler([SalePaid])(
        class Anonymous extends EventHandler<SalePaid> {
          handle(): void {}
        },
      ),
    /has a name/,
  );
  assert.equal(failureOf(new StillOffline("x")).kind, "unavailable");
});

class SaleRefunded extends DomainEvent {
  static readonly eventName = "sales.sale.v1.refunded";
  constructor(readonly refundId: string) {
    super();
  }
}

// Types only: a handler accepts every event it is registered for, or it does not compile.
export function typesOnly(boundedContext: BoundedContext): void {
  class OnlyPaid extends EventHandler<SalePaid> {
    handle(event: SalePaid): void {
      void event.saleId;
    }
  }
  // @ts-expect-error — it is registered for SaleRefunded too, which it does not take.
  boundedContext.handler([SalePaid, SaleRefunded])(OnlyPaid);
  boundedContext.handler([SalePaid])(OnlyPaid);
}
