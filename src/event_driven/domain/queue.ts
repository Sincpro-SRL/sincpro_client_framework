import type {
  AnyCommand,
  CommandClass,
  CommandDescriptor,
  DomainEvent,
  EventClass,
  EventDescriptor,
  RemoteCommand,
  RemoteEvent,
} from "@sincpro/client-framework/core/domain/dto";
import type { Envelope } from "@sincpro/client-framework/event_driven/domain/envelope";

/**
 * What carries a message to whoever consumes it — the port each platform implements with its own
 * technology, as the backend's `Queue`:
 *
 * - `syncQueue(subscriber)` — this package's: in the call, in memory (the web's default, tests).
 * - `storedQueue(...)` — stored first, then delivered with the rules of a `Verdict`: a phone's
 *   SQLite, a browser's IndexedDB.
 * - a server's broker, through the backend.
 *
 * Context: delivery is the platform's — when, how often, how durably —; what it delivers and to
 * whom is the same everywhere: an event for every bounded context that hears it, a Command for
 * the one bus that consumes it, each with its envelope.
 */
export interface MessageQueue {
  /** An event, for every bounded context that hears it. */
  put(event: DomainEvent | RemoteEvent, envelope: Envelope): void | Promise<void>;
  /** A Command, for the one bus that consumes it: an intention, answered when it runs. */
  send(command: AnyCommand | RemoteCommand, envelope: Envelope): void | Promise<void>;
}

/** What an event of a wire name is rebuilt as: its class, or the generated entry it was registered with. */
export type EventType = EventClass<DomainEvent> | EventDescriptor;

/** What a Command of an identity is rebuilt as: its class, or the generated entry it was registered with. */
export type CommandType = CommandClass<AnyCommand> | CommandDescriptor;

/** What one bounded context answered, or failed with, for a delivered message. */
export type Handled =
  | { readonly boundedContext: string; readonly answer: unknown }
  | { readonly boundedContext: string; readonly error: unknown };

/**
 * What a queue hands an event to — the backend's `Subscribes`: which class a stored name is
 * rebuilt as, and the event executed by every subscriber.
 */
export interface Subscribes {
  /** What an event of that wire name is rebuilt as, or `undefined` when nobody hears it. */
  eventTypeOf(name: string): EventType | undefined;
  /**
   * The event executed in every bounded context that hears it — but those `skip` names, which
   * already have it — and what each answered.
   */
  handle(
    event: DomainEvent | RemoteEvent,
    envelope?: Envelope,
    skip?: readonly string[],
  ): Promise<Handled[]>;
  /** What a consumed Command of that identity is rebuilt as, or `undefined` when none is. */
  commandTypeOf(identity: string): CommandType | undefined;
  /**
   * The Command executed by the one bus that consumes it — nothing when that bus is in `skip` —,
   * and what it answered or failed with.
   */
  execute(
    command: AnyCommand | RemoteCommand,
    envelope?: Envelope,
    skip?: readonly string[],
  ): Promise<Handled[]>;
}
