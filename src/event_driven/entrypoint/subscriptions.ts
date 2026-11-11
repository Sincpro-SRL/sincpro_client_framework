import type { Execution } from "@sincpro/client-framework/context/domain/execution";
import type { ContextValues } from "@sincpro/client-framework/context/domain/store";
import { processContext } from "@sincpro/client-framework/context/infrastructure/process";
import { optionsOf } from "@sincpro/client-framework/core/domain/bus";
import { DomainEvent, type EventClass } from "@sincpro/client-framework/core/domain/dto";
import type { Cause, ExecuteOptions } from "@sincpro/client-framework/core/domain/pipeline";
import { RESERVED_MEMBERS } from "@sincpro/client-framework/core/domain/services";
import { executeService } from "@sincpro/client-framework/core/services/execution";
import type { LayerLogger } from "@sincpro/client-framework/observability/domain/logging";
import type {
  Attributes,
  Span,
} from "@sincpro/client-framework/observability/domain/tracing";

/**
 * An entrypoint that hears one domain event and calls the use cases it starts — as a cron calls
 * them on a tick, or a screen on a gesture:
 *
 *     class LoggedSuccessfully extends EventSubscriber<OdooLoggedIn> {
 *       static readonly subscriberName = "LoggedSuccessfully";
 *       declare readonly ticketsBoundedContext: BoundedContext<TicketsDependencies>;
 *
 *       async handle(event: OdooLoggedIn) {
 *         await this.ticketsBoundedContext.execute(new CommandPrepareSession(event.uid));
 *       }
 *     }
 *
 * Context: a subscriber is not a use case. It reads the event, builds the Command — or the
 * Commands — and executes them on a bounded context it was given; what to decide, and work of
 * several steps, is a Feature or an ApplicationService it executes. While `handle` runs,
 * `this.span`, `this.logger`, `this.signal`, `this.execution` and every dependency are that
 * delivery's: a bounded context it was given executes as a child of it — the same flow, caused by
 * it (`BIND`). `subscriberName` is stable metadata, never `constructor.name`. Like a service, a
 * subscriber is one instance for every delivery: what belongs to one goes in its locals.
 */
export abstract class EventSubscriber<
  E extends DomainEvent,
  Context extends object = ContextValues,
> {
  /** What this delivery runs with: the process's context. */
  declare readonly context: Readonly<Partial<Context>>;
  /** This delivery's span: the Commands it executes are its children. */
  declare readonly span: Span;
  /** This delivery's logger: every line carries its flow and trace. */
  declare readonly logger: LayerLogger;
  /** What cancels this delivery, when it was executed with one. */
  declare readonly signal: AbortSignal | undefined;
  /**
   * This delivery: its id, flow (`correlationId`) and cause — the envelope's id, the key that
   * makes hearing an event twice harmless.
   */
  declare readonly execution: Execution;
  abstract handle(event: E): unknown;
}

type SubscriberClass<E extends DomainEvent> = {
  new (): EventSubscriber<E>;
  readonly subscriberName: string;
};

/** What a subscription takes the place of: the subscriber registered now for the event. */
export type SubscriptionOptions = { replaces?: abstract new (...args: never[]) => object };

/** What `subscribe(...)` answers: the function that registers the subscriber. */
export type Subscribing<E extends DomainEvent> = <S extends SubscriberClass<NoInfer<E>>>(
  Subscriber: S,
  decorator?: ClassDecoratorContext<S>,
) => S;

type Registration = {
  readonly name: string;
  readonly Subscriber: SubscriberClass<DomainEvent>;
  /** The subscriber it took the place of: said on its spans. */
  readonly replaces?: string;
  instance?: EventSubscriber<DomainEvent>;
};

function isEventClass(value: unknown): value is EventClass<DomainEvent> {
  return typeof value === "function" && value.prototype instanceof DomainEvent;
}

function nameOf(Subscriber: unknown): string {
  const named = Subscriber as { subscriberName?: unknown; name?: unknown } | undefined;
  return String(named?.subscriberName ?? named?.name ?? Subscriber);
}

/**
 * The subscribers of one part of an application — which `EventSubscriber` hears which event —,
 * with the dependencies they call: what a queue's `Subscriber` hands an event to, beside the
 * bounded contexts:
 *
 *     export const ticketsSubscriptions = new Subscriptions<TicketsEntrypoints>("tickets-subscriptions");
 *     ticketsSubscriptions.addDependency("ticketsBoundedContext", ticketsBoundedContext);
 *     ticketsSubscriptions.subscribe(OdooLoggedIn)(LoggedSuccessfully);
 *
 *     storedQueue({ store, subscriber: new Subscriber(odooBoundedContext, ticketsSubscriptions) });
 *
 * Context: the shape of a bounded context, and of the backend's `Crons`: a name that is its
 * identity in spans, logs and the queue's record of who already heard an event — so it differs
 * from every bounded context's —, dependencies by name, and a function (or a decorator) that
 * registers. One subscriber per event here: several reactions to one event are one
 * ApplicationService it executes, or subscribers of other registries. Each delivery is a run of
 * its own (`<name>/<subscriberName>`, layer `entrypoint`), continuing the envelope's flow; it is
 * not a use case, so interceptors and listeners do not see it — they see the use cases it calls.
 */
export class Subscriptions<D extends object = Record<never, never>> {
  private readonly registrations = new Map<EventClass<DomainEvent>, Registration>();
  private readonly dependencyValues = new Map<string, unknown>();

  constructor(readonly name: string) {
    if (name.trim() === "" || name.includes("/")) {
      throw new TypeError("Subscriptions need a nonempty name without '/'");
    }
  }

  /** A dependency its subscribers find on `this`, bound to each delivery; `replaces` as a bounded context's. */
  addDependency<K extends keyof D & string>(
    name: K,
    dependency: D[K],
    options?: { replaces: D[K] },
  ): this {
    if (RESERVED_MEMBERS.has(name)) throw new Error(`Reserved dependency name: ${name}`);
    const registered = this.dependencyValues.has(name);
    if (registered && options === undefined) {
      throw new Error(`Dependency already registered: ${name}`);
    }
    if (options && (!registered || this.dependencyValues.get(name) !== options.replaces)) {
      throw new Error(`Dependency replacement does not match the registration: ${name}`);
    }
    this.dependencyValues.set(name, dependency);
    return this;
  }

  /**
   * Registers the subscriber that hears `event` here. With `replaces`, it takes the place of the
   * one registered now.
   */
  subscribe<E extends DomainEvent>(
    event: EventClass<E>,
    options: SubscriptionOptions = {},
  ): Subscribing<E> {
    return (Subscriber, decorator) => {
      const register = () =>
        this.register(
          event as EventClass<DomainEvent>,
          Subscriber as unknown as SubscriberClass<DomainEvent>,
          options.replaces,
        );
      // Standard decorators run before static fields have initialized.
      if (decorator) decorator.addInitializer(register);
      else register();
      return Subscriber;
    };
  }

  /** The subscriber registered now for an event class — what a `replaces` names. */
  handlerOf(
    event: abstract new (...args: never[]) => DomainEvent,
  ): (abstract new (...args: never[]) => object) | undefined {
    return this.registrations.get(event as EventClass<DomainEvent>)?.Subscriber;
  }

  /** The event class registered here under a wire name, or `undefined` when nobody here hears it. */
  eventTypeOf(name: string): EventClass<DomainEvent> | undefined {
    for (const event of this.registrations.keys()) {
      if (event.eventName === name) return event;
    }
    return undefined;
  }

  /**
   * `event` heard by its subscriber here — continuing the envelope's flow when it is given
   * (`execute(event, envelope)`) — and what `handle` returned.
   *
   * 1. The subscriber registered for the event's exact class; none: an error.
   * 2. A run `<name>/<subscriberName>`, layer `entrypoint`: its span, log lines and — when it
   *    fails with a fault nothing reported yet — its report; its dependencies bound to it.
   * Final: what `handle` returned; its failure, as it is, to the queue that delivered it.
   */
  execute(event: DomainEvent, options?: ExecuteOptions | Cause): Promise<unknown> {
    const type = Object.getPrototypeOf(event)?.constructor as EventClass<DomainEvent>;
    const registration = this.registrations.get(type);
    if (registration === undefined) {
      return Promise.reject(new Error(`${this.name}: no subscriber hears ${event.name}`));
    }
    registration.instance ??= new registration.Subscriber();
    const given = optionsOf(options);
    const attributes: Attributes = {
      "sincpro.event": event.name,
      ...(registration.replaces ? { "sincpro.replaces": registration.replaces } : {}),
    };
    return executeService(registration.instance, event, {
      boundedContext: this.name,
      name: registration.name,
      layer: "entrypoint",
      method: "handle",
      attributes,
      dependencies: new Map(this.dependencyValues),
      context: () => ({ ...processContext.values }),
      ...(given.cause ? { cause: given.cause } : {}),
      ...(given.signal ? { signal: given.signal } : {}),
      interceptors: [],
      expected: () => false,
      handlers: [],
    });
  }

  /**
   * 1. The subscriber is an `EventSubscriber`, for a domain event class with its `eventName`.
   * 2. The event has no subscriber here yet — or, with `replaces`, the one it has is that one.
   * 3. Its `subscriberName` is given and no other subscriber here has it; no other event class
   *    here has the event's name.
   * Final: registered, said on its spans when it replaced another; the next delivery hears it.
   */
  private register(
    event: EventClass<DomainEvent>,
    Subscriber: SubscriberClass<DomainEvent>,
    replaces: SubscriptionOptions["replaces"],
  ): void {
    if (!(Subscriber.prototype instanceof EventSubscriber)) {
      throw new TypeError("The subscriber is not an EventSubscriber");
    }
    if (!isEventClass(event)) {
      throw new TypeError("A subscriber is registered for a DomainEvent class");
    }
    if (typeof event.eventName !== "string" || event.eventName.trim() === "") {
      throw new Error("A domain event needs a nonempty eventName");
    }
    const current = this.registrations.get(event);
    if (replaces !== undefined && current?.Subscriber !== replaces) {
      throw new Error(`Replacement does not match the subscription: ${nameOf(replaces)}`);
    }
    if (replaces === undefined && current) {
      throw new Error(
        `Event already subscribed in ${this.name}: one subscriber per event — several reactions are one ApplicationService`,
      );
    }
    const name = Subscriber.subscriberName;
    if (typeof name !== "string" || name.trim() === "" || name.includes("/")) {
      throw new Error("A subscriber needs a nonempty subscriberName without '/'");
    }
    for (const [other, registration] of this.registrations) {
      if (registration !== current && registration.name === name) {
        throw new Error(`Subscriber name already registered: ${name}`);
      }
      if (other !== event && other.eventName === event.eventName) {
        throw new Error(`Event name already registered: ${event.eventName}`);
      }
    }
    this.registrations.set(event, {
      name,
      Subscriber,
      ...(current ? { replaces: current.name } : {}),
    });
  }
}
