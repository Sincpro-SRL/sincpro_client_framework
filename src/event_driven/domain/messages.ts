import type { JsonValue } from "@sincpro/client-framework/common/serialization";
import type { Envelope } from "@sincpro/client-framework/event_driven/domain/envelope";

/**
 * An event as it travels: its envelope — wire name, id, flow, cause — and its values. A fact:
 * every bounded context that registered it hears it.
 *
 *     { kind: "event", envelope: { name: "billing.invoice.v1.issued", id, correlationId, … },
 *       data: { invoice_id: "i-1", total: { amount: "10.00", currency: "BOB" } } }
 */
export type EventMessage = {
  readonly kind: "event";
  readonly envelope: Envelope;
  readonly data: JsonValue;
};

/**
 * A Command as it travels — the backend's `Payload`: its identity (`type`, `<context>.<Command>`),
 * which the one bus that executes it finds its class by, its values and its flow.
 *
 *     { kind: "command", type: "billing.CommandIssueInvoice", id, correlationId, causationId,
 *       sentAt, data: { order_id: "o-1" } }
 *
 * Context: a Command is a request to one bus, not a fact many hear: it has no envelope and no
 * wire name, and a queue executes it only where it was declared consumable.
 */
export type CommandMessage = {
  readonly kind: "command";
  readonly type: string;
  readonly id: string;
  readonly correlationId: string;
  readonly causationId: string | null;
  /** When it was sent, ISO. */
  readonly sentAt: string;
  readonly data: JsonValue;
};

/** What a queue carries: an event, or a Command. */
export type Message = EventMessage | CommandMessage;
