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

/**
 * A request for work, to one bus. Its identity is the framework's, taken when a bounded context
 * registers it — `<context>.<Command>`, as the backend's `registered_name` —: what its message
 * says (`type`), what the receiving bus finds its class by, and what a generated contract's
 * `operations` carry. A production build keeps class names; `static commandName` fixes another.
 */
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
 * and defaults it to the class's name; here it is declared: it is the contract other processes
 * read, with its version, not a class's name. `name` is reserved, as the backend reserves it: every event reads its class's
 * `eventName` there, and a subclass cannot make it a field.
 */
export abstract class DomainEvent extends DataTransferObject {
  declare protected readonly eventBrand: void;

  /** Its wire name: its class's `eventName`. */
  get name(): string {
    return (this.constructor as Partial<EventNamed>).eventName ?? "";
  }
}

/** An event's wire name: dotted, as the backend's `<context>.<aggregate>.vN.<fact>`. */
export const EVENT_NAME = /^[\w-]+(\.[\w-]+)+$/;

/** What an event class declares: the name it is known by on the wire. */
type EventNamed = { readonly eventName: string };

export type AnyCommand = Command<unknown>;

/**
 * A generated event as it travels: plain data with its wire name — the type a contract exported
 * with `--events` describes (`dto.OrderPaid`), no class written for it.
 */
export type RemoteEvent = {
  readonly name: string;
  /** A DTO class's instance is not a generated event: it is a Command, a Response or a DomainEvent. */
  readonly dtoBrand?: never;
  /** Whatever else the contract says it carries. */
  readonly [field: string]: unknown;
};

/** What a generated Command carries beside its input: the contract's identity. Never serialized with its data. */
export const COMMAND_IDENTITY: unique symbol = Symbol.for("sincpro.client-framework.command");

declare const remoteAnswer: unique symbol;

/**
 * A generated Command as the bus executes it: its input, as the contract types it, tagged with
 * the operation's identity (`commandOf(operations.CommandSendIssue, input)`).
 */
export type RemoteCommand<I = unknown, R = unknown> = Readonly<I> & {
  readonly [COMMAND_IDENTITY]: string;
  /** Type-only: what it answers. */
  readonly [remoteAnswer]?: R;
};

/** A generated event a service is registered for: its entry in the contract's `events` (`events.OrderPaid`). */
export type EventDescriptor = { readonly name: string; readonly prototype?: never };

/** A generated Command a service is registered for: its entry in the contract's `operations`. */
export type CommandDescriptor = { readonly identity: string; readonly prototype?: never };

/**
 * The generated Command `operation` names, with `input`, as the bus executes it:
 *
 *     await projectBoundedContext.execute(commandOf(operations.CommandSendIssue, input));
 */
export function commandOf<I extends object, R = unknown>(
  operation: CommandDescriptor,
  input: I,
): RemoteCommand<I, R> {
  const command = { ...input };
  Object.defineProperty(command, COMMAND_IDENTITY, { value: operation.identity });
  return command as RemoteCommand<I, R>;
}

/**
 * What a service is registered for and executes: a Command, a domain event — or a generated
 * one, recognized by its identity or its wire name.
 */
export type Executable = AnyCommand | DomainEvent | RemoteEvent | RemoteCommand;

/** What it answers: a Command's Response; whatever its use case returns, for an event. */
export type Answer<T> =
  T extends Command<infer R> ? R : T extends RemoteCommand<unknown, infer R> ? R : unknown;

/** A Command's class: what a service is registered for, by exact constructor identity. */
export type CommandClass<C extends AnyCommand> = abstract new (...args: never[]) => C;

/** What a Command class that travels declares: its identity, `<context>.<Command>`. */
export type CommandNamed = { readonly commandName?: string };

/** A domain event's class, with its wire name. */
export type EventClass<E extends DomainEvent> = (abstract new (...args: never[]) => E) &
  EventNamed;

/** A Response's class: the backend's `return_type`, accepted for the same reading. */
export type ResponseClass<R> = abstract new (...args: never[]) => R;

/**
 * What a service is registered for — a Command's class, a domain event's class, or a generated
 * one's entry in the contract (`operations.X`, `events.X`) —, one or a list of them, as the
 * backend's `DTORegistration`.
 */
export type DtoKey =
  CommandClass<AnyCommand> | EventClass<DomainEvent> | EventDescriptor | CommandDescriptor;

/** What a service registered for `K` receives. */
export type ExecutableOf<K> = K extends abstract new (...args: never[]) => infer E
  ? E extends Executable
    ? E
    : never
  : K extends CommandDescriptor
    ? RemoteCommand
    : K extends EventDescriptor
      ? RemoteEvent
      : never;
