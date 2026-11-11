import { newEntityId } from "@sincpro/client-framework/common/ids";
import {
  type JsonValue,
  readValues,
  rebuilt,
  valuesOf,
} from "@sincpro/client-framework/common/serialization";
import {
  type AnyCommand,
  commandOf,
  type DomainEvent,
  type RemoteCommand,
  type RemoteEvent,
} from "@sincpro/client-framework/core/domain/dto";
import type { Cause } from "@sincpro/client-framework/core/domain/pipeline";
import {
  identityOf,
  isCommandDescriptor,
  isEventDescriptor,
} from "@sincpro/client-framework/core/services/dto-keys";
import type { Envelope } from "@sincpro/client-framework/event_driven/domain/envelope";
import type {
  CommandMessage,
  EventMessage,
} from "@sincpro/client-framework/event_driven/domain/messages";
import type {
  CommandType,
  EventType,
} from "@sincpro/client-framework/event_driven/domain/queue";

/** The values of a DTO as they travel: what it carries, never how it is routed. */
function dataOf(dto: object): JsonValue {
  return valuesOf(dto);
}

/** `values` as an instance of `type`: its `static fromJSON` when it has one, else set on one. */
function instanceOf<T>(type: abstract new (...args: never[]) => T, values: unknown): T {
  if (typeof (type as { fromJSON?: unknown }).fromJSON === "function")
    return rebuilt(values, type as unknown as (values: unknown) => T);
  return Object.assign(Object.create(type.prototype) as object, values) as T;
}

/** `event` as it travels, beside its envelope. */
export function eventMessageOf(
  event: DomainEvent | RemoteEvent,
  envelope: Envelope,
): EventMessage {
  return { kind: "event", envelope, data: dataOf(event) };
}

/**
 * `command` as it travels — sent by the run `cause` names, or the head of its own flow.
 *
 *     commandMessageOf(new CommandIssueInvoice("o-1"))   ->  { kind: "command", type: "billing.CommandIssueInvoice", … }
 *     commandMessageOf(new CommandWithoutIdentity())     ->  TypeError: it declares no commandName
 */
export function commandMessageOf(
  command: AnyCommand | RemoteCommand,
  cause?: Cause,
): CommandMessage {
  const known = identityOf(command);
  if (known?.kind !== "command" || known.wire === undefined || known.wire.trim() === "") {
    throw new TypeError(
      `${known?.type?.name ?? "This Command"} declares no commandName: a Command travels by its identity`,
    );
  }
  const id = newEntityId();
  return {
    kind: "command",
    type: known.wire,
    id,
    correlationId: cause?.correlationId ?? id,
    causationId: cause?.id ?? null,
    sentAt: new Date().toISOString(),
    data: dataOf(command),
  };
}

/**
 * An event's values as what they are here: an instance of its class — `static fromJSON` when it
 * has one —, or the generated event's data, its wire name in it.
 */
export function eventFrom(type: EventType, data: JsonValue): DomainEvent | RemoteEvent {
  const values = readValues(data);
  if (isEventDescriptor(type))
    return { ...(values as Record<string, unknown>), name: type.name } as RemoteEvent;
  return instanceOf(type, values);
}

/** A Command's values as what they are here: an instance of its class, or the generated Command. */
export function commandFrom(type: CommandType, data: JsonValue): AnyCommand | RemoteCommand {
  const values = readValues(data);
  if (isCommandDescriptor(type)) return commandOf(type, values as object);
  return instanceOf(type, values);
}

/** The cause a delivered Command continues: the message it came in. */
export function causeOf(message: CommandMessage): Cause {
  return { id: message.id, correlationId: message.correlationId };
}
