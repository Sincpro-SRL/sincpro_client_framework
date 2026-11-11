import {
  type AnyCommand,
  Command,
  COMMAND_IDENTITY,
  type CommandClass,
  type CommandDescriptor,
  type CommandNamed,
  DomainEvent,
  type DtoKey,
  type EventClass,
  type EventDescriptor,
  type Executable,
} from "@sincpro/client-framework/core/domain/dto";

/** How a DTO travels: a Command to one bus, by its identity; an event to N, by its wire name. */
export type DtoKind = "command" | "event";

/** What a DTO is known by: its kind, its class when it has one, and its wire identity when it has one. */
export type DtoIdentity = {
  readonly kind: DtoKind;
  /** The class it is an instance of; `undefined` for a generated DTO, which is data. */
  readonly type: (abstract new (...args: never[]) => object) | undefined;
  /** A Command's identity (`<context>.<Command>`), an event's wire name; `undefined` when none is declared. */
  readonly wire: string | undefined;
};

export function isEventClass(key: unknown): key is EventClass<DomainEvent> {
  return typeof key === "function" && key.prototype instanceof DomainEvent;
}

export function isCommandClass(key: unknown): key is CommandClass<AnyCommand> {
  return typeof key === "function" && key.prototype instanceof Command;
}

export function isCommandDescriptor(key: unknown): key is CommandDescriptor {
  return (
    key !== null &&
    typeof key === "object" &&
    typeof (key as Partial<CommandDescriptor>).identity === "string"
  );
}

export function isEventDescriptor(key: unknown): key is EventDescriptor {
  return (
    key !== null &&
    typeof key === "object" &&
    !isCommandDescriptor(key) &&
    typeof (key as Partial<EventDescriptor>).name === "string"
  );
}

/** Whether `key` is something a service can be registered for. */
export function isDtoKey(key: unknown): key is DtoKey {
  return (
    isCommandClass(key) ||
    isEventClass(key) ||
    isCommandDescriptor(key) ||
    isEventDescriptor(key)
  );
}

/**
 * What a registration key names:
 *
 *     keyIdentity(CommandIssueInvoice)        ->  { kind: "command", type: CommandIssueInvoice, wire: "billing.CommandIssueInvoice" }
 *     keyIdentity(OrderPaid)                  ->  { kind: "event", type: OrderPaid, wire: "shop.order.v1.paid" }
 *     keyIdentity(operations.CommandSendIssue) -> { kind: "command", type: undefined, wire: "project.CommandSendIssue" }
 *     keyIdentity(events.IssueClosed)         ->  { kind: "event", type: undefined, wire: "project.issue.v1.closed" }
 */
export function keyIdentity(key: DtoKey): DtoIdentity {
  if (isEventClass(key)) return { kind: "event", type: key, wire: key.eventName };
  if (isCommandClass(key))
    return { kind: "command", type: key, wire: (key as CommandNamed).commandName };
  if (isCommandDescriptor(key))
    return { kind: "command", type: undefined, wire: key.identity };
  return { kind: "event", type: undefined, wire: (key as EventDescriptor).name };
}

/**
 * What a value being executed is:
 *
 * 1. An instance of a Command or a domain event: its class, and the identity the class declares.
 * 2. A generated Command (`commandOf`): the identity it carries.
 * 3. A generated event: the wire name in its data.
 * Final: `undefined` for anything else — nothing a bus executes.
 */
export function identityOf(executable: unknown): DtoIdentity | undefined {
  if (executable instanceof DomainEvent) {
    const type = Object.getPrototypeOf(executable)?.constructor as EventClass<DomainEvent>;
    return { kind: "event", type, wire: executable.name || undefined };
  }
  if (executable instanceof Command) {
    const type = Object.getPrototypeOf(executable)?.constructor as CommandClass<AnyCommand> &
      CommandNamed;
    return { kind: "command", type, wire: type.commandName };
  }
  if (executable === null || typeof executable !== "object") return undefined;
  const carried = (executable as Partial<Record<typeof COMMAND_IDENTITY, unknown>>)[
    COMMAND_IDENTITY
  ];
  if (typeof carried === "string") return { kind: "command", type: undefined, wire: carried };
  const name = (executable as { name?: unknown }).name;
  if (typeof name === "string" && name !== "")
    return { kind: "event", type: undefined, wire: name };
  return undefined;
}

/**
 * Whether `key` is what `executable` was registered under: the same class — exactly, a subclass
 * is another DTO — or, for a generated DTO, the same kind and wire identity.
 */
export function matches(key: DtoKey, executable: Executable): boolean {
  const known = identityOf(executable);
  if (known === undefined) return false;
  const wanted = keyIdentity(key);
  if (wanted.type !== undefined) return known.type === wanted.type;
  return known.type === undefined && known.kind === wanted.kind && known.wire === wanted.wire;
}

/** Whether two values being executed are the same DTO: an interceptor passes on only that. */
export function sameDto(left: unknown, right: unknown): boolean {
  const one = identityOf(left);
  const other = identityOf(right);
  if (one === undefined || other === undefined) return false;
  if (one.type !== undefined || other.type !== undefined) return one.type === other.type;
  return one.kind === other.kind && one.wire === other.wire;
}

/** A DTO's name for a message: its wire identity, or its class's name. */
export function describeDto(executable: unknown): string {
  const known = identityOf(executable);
  return known?.wire ?? known?.type?.name ?? typeof executable;
}
