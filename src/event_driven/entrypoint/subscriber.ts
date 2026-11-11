import type {
  AnyCommand,
  CommandClass,
  CommandDescriptor,
  DomainEvent,
  DtoKey,
  EventClass,
  EventDescriptor,
  Executable,
  RemoteEvent,
} from "@sincpro/client-framework/core/domain/dto";
import type { Cause, ExecuteOptions } from "@sincpro/client-framework/core/domain/pipeline";
import { identityOf, keyIdentity } from "@sincpro/client-framework/core/services/dto-keys";
import type { Envelope } from "@sincpro/client-framework/event_driven/domain/envelope";
import type { Message } from "@sincpro/client-framework/event_driven/domain/messages";
import type {
  CommandType,
  EventType,
  Handled,
  Subscribes,
} from "@sincpro/client-framework/event_driven/domain/queue";
import {
  causeOf,
  commandFrom,
  eventFrom,
} from "@sincpro/client-framework/event_driven/services/messages";

/** What the subscriber needs of a bounded context: what it registered, and running it. */
export type HearingContext = {
  readonly name: string;
  handlerOf(dto: DtoKey): unknown;
  eventTypeOf(name: string): EventType | undefined;
  commandTypeOf(identity: string): CommandType | undefined;
  execute(executable: Executable, options?: ExecuteOptions | Cause): Promise<unknown>;
};

/** Which bounded contexts it hands messages to, and what it takes from the queue. */
export type SubscriberOptions = {
  readonly boundedContexts: readonly HearingContext[];
  /** The events it hears; every event the bounded contexts registered when none is named. */
  readonly events?: readonly (EventClass<DomainEvent> | EventDescriptor)[];
  /**
   * The Commands it consumes from the queue — none unless named, as the backend's
   * `@queue.consumes`: a bus never hands all its Commands to whoever can publish on a queue.
   */
  readonly commands?: readonly (CommandClass<AnyCommand> | CommandDescriptor)[];
};

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

/**
 * The queue's entrypoint — the backend's `Subscriber(*buses)` and `QueueGateway`: what arrives is
 * recognized, rebuilt and executed on the bus that registered it.
 *
 *     new Subscriber(billingBoundedContext, accountingBoundedContext)   // every event they registered
 *     new Subscriber({
 *       boundedContexts: [billingBoundedContext],
 *       events: [OrderPaid, events.IssueClosed],                        // only these
 *       commands: [CommandIssueInvoice],                                // consumed: declared
 *     })
 *     await subscriber.receive(message);                                 // what each one answered
 *
 * Context: one per queue, never one per event — registering a use case for an event is the
 * subscription. An event is a fact N buses hear, by its wire name; a Command is a request to one
 * bus, by its identity, and only when it was declared here. Several hearing one event is several
 * executions, one each, in the order named; one that fails does not stop the others, and each is
 * said under its bounded context's name — which a stored queue keeps, so a redelivery never runs
 * one again. Two never share a name.
 */
export class Subscriber implements Subscribes {
  private readonly contexts: readonly HearingContext[];
  private readonly events: ReadonlySet<string> | undefined;
  private readonly commands: ReadonlySet<string>;

  constructor(options: SubscriberOptions);
  constructor(...boundedContexts: HearingContext[]);
  constructor(...given: unknown[]) {
    const options: SubscriberOptions =
      given.length === 1 && isOptions(given[0])
        ? given[0]
        : { boundedContexts: given as HearingContext[] };
    const names = new Set<string>();
    for (const context of options.boundedContexts) {
      if (names.has(context.name)) {
        throw new Error(
          `Two bounded contexts are named ${context.name}: the queue keeps who heard a message by its name`,
        );
      }
      names.add(context.name);
    }
    this.contexts = options.boundedContexts;
    this.events = wireNames(options.events);
    this.commands = wireNames(options.commands) ?? new Set();
  }

  /** What an event of that wire name is rebuilt as, or `undefined` when nobody here hears it. */
  eventTypeOf(name: string): EventType | undefined {
    if (this.events !== undefined && !this.events.has(name)) return undefined;
    for (const context of this.contexts) {
      const found = context.eventTypeOf(name);
      if (found) return found;
    }
    return undefined;
  }

  /** What a consumed Command of that identity is rebuilt as, or `undefined` when it is not consumed here. */
  commandTypeOf(identity: string): CommandType | undefined {
    if (!this.commands.has(identity)) return undefined;
    for (const context of this.contexts) {
      const found = context.commandTypeOf(identity);
      if (found) return found;
    }
    return undefined;
  }

  /**
   * 1. Every bounded context that registered the event — its class exactly, or its wire name for
   *    a generated one —, in the order named, but those `skip` names, which already have it.
   * 2. Each executes it — continuing the envelope's flow when there is one —, and its answer or
   *    failure is kept; a failure does not stop the next.
   * Final: what each answered, or failed with; nothing when this subscriber does not hear it.
   */
  async handle(
    event: DomainEvent | RemoteEvent,
    envelope?: Envelope,
    skip: readonly string[] = [],
  ): Promise<Handled[]> {
    const known = identityOf(event);
    if (known?.kind !== "event") return [];
    if (this.events !== undefined && !this.events.has(known.wire ?? "")) return [];
    const handled: Handled[] = [];
    for (const context of this.contexts) {
      const hears =
        known.type !== undefined
          ? context.handlerOf(known.type as DtoKey) !== undefined
          : context.eventTypeOf(known.wire ?? "") !== undefined;
      if (!hears || skip.includes(context.name)) continue;
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

  /**
   * What a queue delivered, executed:
   *
   * 1. An event: rebuilt as what it is known by here and handed to every bounded context that
   *    registered it (`handle`); one nobody here hears answers nothing.
   * 2. A Command: consumed only when declared (`CommandNotConsumed` otherwise), rebuilt, and
   *    executed by the one bounded context that registered it, continuing the message's flow.
   * Final: what each answered, or failed with.
   */
  async receive(message: Message, skip: readonly string[] = []): Promise<Handled[]> {
    if (message.kind === "event") {
      const type = this.eventTypeOf(message.envelope.name);
      if (type === undefined) return [];
      return this.handle(eventFrom(type, message.data), message.envelope, skip);
    }
    const type = this.commandTypeOf(message.type);
    if (type === undefined) throw new CommandNotConsumed(message.type);
    const context = this.contexts.find(
      (one) => one.commandTypeOf(message.type) !== undefined,
    );
    if (context === undefined || skip.includes(context.name)) return [];
    try {
      const answer = await context.execute(commandFrom(type, message.data), {
        cause: causeOf(message),
      });
      return [{ boundedContext: context.name, answer }];
    } catch (error) {
      return [{ boundedContext: context.name, error }];
    }
  }
}
