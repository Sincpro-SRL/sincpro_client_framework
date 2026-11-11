/**
 * The DTOs of the application layer, as sincpro_framework's `DataTransferObject`: a Command asks
 * for work and names, by its type, the Response it answers.
 *
 *     class CommandCancelIssue extends Command<ResponseCancelIssue> {
 *       constructor(readonly issue_id: string) { super(); }
 *     }
 *     const answer = await projectBoundedContext.execute(new CommandCancelIssue("x"));   // ResponseCancelIssue
 *
 * Context: the backend asks `bus(dto, ResponseType)` for the type; here the Command carries it, so
 * `execute` infers it with no second argument. The association is type-only: absent from a
 * serialized DTO, not a runtime validator. A generated DTO is a remote contract (a type), not one
 * of these: a local Command may implement it.
 */
export abstract class DataTransferObject {
  declare protected readonly dtoBrand: void;
}

export abstract class Response extends DataTransferObject {}

declare const responseType: unique symbol;

export abstract class Command<R> extends DataTransferObject {
  /** Type-only association: absent from serialized DTOs and not a runtime validator. */
  declare readonly [responseType]: R;
}

/**
 * A fact that already happened, as sincpro_framework's `DomainEvent`: executed like a Command, by
 * the Feature or ApplicationService registered for its class — its subscriber in this bounded
 * context —, through the same pipeline. Delivering it (a queue, an outbox) is the platform's.
 *
 *     class OrderPaid extends DomainEvent {
 *       static readonly eventName = "shop.order.v1.paid";
 *       constructor(readonly order_id: string) { super(); }
 *     }
 *     projectBoundedContext.feature(OrderPaid)(NotifyCustomer);
 *     await projectBoundedContext.execute(new OrderPaid("o-1"));
 *
 * Context: the backend names an event on the wire by `name`, `<context>.<aggregate>.vN.<fact>`,
 * and defaults it to the class's name; a client is minified, so the name is declared, as
 * `serviceName` is. `name` is reserved, as the backend reserves it: every event reads its class's
 * `eventName` there, and a subclass cannot make it a field.
 */
export abstract class DomainEvent extends DataTransferObject {
  declare protected readonly eventBrand: void;

  /** Its wire name: its class's `eventName`. */
  get name(): string {
    return (this.constructor as Partial<EventNamed>).eventName ?? "";
  }
}

/** What an event class declares: the name it is known by on the wire. */
type EventNamed = { readonly eventName: string };

export type AnyCommand = Command<unknown>;

/** What a service is registered for and executes: a Command, or a domain event. */
export type Executable = AnyCommand | DomainEvent;

/** What it answers: a Command's Response; whatever its subscriber returns, for an event. */
export type Answer<T> = T extends Command<infer R> ? R : unknown;

/** A Command's class: what a service is registered for, by exact constructor identity. */
export type CommandClass<C extends AnyCommand> = abstract new (...args: never[]) => C;

/** A domain event's class, with its wire name. */
export type EventClass<E extends DomainEvent> = (abstract new (...args: never[]) => E) &
  EventNamed;

/** A Response's class: the backend's `return_type`, accepted for the same reading. */
export type ResponseClass<R> = abstract new (...args: never[]) => R;
