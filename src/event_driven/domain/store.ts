import type { JsonValue } from "@sincpro/client-framework/common/serialization";
import type { Envelope } from "@sincpro/client-framework/event_driven/domain/envelope";
import type { FailureKind } from "@sincpro/criteria";

/**
 * Where a stored queue keeps what it was handed until every bounded context that hears it has
 * executed it — the port each platform implements with its own technology:
 *
 * - `memoryEventStore()` — this package's: the process's memory (a browser tab, a test).
 * - a phone: a SQLite table, so an event outlives a restart; the set-aside ones are its
 *   dead-letter queue.
 * - a browser: IndexedDB, to work offline.
 *
 * Context: storing is the platform's, deciding what to do with what is stored is not — when to
 * try again, what to set aside, which contexts already have it (`storedQueue`). So the port only
 * keeps records, in the order they came, and finds the next one waiting.
 */
export interface EventStore {
  /** Keeps a published event, waiting. */
  add(stored: StoredEvent): void | Promise<void>;
  /**
   * The oldest event still waiting (`pending`), in the order added — but those `skip` names by
   * envelope id: not ready yet (no connection, no session), they wait while the rest go on.
   */
  next(skip: ReadonlySet<string>): StoredEvent | undefined | Promise<StoredEvent | undefined>;
  /** What changed of a stored event — found by its envelope's id. */
  save(stored: StoredEvent): void | Promise<void>;
}

/**
 * - `pending`: waiting to be delivered — again, after `retryAt`, when it failed in a way a retry
 *   may fix.
 * - `delivered`: every bounded context that hears it executed it.
 * - `set_aside`: a context failed in a way every attempt would repeat (`PERMANENT_KINDS`) — the
 *   dead-letter queue; it never holds back what comes after.
 */
export type StoredState = "pending" | "delivered" | "set_aside";

/** Why a bounded context did not execute it. */
export type DeliveryFailure = {
  readonly boundedContext: string;
  readonly kind: FailureKind;
  readonly reason: string;
  readonly message: string;
};

/** A published event as a store keeps it: its envelope, its values and how its delivery goes. */
export type StoredEvent = {
  readonly envelope: Envelope;
  /** The event's values (`valuesOf`): rebuilt as its class on delivery. */
  readonly payload: JsonValue;
  readonly state: StoredState;
  readonly attempts: number;
  /** When it may be tried again, ISO; `null` when it need not wait. */
  readonly retryAt: string | null;
  /** The bounded contexts done with it — executed, or set aside —: a retry never runs them again. */
  readonly reached: readonly string[];
  /** Why the last attempt did not reach every context. */
  readonly failures: readonly DeliveryFailure[];
};
