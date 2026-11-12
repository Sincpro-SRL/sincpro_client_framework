/**
 * Event-driven: the ports and the in-memory pieces that let every platform publish events, send
 * Commands, and hand what a queue carries to the bus the same way — as sincpro_framework's
 * `event_driven`. Delivering them durably (SQLite on a phone, IndexedDB in a browser, a broker)
 * is each platform's, behind `MessageQueue`.
 *
 *   domain/      the envelope, the messages (an event, a Command), the ports (MessageQueue,
 *                Subscribes, MessageStore) and the delivery's rules (DeliveryPolicy, verdictOf)
 *   services/    writing and reading messages: a Command by its identity, an event by its name
 *   adapters/    syncQueue (in the call), storedQueue (store, then deliver by the verdict),
 *                memoryMessageStore
 *   entrypoint/  Publisher (what a Feature holds), Subscriber (the queue's only entrypoint)
 */
export {
  type MemoryMessageStore,
  memoryMessageStore,
} from "@sincpro/client-framework/event_driven/adapters/memory-message-store";
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
  BinaryMessage,
  Message,
} from "@sincpro/client-framework/event_driven/domain/messages";
export type {
  CommandType,
  EventType,
  Handled,
  MessageQueue,
  Subscribes,
} from "@sincpro/client-framework/event_driven/domain/queue";
export type {
  DeliveryFailure,
  MessageKind,
  MessageStore,
  StoredMessage,
  StoredState,
} from "@sincpro/client-framework/event_driven/domain/store";
export {
  combined,
  DEFAULT_DELIVERY_POLICY,
  type Delivery,
  type DeliveryPolicy,
  type FullDeliveryPolicy,
  type Verdict,
  verdictOf,
  WAITING_KINDS,
} from "@sincpro/client-framework/event_driven/domain/verdict";
export { Publisher } from "@sincpro/client-framework/event_driven/entrypoint/publisher";
export {
  CommandNotConsumed,
  type HearingContext,
  type NamedSubscriberOptions,
  Subscriber,
  type SubscriberOptions,
} from "@sincpro/client-framework/event_driven/entrypoint/subscriber";
export {
  causeOf,
  commandEnvelopeOf,
  commandFrom,
  commandMessageOf,
  envelopeFrom,
  eventFrom,
  eventMessageOf,
  type MessageOptions,
  readMessage,
} from "@sincpro/client-framework/event_driven/services/messages";
