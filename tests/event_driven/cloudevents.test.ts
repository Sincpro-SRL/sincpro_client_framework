import assert from "node:assert/strict";

import {
  BoundedContext,
  Command,
  commandMessageOf,
  commandOf,
  configureProcess,
  DomainEvent,
  envelopeOf,
  eventMessageOf,
  Feature,
  Publisher,
  readMessage,
  type RemoteCommand,
  Subscriber,
  syncQueue,
} from "@sincpro/client-framework";
import { memoryTracer } from "@sincpro/client-framework/testing";
import { beforeEach, test } from "vitest";

class InvoicePaid extends DomainEvent {
  static readonly eventName = "billing.invoice.v1.paid";
  constructor(readonly invoice_id: string) {
    super();
  }
}

/** No identity declared: the bounded context that registers it gives it one. */
class CommandIssueInvoice extends Command<string> {
  constructor(readonly order_id: string) {
    super();
  }
}

const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
const PARENT = "00f067aa0ba902b7";

function billing(heard: string[]) {
  class Book extends Feature<InvoicePaid, void> {
    execute(event: InvoicePaid): void {
      heard.push(
        `${event.invoice_id} ${event instanceof InvoicePaid} ${this.execution.correlationId}`,
      );
    }
  }
  class IssueInvoice extends Feature<CommandIssueInvoice, string> {
    execute(command: CommandIssueInvoice): string {
      heard.push(`issue ${command.order_id} ${this.execution.correlationId}`);
      return "i-1";
    }
  }
  const billingBoundedContext = new BoundedContext("billing");
  billingBoundedContext.feature(InvoicePaid)(Book);
  billingBoundedContext.feature(CommandIssueInvoice)(IssueInvoice);
  return billingBoundedContext;
}

beforeEach(() => configureProcess({ logger: { engine: false } }));

test("an event from the backend in a broker's binary mode — ce_ headers, its JSON body — is executed here", async () => {
  const heard: string[] = [];
  const subscriber = new Subscriber(billing(heard));
  // As the backend's `Envelope.as_headers()` and `event.as_json()` write it.
  const handled = await subscriber.receive({
    headers: {
      ce_specversion: "1.0",
      ce_id: "e-1",
      ce_source: "urn:svc:billing",
      ce_type: "billing.invoice.v1.paid",
      ce_time: "2026-11-11T03:00:00+00:00",
      ce_correlationid: "flow-1",
      ce_causationid: "run-0",
      traceparent: `00-${TRACE}-${PARENT}-01`,
    },
    body: JSON.stringify({ name: "billing.invoice.v1.paid", invoice_id: "i-9" }),
  });
  assert.deepEqual(
    handled.map((one) => one.boundedContext),
    ["billing"],
  );
  assert.deepEqual(heard, ["i-9 true flow-1"]);
});

test("binary and structured are one message: other bindings' prefixes and the sincpro-event header read too", () => {
  const binary = readMessage({
    headers: {
      "ce-id": "e-2",
      "sincpro-event": "billing.invoice.v1.paid",
      "cloudEvents:correlationid": new TextEncoder().encode("flow-2"),
    },
    body: { name: "billing.invoice.v1.paid", invoice_id: "i-2" },
  });
  assert.equal(binary.type, "billing.invoice.v1.paid");
  assert.equal(binary.correlationid, "flow-2");
  assert.equal(readMessage(binary), binary);
});

test("a message written here is CloudEvents 1.0, as the backend reads it", () => {
  const event = new InvoicePaid("i-3");
  const envelope = envelopeOf(event, { id: "run-1", correlationId: "flow-3" });
  const message = eventMessageOf(event, envelope, { source: "urn:app:tickets" });
  assert.deepEqual(
    { ...message, id: "x", time: "t" },
    {
      specversion: "1.0",
      id: "x",
      source: "urn:app:tickets",
      type: "billing.invoice.v1.paid",
      time: "t",
      correlationid: "flow-3",
      causationid: "run-1",
      datacontenttype: "application/json",
      data: { name: "billing.invoice.v1.paid", invoice_id: "i-3" },
    },
  );
});

test("a Command's identity is the one its bounded context gives it, the backend's registered name", async () => {
  const heard: string[] = [];
  const billingBoundedContext = billing(heard);
  assert.equal(
    (CommandIssueInvoice as unknown as { commandName: string }).commandName,
    "billing.CommandIssueInvoice",
  );
  assert.equal(
    billingBoundedContext.commandTypeOf("billing.CommandIssueInvoice"),
    CommandIssueInvoice,
  );
  const message = commandMessageOf(new CommandIssueInvoice("o-1"), {
    id: "run-2",
    correlationId: "flow-4",
  });
  assert.equal(message.type, "billing.CommandIssueInvoice");
  const subscriber = new Subscriber({
    boundedContexts: [billingBoundedContext],
    commands: [CommandIssueInvoice],
  });
  assert.deepEqual(await subscriber.receive(JSON.parse(JSON.stringify(message))), [
    { boundedContext: "billing", answer: "i-1" },
  ]);
  assert.deepEqual(heard, ["issue o-1 flow-4"]);
});

test("an event's name is dotted, as the backend's: one that is not is refused", () => {
  class Loose extends DomainEvent {
    static readonly eventName = "paid";
  }
  class Hear extends Feature<Loose, void> {
    execute(): void {}
  }
  assert.throws(
    () => new BoundedContext("billing").feature(Loose)(Hear),
    /not an event's name/,
  );
  assert.throws(() => envelopeOf(new Loose()), /not an event's name/);
});

test("a delivered message continues the backend's trace and flow; what a run publishes carries its own", async () => {
  const tracer = memoryTracer();
  configureProcess({ tracer, logger: { engine: false } });
  const heard: string[] = [];
  const subscriber = new Subscriber(billing(heard));
  await subscriber.receive({
    headers: {
      ce_id: "e-5",
      ce_type: "billing.invoice.v1.paid",
      ce_correlationid: "flow-5",
      traceparent: `00-${TRACE}-${PARENT}-01`,
    },
    body: { name: "billing.invoice.v1.paid", invoice_id: "i-5" },
  });
  const [delivered] = tracer.spans;
  assert.equal(delivered?.traceId, TRACE);
  assert.equal(delivered?.parentSpanId, PARENT);
  assert.equal(delivered?.attributes["sincpro.correlation_id"], "flow-5");
  assert.equal(delivered?.attributes["sincpro.causation_id"], "e-5");

  class CommandPay extends Command<void> {}
  const published: string[] = [];
  class Pay extends Feature<CommandPay, void> {
    declare readonly publisher: Publisher;
    async execute(): Promise<void> {
      const envelope = await this.publisher.publish(new InvoicePaid("i-6"));
      published.push(envelope.traceparent ?? "");
    }
  }
  const shopBoundedContext = new BoundedContext<{ publisher: Publisher }>("shop");
  shopBoundedContext.addDependency("publisher", new Publisher(syncQueue(new Subscriber())));
  shopBoundedContext.feature(CommandPay)(Pay);
  await shopBoundedContext.execute(new CommandPay());
  const pay = tracer.spans.find((span) => span.name === "shop/Pay");
  assert.equal(published[0], `00-${pay?.traceId}-${pay?.spanId}-01`);
});

test("a generated Command and a generated event travel and come back the same way as classes", async () => {
  /** What the generator writes: types and entries — no class. */
  type CommandArchiveIssue = { issue_id: string };
  type IssueClosed = { name: "project.issue.v1.closed"; issue_id: string };
  const operations = {
    CommandArchiveIssue: { identity: "project.CommandArchiveIssue", role: "command" },
  } as const;
  const events = { IssueClosed: { name: "project.issue.v1.closed" } } as const;
  const heard: string[] = [];
  class Archive extends Feature<IssueClosed | RemoteCommand<CommandArchiveIssue>, void> {
    execute(input: IssueClosed | RemoteCommand<CommandArchiveIssue>): void {
      heard.push(`${"name" in input ? input.name : "command"} ${input.issue_id}`);
    }
  }
  const projectBoundedContext = new BoundedContext("project");
  projectBoundedContext.feature([events.IssueClosed, operations.CommandArchiveIssue])(
    Archive,
  );
  const subscriber = new Subscriber({
    boundedContexts: [projectBoundedContext],
    commands: [operations.CommandArchiveIssue],
  });

  const command = commandMessageOf(
    commandOf(operations.CommandArchiveIssue, { issue_id: "i-7" }),
  );
  assert.equal(command.type, "project.CommandArchiveIssue");
  assert.deepEqual(command.data, { issue_id: "i-7" });
  const closed: IssueClosed = { name: "project.issue.v1.closed", issue_id: "i-8" };
  const event = eventMessageOf(closed, envelopeOf(closed));
  // Over the wire and back, as JSON.
  await subscriber.receive(JSON.parse(JSON.stringify(command)));
  await subscriber.receive(JSON.parse(JSON.stringify(event)));
  assert.deepEqual(heard, ["command i-7", "project.issue.v1.closed i-8"]);
});
