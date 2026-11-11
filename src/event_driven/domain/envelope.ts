import { newEntityId } from "@sincpro/client-framework/common/ids";
import type { DomainEvent } from "@sincpro/client-framework/core/domain/dto";
import type { Cause } from "@sincpro/client-framework/core/domain/pipeline";

/**
 * What travels beside a published event: who it is, which flow it belongs to and what caused it
 * — the backend's `Envelope` and the chain of its `DomainEvent` (`correlation_id`,
 * `causation_id`), kept beside the event rather than in it, so an event class carries only what
 * happened.
 *
 *     { name: "shop.order.v1.paid", id: "0193…", correlationId: "0193…", causationId: "0192…",
 *       publishedAt: "2026-11-10T23:31:53.000Z" }
 *
 * Context: a queue stores it with the event and hands it back on delivery
 * (`context.execute(event, envelope)`): the run that executes the event continues the flow —
 * the same `correlationId`, caused by this event's `id` —, three services and two devices later.
 */
export type Envelope = Cause & {
  /** The event's wire name (`eventName`). */
  readonly name: string;
  /** What directly caused it: the run that published it; `null` for the head of a flow. */
  readonly causationId: string | null;
  /** When it was published, ISO. */
  readonly publishedAt: string;
};

/**
 * The envelope of `event`, published by the run `cause` names — or the head of its own flow when
 * nothing caused it (its `correlationId` is its own `id`).
 */
export function envelopeOf(event: DomainEvent, cause?: Cause): Envelope {
  const name = event.name;
  if (name.trim() === "") {
    throw new Error(
      `${event.constructor.name} has no eventName: an event is published by its wire name`,
    );
  }
  const id = newEntityId();
  return {
    name,
    id,
    correlationId: cause?.correlationId ?? id,
    causationId: cause?.id ?? null,
    publishedAt: new Date().toISOString(),
  };
}
