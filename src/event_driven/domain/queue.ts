import type { DomainEvent, EventClass } from "@sincpro/client-framework/core/domain/dto";
import type { Envelope } from "@sincpro/client-framework/event_driven/domain/envelope";

/**
 * What carries a published event to whoever hears it — the port each platform implements with
 * its own technology, as the backend's `Queue`:
 *
 * - `syncQueue(subscriber)` — this package's: in the call, in memory (the web's default, tests).
 * - a phone: SQLite, so an event outlives a restart, with retries, a dead-letter queue and the
 *   connectivity it waits for.
 * - a browser: IndexedDB to work offline, `BroadcastChannel` to tell the other tabs.
 * - a server's broker, through the backend.
 *
 * Context: delivery is the platform's — when, how often, how durably —; what it delivers and to
 * whom is the same everywhere: an event, its envelope, and a `Subscribes` that executes it in
 * every bounded context that hears it.
 */
export interface EventQueue {
  put(event: DomainEvent, envelope: Envelope): void | Promise<void>;
}

/** What one bounded context answered, or failed with, for a delivered event. */
export type Handled =
  | { readonly boundedContext: string; readonly answer: unknown }
  | { readonly boundedContext: string; readonly error: unknown };

/**
 * What a queue hands an event to — the backend's `Subscribes`: which class a stored name is
 * rebuilt as, and the event executed by every subscriber.
 */
export interface Subscribes {
  /** The class an event of that wire name is rebuilt as, or `undefined` when nobody hears it. */
  eventTypeOf(name: string): EventClass<DomainEvent> | undefined;
  /**
   * The event executed in every bounded context that hears it — but those `skip` names, which
   * already have it — and what each answered.
   */
  handle(
    event: DomainEvent,
    envelope?: Envelope,
    skip?: readonly string[],
  ): Promise<Handled[]>;
}
