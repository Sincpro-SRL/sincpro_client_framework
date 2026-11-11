import assert from "node:assert/strict";

import {
  ApplicationService,
  BoundedContext,
  Command,
  configureProcess,
  DomainEvent,
  envelopeOf,
  EventSubscriber,
  Feature,
  memoryEventStore,
  storedQueue,
  Subscriber,
  Subscriptions,
  TransportError,
} from "@sincpro/client-framework";
import {
  memoryLogger,
  memoryReporter,
  memoryTracer,
} from "@sincpro/client-framework/testing";
import { beforeEach, test } from "vitest";

import { registerClass } from "../support/core-registration";

class OdooLoggedIn extends DomainEvent {
  static readonly eventName = "odoo.session.v1.logged_in";
  constructor(readonly uid: number) {
    super();
  }
}

class RouteClosed extends DomainEvent {
  static readonly eventName = "distribution.route.v1.closed";
  constructor(readonly route_id: string) {
    super();
  }
}

class CommandPrepareSession extends Command<string> {
  constructor(readonly uid: number) {
    super();
  }
}

class CommandSyncTickets extends Command<number> {
  constructor(readonly uid: number) {
    super();
  }
}

class CommandStartDay extends Command<string> {
  constructor(readonly uid: number) {
    super();
  }
}

class Locked extends Error {}

class PrepareSession extends Feature<CommandPrepareSession, string> {
  static readonly serviceName = "PrepareSession";
  declare readonly failures: unknown[];
  execute(command: CommandPrepareSession): string {
    const failure = this.failures.shift();
    if (failure !== undefined) throw failure;
    return `session ${command.uid}`;
  }
}

class SyncTickets extends Feature<CommandSyncTickets, number> {
  static readonly serviceName = "SyncTickets";
  execute(): number {
    return 3;
  }
}

/** The workflow: several use cases, in order — an ApplicationService, never the subscriber. */
class StartDay extends ApplicationService<CommandStartDay, string> {
  static readonly serviceName = "StartDay";
  async execute(command: CommandStartDay): Promise<string> {
    const session = await this.featureBus.execute(new CommandPrepareSession(command.uid));
    const synced = await this.featureBus.execute(new CommandSyncTickets(command.uid));
    return `${session}, ${synced} tickets`;
  }
}

type TicketsDependencies = { failures: unknown[] };
type TicketsEntrypoints = { ticketsBoundedContext: BoundedContext<TicketsDependencies> };

/** An entrypoint: reads the event, executes one Command — the workflow — on the bus. */
class LoggedSuccessfully extends EventSubscriber<OdooLoggedIn> {
  static readonly subscriberName = "LoggedSuccessfully";
  declare readonly ticketsBoundedContext: BoundedContext<TicketsDependencies>;
  async handle(event: OdooLoggedIn): Promise<string> {
    this.logger.info("Preparing the day");
    return this.ticketsBoundedContext.execute(new CommandStartDay(event.uid));
  }
}

function tickets(failures: unknown[] = []) {
  const ticketsBoundedContext = new BoundedContext<TicketsDependencies>("tickets");
  ticketsBoundedContext.addDependency("failures", failures);
  ticketsBoundedContext.feature(CommandPrepareSession)(PrepareSession);
  ticketsBoundedContext.feature(CommandSyncTickets)(SyncTickets);
  ticketsBoundedContext.appService(CommandStartDay)(StartDay);
  const ticketsSubscriptions = new Subscriptions<TicketsEntrypoints>("tickets-subscriptions");
  ticketsSubscriptions.addDependency("ticketsBoundedContext", ticketsBoundedContext);
  ticketsSubscriptions.subscribe(OdooLoggedIn)(LoggedSuccessfully);
  return { ticketsBoundedContext, ticketsSubscriptions };
}

beforeEach(() => configureProcess({ logger: { engine: false } }));

test("a subscriber is an entrypoint: its run calls the use cases, which continue its flow", async () => {
  const tracer = memoryTracer();
  const logs = memoryLogger();
  configureProcess({ tracer, logger: { engine: logs, level: "debug" } });
  const { ticketsSubscriptions } = tickets();
  const event = new OdooLoggedIn(7);
  const envelope = envelopeOf(event);
  assert.equal(await ticketsSubscriptions.execute(event, envelope), "session 7, 3 tickets");
  assert.deepEqual(
    tracer.spans.map((span) => [span.name, span.attributes["sincpro.layer"]]),
    [
      ["tickets-subscriptions/LoggedSuccessfully", "entrypoint"],
      ["tickets/StartDay", "application_service"],
      ["tickets/PrepareSession", "feature"],
      ["tickets/SyncTickets", "feature"],
    ],
  );
  const [delivery, workflow] = tracer.spans;
  assert.equal(delivery?.attributes["sincpro.event"], "odoo.session.v1.logged_in");
  assert.equal(delivery?.attributes["sincpro.causation_id"], envelope.id);
  assert.equal(workflow?.parentSpanId, delivery?.spanId);
  assert.equal(
    workflow?.attributes["sincpro.causation_id"],
    delivery?.attributes["sincpro.execution_id"],
  );
  for (const span of tracer.spans) {
    assert.equal(span.attributes["sincpro.correlation_id"], envelope.correlationId);
    assert.equal(span.traceId, delivery?.traceId);
    assert.equal(span.outcome, "ok");
  }
  const line = logs.records.find((one) => one.message === "Preparing the day");
  assert.equal(line?.layer, "entrypoint");
  assert.equal(line?.useCase, "tickets-subscriptions.LoggedSuccessfully");
});

test("a bounded context and subscriptions hear one event; a redelivery runs only who failed", async () => {
  const heard: string[] = [];
  class CloseRoute extends Feature<RouteClosed, void> {
    static readonly serviceName = "CloseRoute";
    execute(event: RouteClosed): void {
      heard.push(`distribution ${event.route_id}`);
    }
  }
  class RouteClosedSubscriber extends EventSubscriber<RouteClosed> {
    static readonly subscriberName = "RouteClosed";
    declare readonly ticketsBoundedContext: BoundedContext<TicketsDependencies>;
    async handle(event: RouteClosed): Promise<void> {
      await this.ticketsBoundedContext.execute(new CommandPrepareSession(1));
      heard.push(`tickets ${event.route_id}`);
    }
  }
  const distributionBoundedContext = new BoundedContext("distribution");
  distributionBoundedContext.feature(RouteClosed)(CloseRoute);
  const { ticketsSubscriptions } = tickets([new TransportError("/session", 503, null)]);
  ticketsSubscriptions.subscribe(RouteClosed)(RouteClosedSubscriber);
  const store = memoryEventStore();
  const queue = storedQueue({
    store,
    subscriber: new Subscriber(distributionBoundedContext, ticketsSubscriptions),
    wait: 5,
  });
  const event = new RouteClosed("r-1");
  await queue.put(event, envelopeOf(event));
  await queue.drain();
  assert.equal(store.events[0]?.state, "pending");
  assert.deepEqual(store.events[0]?.reached, ["distribution"]);
  assert.deepEqual(
    store.events[0]?.failures.map((one) => [one.boundedContext, one.kind]),
    [["tickets-subscriptions", "unavailable"]],
  );
  await new Promise((resolve) => setTimeout(resolve, 1100));
  await queue.drain();
  assert.equal(store.events[0]?.state, "delivered");
  assert.deepEqual(heard, ["distribution r-1", "tickets r-1"]);
});

test("a failure is reported once along the flow, and keeps the outcome the bounded context gave it", async () => {
  const reporter = memoryReporter();
  const tracer = memoryTracer();
  configureProcess({ reporter, tracer, logger: { engine: false } });
  const fault = new Error("database gone");
  const { ticketsSubscriptions } = tickets([fault]);
  await assert.rejects(ticketsSubscriptions.execute(new OdooLoggedIn(1)), /database gone/);
  assert.equal(reporter.reports.length, 1);
  assert.equal(reporter.reports[0]?.about.useCase, "tickets.PrepareSession");
  assert.equal(tracer.spans[0]?.outcome, "failed");

  const refused = tickets([new Locked("the day is closed")]);
  refused.ticketsBoundedContext.expectErrors(Locked);
  const spans = tracer.spans.length;
  await assert.rejects(refused.ticketsSubscriptions.execute(new OdooLoggedIn(2)), /closed/);
  assert.equal(reporter.reports.length, 1);
  assert.equal(tracer.spans[spans]?.name, "tickets-subscriptions/LoggedSuccessfully");
  assert.equal(tracer.spans[spans]?.outcome, "refused");
});

test("a subscriber is not a use case: interceptors and listeners see only the use cases it calls", async () => {
  const started: string[] = [];
  const intercepted: string[] = [];
  configureProcess({ logger: { engine: false } });
  const { ticketsBoundedContext, ticketsSubscriptions } = tickets();
  ticketsBoundedContext.interceptor()(async (executable, next, run) => {
    intercepted.push(run.useCase);
    return next(executable);
  });
  ticketsBoundedContext.onStart((heard) => started.push(heard.execution.useCase));
  await ticketsSubscriptions.execute(new OdooLoggedIn(3));
  assert.deepEqual(started, [
    "tickets.StartDay",
    "tickets.PrepareSession",
    "tickets.SyncTickets",
  ]);
  assert.deepEqual(intercepted, started);
});

test("one subscriber per event: a second is refused, a replacement names what it replaces", async () => {
  const tracer = memoryTracer();
  configureProcess({ tracer, logger: { engine: false } });
  class Other extends EventSubscriber<OdooLoggedIn> {
    static readonly subscriberName = "Other";
    handle(): string {
      return "other";
    }
  }
  const { ticketsSubscriptions } = tickets();
  assert.throws(
    () => ticketsSubscriptions.subscribe(OdooLoggedIn)(Other),
    /one subscriber per event/,
  );
  assert.throws(
    () => ticketsSubscriptions.subscribe(OdooLoggedIn, { replaces: Other })(Other),
    /does not match/,
  );
  ticketsSubscriptions.subscribe(OdooLoggedIn, { replaces: LoggedSuccessfully })(Other);
  assert.equal(ticketsSubscriptions.handlerOf(OdooLoggedIn), Other);
  assert.equal(ticketsSubscriptions.eventTypeOf("odoo.session.v1.logged_in"), OdooLoggedIn);
  assert.equal(await ticketsSubscriptions.execute(new OdooLoggedIn(4)), "other");
  assert.equal(tracer.spans[0]?.attributes["sincpro.replaces"], "LoggedSuccessfully");
});

test("a subscriber needs its name, its base class, an event with a name and its dependencies", async () => {
  class Nameless extends EventSubscriber<RouteClosed> {
    static readonly subscriberName = "";
    handle(): void {}
  }
  class NotOne {
    static readonly subscriberName = "NotOne";
    handle(): void {}
  }
  class Unnamed extends DomainEvent {}
  class Lonely extends EventSubscriber<RouteClosed> {
    static readonly subscriberName = "Lonely";
    declare readonly missing: unknown;
    handle(): unknown {
      return this.missing;
    }
  }
  const subscriptions = new Subscriptions("lonely-subscriptions");
  assert.throws(() => subscriptions.subscribe(RouteClosed)(Nameless), /subscriberName/);
  // @ts-expect-error A subscriber extends EventSubscriber.
  assert.throws(() => subscriptions.subscribe(RouteClosed)(NotOne), /not an EventSubscriber/);
  // @ts-expect-error An event class declares its eventName.
  assert.throws(() => subscriptions.subscribe(Unnamed)(Lonely), /eventName/);
  assert.throws(
    () => subscriptions.addDependency("execution" as never, 1 as never),
    /Reserved/,
  );
  assert.throws(() => new Subscriptions("a/b"), /without '\/'/);
  subscriptions.subscribe(RouteClosed)(Lonely);
  await assert.rejects(
    subscriptions.execute(new RouteClosed("r")),
    /not registered: missing/,
  );
  await assert.rejects(subscriptions.execute(new OdooLoggedIn(1)), /no subscriber hears/);
});

test("the queue's door refuses two who hear events under one name", () => {
  const { ticketsBoundedContext } = tickets();
  const sameName = new Subscriptions("tickets");
  assert.throws(() => new Subscriber(ticketsBoundedContext, sameName), /named tickets/);
});

for (const style of ["function", "decorator", "legacy-decorator"] as const) {
  test(`a subscriber registers the same way as a ${style}`, async () => {
    class Closing extends EventSubscriber<RouteClosed> {
      static readonly subscriberName = "Closing";
      handle(event: RouteClosed): string {
        return `closing ${event.route_id}`;
      }
    }
    const subscriptions = new Subscriptions("routes-subscriptions");
    const Registered = registerClass(style, Closing, subscriptions.subscribe(RouteClosed));
    assert.equal(subscriptions.handlerOf(RouteClosed), Registered);
    assert.equal(await subscriptions.execute(new RouteClosed("r-9")), "closing r-9");
  });
}
