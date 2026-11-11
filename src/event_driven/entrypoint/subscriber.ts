import type { DomainEvent, EventClass } from "@sincpro/client-framework/core/domain/dto";
import type { Cause } from "@sincpro/client-framework/core/domain/pipeline";
import type { Envelope } from "@sincpro/client-framework/event_driven/domain/envelope";
import type {
  Handled,
  Subscribes,
} from "@sincpro/client-framework/event_driven/domain/queue";

/**
 * What the subscriber needs of whoever hears events — a bounded context (a use case of the event)
 * or `Subscriptions` (an `EventSubscriber` of it): its name, whether it hears an event, and
 * running it.
 */
export type HearingContext = {
  readonly name: string;
  handlerOf(dto: abstract new (...args: never[]) => DomainEvent): unknown;
  eventTypeOf(name: string): EventClass<DomainEvent> | undefined;
  execute(event: DomainEvent, cause?: Cause): Promise<unknown>;
};

/**
 * The door of a queue: hands an event to everyone who hears it — the backend's
 * `Subscriber(buses)`:
 *
 *     const subscriber = new Subscriber(shopBoundedContext, mailBoundedContext, ticketsSubscriptions);
 *     const queue = syncQueue(subscriber);              // or a platform's durable queue
 *
 * Context: who hears an event is a bounded context with a use case of it (a Feature or an
 * ApplicationService registered for its class) or `Subscriptions` with an `EventSubscriber` of
 * it — the entrypoint that calls use cases. Several hearing one event is several executions, one
 * each, in the order named; one that fails does not stop the others: each answer, or failure, is
 * said under its name — which a stored queue keeps, so a redelivery never runs again one that
 * already heard it. Two of them never share a name.
 */
export class Subscriber implements Subscribes {
  private readonly contexts: readonly HearingContext[];

  constructor(...contexts: HearingContext[]) {
    const names = new Set<string>();
    for (const context of contexts) {
      if (names.has(context.name)) {
        throw new Error(
          `Two of those who hear events are named ${context.name}: the queue keeps who heard an event by its name`,
        );
      }
      names.add(context.name);
    }
    this.contexts = contexts;
  }

  eventTypeOf(name: string): EventClass<DomainEvent> | undefined {
    for (const context of this.contexts) {
      const found = context.eventTypeOf(name);
      if (found) return found;
    }
    return undefined;
  }

  /**
   * 1. Every bounded context registered for the event's class, in the order named — but those
   *    `skip` names, which already have it.
   * 2. Each executes it — continuing the envelope's flow when there is one —, and its answer or
   *    failure is kept; a failure does not stop the next.
   * Final: what each answered, or failed with.
   */
  async handle(
    event: DomainEvent,
    envelope?: Envelope,
    skip: readonly string[] = [],
  ): Promise<Handled[]> {
    const type = Object.getPrototypeOf(event)?.constructor as
      (abstract new (...args: never[]) => DomainEvent) | undefined;
    const handled: Handled[] = [];
    for (const context of this.contexts) {
      if (type === undefined || context.handlerOf(type) === undefined) continue;
      if (skip.includes(context.name)) continue;
      try {
        handled.push({
          boundedContext: context.name,
          answer: await context.execute(event, envelope),
        });
      } catch (error) {
        handled.push({ boundedContext: context.name, error });
      }
    }
    return handled;
  }
}
