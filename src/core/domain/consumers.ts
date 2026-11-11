import type {
  DomainEvent,
  EventClass,
  EventDescriptor,
  RemoteEvent,
} from "@sincpro/client-framework/core/domain/dto";
import type { Cause } from "@sincpro/client-framework/core/domain/pipeline";

/** What an event handler is registered for: an event's class, or a generated event's entry. */
export type EventKey = EventClass<DomainEvent> | EventDescriptor;

/**
 * One consumer of an event — what a `Subscriber` delivers it to and acknowledges apart: the use
 * case a bounded context registered for it, or an event handler.
 *
 *     sales                  the use case of the bounded context "sales"
 *     sales/OnSalePaid       an event handler of that bounded context
 *     app/NotifySalePaid     an event handler of the subscriber "app"
 *
 * Context: the key is what a stored queue keeps of who already has a message (`reached`), so a
 * redelivery never runs one again; it is stable across restarts because it is made of names.
 */
export type EventConsumer = {
  readonly key: string;
  consume(event: DomainEvent | RemoteEvent, cause?: Cause): Promise<unknown>;
};
