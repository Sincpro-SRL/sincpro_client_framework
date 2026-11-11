import type { DomainEvent, EventClass } from "@sincpro/client-framework/core/domain/dto";
import type { Cause } from "@sincpro/client-framework/core/domain/pipeline";
import type { Envelope } from "@sincpro/client-framework/event_driven/domain/envelope";
import type {
  Handled,
  Subscribes,
} from "@sincpro/client-framework/event_driven/domain/queue";

/** What the subscriber needs of a bounded context: whether it hears an event, and running it. */
export type HearingContext = {
  readonly name: string;
  handlerOf(dto: abstract new (...args: never[]) => DomainEvent): unknown;
  eventTypeOf(name: string): EventClass<DomainEvent> | undefined;
  execute(event: DomainEvent, cause?: Cause): Promise<unknown>;
};

/**
 * Hands an event to every bounded context that hears it — the backend's `Subscriber(buses)`:
 *
 *     const subscriber = new Subscriber(shop, mail, stock);
 *     const queue = syncQueue(subscriber);              // or a platform's durable queue
 *
 * Context: one subscriber per bounded context (its Feature or ApplicationService registered for
 * the event class); several contexts hearing one event is several executions, one each, in the
 * order named. A context that fails does not stop the others: each answer, or failure, is said.
 */
export class Subscriber implements Subscribes {
  private readonly contexts: readonly HearingContext[];

  constructor(...contexts: HearingContext[]) {
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
