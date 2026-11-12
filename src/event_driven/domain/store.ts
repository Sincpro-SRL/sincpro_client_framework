import type { JsonValue } from "@sincpro/client-framework/common/serialization";
import type { Envelope } from "@sincpro/client-framework/event_driven/domain/envelope";
import type { FailureKind } from "@sincpro/criteria";

/**
 * Where a stored queue keeps what it was handed — events and Commands — until it is done with
 * them: the port each platform implements with its own technology:
 *
 * - `memoryMessageStore()` — this package's: the process's memory (a browser tab, a test).
 * - a phone: a SQLite table, so a message outlives a restart; the set-aside ones are its
 *   dead-letter queue.
 * - a browser: IndexedDB, to work offline.
 *
 * Context: storing is the platform's, deciding what to do with what is stored is not — when to
 * try again, what to set aside, which contexts already have it (`storedQueue`). So the port only
 * keeps records, in the order they came, and finds the next one waiting.
 */
export interface MessageStore {
  /** Keeps a message, waiting. */
  add(stored: StoredMessage): void | Promise<void>;
  /**
   * The oldest message still waiting (`pending`), in the order added — but those `skip` ids:
   * not ready, or waiting their time, they wait while the rest go on.
   */
  next(
    skip: ReadonlySet<string>,
  ): StoredMessage | undefined | Promise<StoredMessage | undefined>;
  /** What changed of a stored message — found by its envelope's id. */
  save(stored: StoredMessage): void | Promise<void>;
}

/**
 * - `pending`: waiting to be delivered — its first time, or again after `retryAt`.
 * - `delivered`: every bounded context that hears the event executed it; the Command answered.
 * - `set_aside`: it failed and is not tried again on its own — the dead-letter queue, for a
 *   person to retry, or to drop.
 */
export type StoredState = "pending" | "delivered" | "set_aside";

/** What a message is: a fact for whoever hears it, or an intention for the bus that consumes it. */
export type MessageKind = "event" | "command";

/** Why a bounded context did not execute it. */
export type DeliveryFailure = {
  readonly boundedContext: string;
  readonly kind: FailureKind;
  readonly reason: string;
  readonly message: string;
};

/** A message as a store keeps it: its envelope, its values and how its delivery goes. */
export type StoredMessage = {
  readonly kind: MessageKind;
  readonly envelope: Envelope;
  /** Its values (`valuesOf`): rebuilt as its class on delivery. */
  readonly payload: JsonValue;
  readonly state: StoredState;
  /** Every time it was handed to its consumers. */
  readonly attempts: number;
  /** When it may be tried again, ISO; `null` when it need not wait a time. */
  readonly retryAt: string | null;
  /** The bounded contexts done with it — executed, or set aside —: a retry never runs them again. */
  readonly reached: readonly string[];
  /** Why the last attempt did not reach every context. */
  readonly failures: readonly DeliveryFailure[];
  /** What a Command answered (`valuesOf`), once delivered; `null` for an event. */
  readonly answer: JsonValue | null;
};
