import { processContext } from "@sincpro/client-framework/context/infrastructure/process";
import type {
  EventConsumer,
  EventKey,
} from "@sincpro/client-framework/core/domain/consumers";
import type {
  AnyCommand,
  CommandClass,
  CommandDescriptor,
  DomainEvent,
  DtoKey,
  EventClass,
  EventDescriptor,
  Executable,
  ExecutableOf,
  RemoteCommand,
  RemoteEvent,
} from "@sincpro/client-framework/core/domain/dto";
import type { Cause, ExecuteOptions } from "@sincpro/client-framework/core/domain/pipeline";
import {
  type HandledEvent,
  RESERVED_MEMBERS,
} from "@sincpro/client-framework/core/domain/services";
import { processHearing } from "@sincpro/client-framework/core/infrastructure/listeners";
import { identityOf, keyIdentity } from "@sincpro/client-framework/core/services/dto-keys";
import {
  eventKeysOf,
  type HandlerClass,
  type HandlerRegistrar,
  handlerRegistrar,
  type HandlerRegistration,
  handles,
  runHandler,
} from "@sincpro/client-framework/core/services/event-handlers";
import { announceTo } from "@sincpro/client-framework/core/services/listening";
import type { Envelope } from "@sincpro/client-framework/event_driven/domain/envelope";
import type {
  BinaryMessage,
  Message,
} from "@sincpro/client-framework/event_driven/domain/messages";
import type {
  CommandType,
  EventType,
  Handled,
  Subscribes,
} from "@sincpro/client-framework/event_driven/domain/queue";
import {
  commandFrom,
  envelopeFrom,
  eventFrom,
  readMessage,
} from "@sincpro/client-framework/event_driven/services/messages";

/**
 * What a subscriber needs of a bounded context — a bus it delivers to: what it registered, who
 * consumes an event there, and running it. A `BoundedContext` is one.
 */
export type HearingContext = {
  readonly name: string;
  handlerOf(dto: DtoKey): unknown;
  eventTypeOf(name: string): EventType | undefined;
  commandTypeOf(identity: string): CommandType | undefined;
  execute(executable: Executable, options?: ExecuteOptions | Cause): Promise<unknown>;
  /** Who consumes the event there: its use case and its event handlers. */
  consumersOf?(event: DomainEvent | RemoteEvent): readonly EventConsumer[];
};

/** Which bounded contexts it delivers to, and what it takes from the queue. */
export type SubscriberOptions = {
  readonly boundedContexts: readonly HearingContext[];
  /** The events it hears; every event its consumers registered when none is named. */
  readonly events?: readonly (EventClass<DomainEvent> | EventDescriptor)[];
  /**
   * The Commands it consumes from the queue — none unless named, as the backend's
   * `@queue.consumes`: a bus never hands all its Commands to whoever can publish on a queue.
   */
  readonly commands?: readonly (CommandClass<AnyCommand> | CommandDescriptor)[];
};

/** What a named subscriber takes besides its name. */
export type NamedSubscriberOptions = Omit<SubscriberOptions, "boundedContexts">;

/** A Command the queue carried that this subscriber was not told to consume. */
export class CommandNotConsumed extends Error {
  static readonly failureKind = "permission_denied";
  readonly reason = "COMMAND_NOT_CONSUMED";

  constructor(readonly type: string) {
    super(`${type} is not consumed from this queue: name it in the subscriber's commands`);
    this.name = "CommandNotConsumed";
  }
}

function isOptions(value: unknown): value is SubscriberOptions {
  return (
    value !== null &&
    typeof value === "object" &&
    Array.isArray((value as Partial<SubscriberOptions>).boundedContexts)
  );
}

function wireNames(keys: readonly DtoKey[] | undefined): ReadonlySet<string> | undefined {
  if (keys === undefined) return undefined;
  const names = new Set<string>();
  for (const key of keys) {
    const wire = keyIdentity(key).wire;
    if (wire === undefined || wire.trim() === "")
      throw new TypeError(
        "A subscriber names an event by its eventName, a Command by its commandName",
      );
    names.add(wire);
  }
  return names;
}

/** A bus delivered to, under the key its consumers are acknowledged by. */
type Bus = { readonly context: HearingContext; readonly key: string };

/** The consumers of a bus: what it says, or — a bus that says nothing — its one use case. */
function consumersIn(bus: Bus, event: DomainEvent | RemoteEvent): readonly EventConsumer[] {
  const { context, key } = bus;
  let consumers: readonly EventConsumer[];
  if (context.consumersOf) consumers = context.consumersOf(event);
  else {
    const known = identityOf(event);
    const hears =
      known?.type !== undefined
        ? context.handlerOf(known.type as DtoKey) !== undefined
        : context.eventTypeOf(known?.wire ?? "") !== undefined;
    consumers = hears
      ? [{ key: context.name, consume: (heard, cause) => context.execute(heard, cause) }]
      : [];
  }
  if (key === context.name) return consumers;
  // Another bus of the same name: its consumers are acknowledged under its own key.
  return consumers.map((one) => ({
    key: one.key === context.name ? key : `${key}${one.key.slice(context.name.length)}`,
    consume: one.consume,
  }));
}

/**
 * The queue's entrypoint — the backend's `Subscriber(*buses)` and `QueueGateway`, composed: it
 * pulls what the queue delivers, rebuilds it and hands it to every consumer subscribed to it —
 * its own event handlers, and the buses added to it, each with its use case and its handlers.
 *
 *     // entrypoints/queue/framework.ts — once, like a bounded context's framework.ts
 *     export const { EventHandler } = handlersWith<AppSubscriberDependencies>();
 *     export const appSubscriber = new Subscriber<AppSubscriberDependencies>("app");
 *     appSubscriber.addDependency("invoicingBoundedContext", invoicingBoundedContext); // to call it
 *     appSubscriber.addDependency("notifier", deviceNotifier);
 *     appSubscriber.addBus(salesBoundedContext);  // to deliver to its use cases and handlers
 *
 *     // entrypoints/queue/sale_paid.handler.ts — events → handler
 *     @appSubscriber.handler([SalePaid])
 *     export class NotifySalePaid extends EventHandler<SalePaid> { async handle(event) { … } }
 *
 *     storedQueue({ store, subscriber: appSubscriber });
 *
 * Context: one per queue, never one per handler. Two levels, never mixed: a dependency — a bus
 * to call included — is what its handlers find on `this` (`addDependency`, by name); a bus added
 * (`addBus`, by its own namespace) is one it delivers to. Adding the same bus again changes
 * nothing; another bus of the same name is delivered to as well (`sales#2`). Every consumer is
 * acknowledged apart — `app/NotifySalePaid`, `sales`, `sales/OnSalePaid` —, which a stored queue
 * keeps, so a redelivery runs only who does not have it yet. A Command is a request to one bus,
 * by its identity, and only when it was declared here.
 */
export class Subscriber<D extends object = Record<never, never>> implements Subscribes {
  /** Its namespace: its own handlers are said `<name>/<Handler>`. */
  readonly name: string;
  private readonly buses: Bus[] = [];
  private readonly dependencyValues = new Map<string, unknown>();
  private readonly handlers: HandlerRegistration[] = [];
  private readonly instances = new Map<HandlerClass, object>();
  private readonly events: ReadonlySet<string> | undefined;
  private readonly commands: ReadonlySet<string>;

  constructor(name: string, options?: NamedSubscriberOptions);
  constructor(options: SubscriberOptions);
  constructor(...boundedContexts: HearingContext[]);
  constructor(...given: unknown[]) {
    let options: NamedSubscriberOptions;
    let boundedContexts: readonly HearingContext[] = [];
    if (typeof given[0] === "string") {
      const name = given[0];
      if (name.trim() === "" || name.includes("/")) {
        throw new TypeError("A subscriber needs a nonempty name without '/'");
      }
      this.name = name;
      options = (given[1] as NamedSubscriberOptions | undefined) ?? {};
    } else {
      this.name = "";
      const all: SubscriberOptions =
        given.length === 1 && isOptions(given[0])
          ? given[0]
          : { boundedContexts: given as HearingContext[] };
      options = all;
      boundedContexts = all.boundedContexts;
    }
    this.events = wireNames(options.events);
    this.commands = wireNames(options.commands) ?? new Set();
    for (const boundedContext of boundedContexts) this.addBus(boundedContext);
  }

  /**
   * What its handlers find on `this` — a bus they call, a notifier, a repository —, by name; a
   * dependency carrying `BIND` (a bounded context, a publisher) is bound to the handler's run.
   */
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
      throw new Error(`Replacement does not match the dependency: ${name}`);
    }
    this.dependencyValues.set(name, dependency);
    return this;
  }

  /**
   * A bus it delivers to: the events its use cases and handlers are registered for reach them
   * through this subscriber. By its namespace — no name to write —; the same bus again changes
   * nothing, another of the same name is delivered to as well. It is not a dependency: a
   * handler that calls a bus has it as one (`addDependency`).
   */
  addBus(boundedContext: HearingContext): this {
    if (this.buses.some((one) => one.context === boundedContext)) return this;
    const sameName = this.buses.filter((one) => one.context.name === boundedContext.name);
    const key =
      sameName.length === 0
        ? boundedContext.name
        : `${boundedContext.name}#${sameName.length + 1}`;
    this.buses.push({ context: boundedContext, key });
    return this;
  }

  /**
   * Registers an event handler of this subscriber for one event or N — as a decorator, or
   * called with the class:
   *
   *     @appSubscriber.handler([SalePaid, SaleCancelled])
   *     export class OnSaleChanged extends EventHandler<SalePaid | SaleCancelled> { … }
   *
   *     appSubscriber.handler([SalePaid, SaleCancelled])(OnSaleChanged);
   */
  handler<const K extends readonly EventKey[]>(
    events: K,
  ): HandlerRegistrar<ExecutableOf<K[number]> & HandledEvent>;
  handler<E extends DomainEvent>(event: EventClass<E>): HandlerRegistrar<E>;
  handler<E extends RemoteEvent = RemoteEvent>(event: EventDescriptor): HandlerRegistrar<E>;
  handler(events: EventKey | readonly EventKey[]): HandlerRegistrar<HandledEvent> {
    const keys = eventKeysOf(events);
    return handlerRegistrar((Handler, name) => {
      if (this.name === "") {
        throw new Error("A subscriber with event handlers has a name: new Subscriber(name)");
      }
      if (this.handlers.some((one) => one.Handler === Handler)) {
        throw new Error(
          `Event handler already registered: ${name} — list all its events once`,
        );
      }
      if (this.handlers.some((one) => one.name === name)) {
        throw new Error(`Event handler name already registered: ${name}`);
      }
      this.handlers.push({ name, Handler, events: keys });
    });
  }

  /** What an event of that wire name is rebuilt as, or `undefined` when nobody here hears it. */
  eventTypeOf(name: string): EventType | undefined {
    if (this.events !== undefined && !this.events.has(name)) return undefined;
    for (const registration of this.handlers) {
      for (const key of registration.events) {
        if (keyIdentity(key).wire === name) return key;
      }
    }
    for (const bus of this.buses) {
      const found = bus.context.eventTypeOf(name);
      if (found) return found;
    }
    return undefined;
  }

  /** What a consumed Command of that identity is rebuilt as, or `undefined` when it is not consumed here. */
  commandTypeOf(identity: string): CommandType | undefined {
    if (!this.commands.has(identity)) return undefined;
    for (const bus of this.buses) {
      const found = bus.context.commandTypeOf(identity);
      if (found) return found;
    }
    return undefined;
  }

  /**
   * 1. Who consumes the event here: its own handlers, then each bus added, in the order added —
   *    the bus's use case, then its handlers —; none when this subscriber does not hear it.
   * 2. Those `skip` names already have it; each other one consumes it — continuing the
   *    envelope's flow and trace when there is one —, and its answer or failure is kept: a
   *    failure does not stop the next.
   * Final: what each consumer answered, or failed with, under its key.
   */
  async handle(
    event: DomainEvent | RemoteEvent,
    envelope?: Envelope,
    skip: readonly string[] = [],
  ): Promise<Handled[]> {
    const handled: Handled[] = [];
    for (const consumer of this.consumersOf(event)) {
      if (skip.includes(consumer.key)) continue;
      try {
        handled.push({
          boundedContext: consumer.key,
          answer: await consumer.consume(event, envelope),
        });
      } catch (error) {
        handled.push({ boundedContext: consumer.key, error });
      }
    }
    return handled;
  }

  /**
   * What a queue delivered — CloudEvents, structured or in a broker's binary mode —, executed:
   *
   * 1. An event this subscriber hears (by its `type`, the event's name): rebuilt as what it is
   *    known by here and handed to every consumer subscribed to it (`handle`).
   * 2. A Command (its `type`, its identity): only when declared — `CommandNotConsumed` when a bus
   *    registered it but this subscriber does not consume it —, rebuilt and executed by the one
   *    bus that registered it.
   * 3. Either continues the message's flow and trace.
   * Final: what each answered, or failed with; nothing when nobody here knows it.
   */
  async receive(
    arrived: Message | BinaryMessage,
    skip: readonly string[] = [],
  ): Promise<Handled[]> {
    const message = readMessage(arrived);
    const eventType = this.eventTypeOf(message.type);
    if (eventType !== undefined)
      return this.handle(eventFrom(eventType, message.data), envelopeFrom(message), skip);
    const commandType = this.commandTypeOf(message.type);
    if (commandType === undefined) {
      if (this.buses.some((one) => one.context.commandTypeOf(message.type) !== undefined))
        throw new CommandNotConsumed(message.type);
      return [];
    }
    return this.execute(commandFrom(commandType, message.data), envelopeFrom(message), skip);
  }

  /**
   * A Command this subscriber consumes, executed by the one bus that registered it — continuing
   * the envelope's flow and trace when there is one —; nothing when that bus is in `skip`.
   * One it does not consume is `CommandNotConsumed`: a bus never runs a Command it did not ask
   * for.
   * Final: what the bus answered, or failed with.
   */
  async execute(
    command: AnyCommand | RemoteCommand,
    envelope?: Envelope,
    skip: readonly string[] = [],
  ): Promise<Handled[]> {
    const identity = identityOf(command)?.wire ?? "";
    if (this.commandTypeOf(identity) === undefined) throw new CommandNotConsumed(identity);
    const bus = this.buses.find((one) => one.context.commandTypeOf(identity) !== undefined);
    if (bus === undefined || skip.includes(bus.key)) return [];
    try {
      const answer = await bus.context.execute(command, envelope ? { cause: envelope } : {});
      return [{ boundedContext: bus.key, answer }];
    } catch (error) {
      return [{ boundedContext: bus.key, error }];
    }
  }

  /** Every consumer of `event`, each under a key no other one has. */
  private consumersOf(event: DomainEvent | RemoteEvent): readonly EventConsumer[] {
    const known = identityOf(event);
    if (known?.kind !== "event") return [];
    if (this.events !== undefined && !this.events.has(known.wire ?? "")) return [];
    const consumers: EventConsumer[] = [];
    for (const registration of this.handlers) {
      if (!registration.events.some((key) => handles(key, known))) continue;
      consumers.push(this.consumerOf(registration));
    }
    for (const bus of this.buses) consumers.push(...consumersIn(bus, event));
    const keys = new Set<string>();
    for (const consumer of consumers) {
      if (keys.has(consumer.key)) {
        throw new Error(
          `Two consumers are ${consumer.key}: the queue keeps who has a message by it`,
        );
      }
      keys.add(consumer.key);
    }
    return consumers;
  }

  /** One of its own handlers, as a consumer: its run, with this subscriber's dependencies. */
  private consumerOf(registration: HandlerRegistration): EventConsumer {
    const everyContext = processHearing();
    return {
      key: `${this.name}/${registration.name}`,
      consume: (event, cause) => {
        let instance = this.instances.get(registration.Handler);
        if (instance === undefined) {
          instance = new registration.Handler();
          this.instances.set(registration.Handler, instance);
        }
        return runHandler(instance, event, {
          owner: this.name,
          name: registration.name,
          dependencies: this.dependencyValues,
          context: () => ({ ...processContext.values }),
          ...(cause ? { cause } : {}),
          expected: () => false,
          interceptors: [],
          announce: {
            started: (heard) => announceTo(everyContext.started, heard),
            completed: (heard) => announceTo(everyContext.completed, heard),
          },
          failed: (heard) => announceTo(everyContext.failed, heard),
        });
      },
    };
  }
}
