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
  BinaryMessage,
  Message,
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

/** The attributes a message carries besides its data: who produced it, about which entity. */
export type MessageOptions = { readonly source?: string; readonly subject?: string };

/**
 * `event` as it travels, with its envelope — its `name` in the data too, as the backend's
 * `as_json`, so a body read alone says which event it is.
 */
export function eventMessageOf(
  event: DomainEvent | RemoteEvent,
  envelope: Envelope,
  options: MessageOptions = {},
): Message {
  return {
    specversion: "1.0",
    id: envelope.id,
    source: options.source ?? "",
    type: envelope.name,
    ...(options.subject ? { subject: options.subject } : {}),
    time: envelope.publishedAt,
    correlationid: envelope.correlationId,
    ...(envelope.causationId ? { causationid: envelope.causationId } : {}),
    ...(envelope.traceparent ? { traceparent: envelope.traceparent } : {}),
    ...(envelope.tracestate ? { tracestate: envelope.tracestate } : {}),
    datacontenttype: "application/json",
    data: { name: envelope.name, ...(dataOf(event) as Record<string, JsonValue>) },
  };
}

/**
 * `command` as it travels — sent by the run `cause` names, or the head of its own flow; its
 * `type` is its identity, which a bounded context gave it when it registered it.
 *
 *     commandMessageOf(new CommandIssueInvoice("o-1"))   ->  { type: "billing.CommandIssueInvoice", … }
 *     commandMessageOf(new CommandNobodyRegistered())    ->  TypeError: it has no identity
 */
export function commandMessageOf(
  command: AnyCommand | RemoteCommand,
  cause?: Cause,
  options: MessageOptions = {},
): Message {
  const known = identityOf(command);
  if (known?.kind !== "command" || known.wire === undefined || known.wire.trim() === "") {
    throw new TypeError(
      `${known?.type?.name ?? "This Command"} has no identity: a bounded context gives it one when it registers it`,
    );
  }
  const id = newEntityId();
  return {
    specversion: "1.0",
    id,
    source: options.source ?? "",
    type: known.wire,
    ...(options.subject ? { subject: options.subject } : {}),
    time: new Date().toISOString(),
    correlationid: cause?.correlationId ?? id,
    ...(cause?.id ? { causationid: cause.id } : {}),
    ...(cause?.traceparent ? { traceparent: cause.traceparent } : {}),
    ...(cause?.tracestate ? { tracestate: cause.tracestate } : {}),
    datacontenttype: "application/json",
    data: dataOf(command),
  };
}

const PREFIXES = ["ce_", "ce-", "cloudEvents:", "cloudEvents_"] as const;

/** A header as text: a broker may hand bytes. */
function text(value: string | Uint8Array | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  return typeof value === "string" ? value : new TextDecoder().decode(value);
}

/**
 * What arrived, as one message — structured already, or a broker's binary mode: the attributes
 * under any CloudEvents binding's prefix (`ce_`, `ce-`, `cloudEvents:`), the type falling back to
 * the `sincpro-event` header, as the backend's `Envelope.of` reads them.
 */
export function readMessage(arrived: Message | BinaryMessage): Message {
  if (!("headers" in arrived)) return arrived;
  const headers = arrived.headers;
  const attribute = (name: string) => {
    for (const prefix of PREFIXES) {
      const found = text(headers[`${prefix}${name}`]);
      if (found) return found;
    }
    return undefined;
  };
  const data =
    typeof arrived.body === "string" ? (JSON.parse(arrived.body) as JsonValue) : arrived.body;
  const id = attribute("id") ?? newEntityId();
  const type =
    attribute("type") ??
    text(headers["sincpro-event"]) ??
    String((data as { name?: unknown } | null)?.name ?? "");
  const causationid = attribute("causationid");
  const subject = attribute("subject");
  const traceparent = text(headers["traceparent"]) ?? attribute("traceparent");
  const tracestate = text(headers["tracestate"]) ?? attribute("tracestate");
  return {
    specversion: "1.0",
    id,
    source: attribute("source") ?? "",
    type,
    ...(subject ? { subject } : {}),
    time: attribute("time") ?? new Date().toISOString(),
    correlationid: attribute("correlationid") ?? id,
    ...(causationid ? { causationid } : {}),
    ...(traceparent ? { traceparent } : {}),
    ...(tracestate ? { tracestate } : {}),
    datacontenttype: "application/json",
    data,
  };
}

/** The cause a delivered message continues: its id, its chain and its trace. */
export function causeOf(message: Message): Cause {
  return {
    id: message.id,
    correlationId: message.correlationid,
    ...(message.traceparent ? { traceparent: message.traceparent } : {}),
    ...(message.tracestate ? { tracestate: message.tracestate } : {}),
  };
}

/** A delivered event's envelope, as the queue and the run read it. */
export function envelopeFrom(message: Message): Envelope {
  return {
    ...causeOf(message),
    name: message.type,
    causationId: message.causationid ?? null,
    publishedAt: message.time,
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
  // `name` is the class's (its `eventName`): what the data repeats is not set on the instance.
  const { name: _name, ...fields } = (values ?? {}) as Record<string, unknown>;
  return instanceOf(type, fields);
}

/** A Command's values as what they are here: an instance of its class, or the generated Command. */
export function commandFrom(type: CommandType, data: JsonValue): AnyCommand | RemoteCommand {
  const values = readValues(data);
  if (isCommandDescriptor(type)) return commandOf(type, values as object);
  return instanceOf(type, values);
}
