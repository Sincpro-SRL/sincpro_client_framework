/**
 * Event-driven: the ports and the in-memory pieces that let every platform publish domain events
 * and subscribe to them the same way — as sincpro_framework's `event_driven`. Delivering them
 * durably (SQLite on a phone, IndexedDB in a browser, a broker) is each platform's, behind
 * `EventQueue`.
 *
 *   domain/      the envelope and the ports: EventQueue, Subscribes
 *   adapters/    syncQueue: in the call, in memory
 *   entrypoint/  Publisher (what a Feature holds), Subscriber (every bounded context that hears)
 */
export { syncQueue } from "@sincpro/client-framework/event_driven/adapters/sync-queue";
export {
  type Envelope,
  envelopeOf,
} from "@sincpro/client-framework/event_driven/domain/envelope";
export type {
  EventQueue,
  Handled,
  Subscribes,
} from "@sincpro/client-framework/event_driven/domain/queue";
export { Publisher } from "@sincpro/client-framework/event_driven/entrypoint/publisher";
export {
  type HearingContext,
  Subscriber,
} from "@sincpro/client-framework/event_driven/entrypoint/subscriber";
