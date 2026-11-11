/**
 * Event-driven: the ports and the in-memory pieces that let every platform publish domain events
 * and subscribe to them the same way — as sincpro_framework's `event_driven`. Delivering them
 * durably (SQLite on a phone, IndexedDB in a browser, a broker) is each platform's, behind
 * `EventQueue`.
 *
 *   domain/      the envelope and the ports: EventQueue, Subscribes, EventStore
 *   adapters/    syncQueue (in the call), storedQueue (store, then deliver, retry, set aside),
 *                memoryEventStore
 *   entrypoint/  Publisher (what a Feature holds), Subscriber (every bounded context that hears)
 */
export {
  type MemoryEventStore,
  memoryEventStore,
} from "@sincpro/client-framework/event_driven/adapters/memory-event-store";
export {
  type StoredQueue,
  storedQueue,
  type StoredQueueOptions,
} from "@sincpro/client-framework/event_driven/adapters/stored-queue";
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
export type {
  DeliveryFailure,
  EventStore,
  StoredEvent,
  StoredState,
} from "@sincpro/client-framework/event_driven/domain/store";
export { Publisher } from "@sincpro/client-framework/event_driven/entrypoint/publisher";
export {
  type HearingContext,
  Subscriber,
} from "@sincpro/client-framework/event_driven/entrypoint/subscriber";
