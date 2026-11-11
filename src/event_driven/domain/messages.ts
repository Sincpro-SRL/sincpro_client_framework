import type { JsonValue } from "@sincpro/client-framework/common/serialization";

/**
 * A Command or an event as it travels — CloudEvents 1.0, as sincpro_framework writes it on every
 * queue (`Envelope`): `type` says what it is — an event's `name`, a Command's identity
 * (`<context>.<Command>`) —, `data` is the DTO as JSON, the chain and the trace ride beside it.
 *
 *     { specversion: "1.0", id: "0193…", source: "urn:svc:billing", type: "billing.invoice.v1.issued",
 *       time: "2026-11-11T03:00:00Z", correlationid: "0192…", causationid: "0191…",
 *       traceparent: "00-…-01", datacontenttype: "application/json", data: { name: …, invoice_id: … } }
 *
 * Context: one shape for both; what differs is the route — an event to every bus that registered
 * its name, a Command to the one bus that registered its identity, and only when declared. A
 * broker's binary mode carries the same attributes as `ce_` headers (`readMessage`).
 */
export type Message = {
  readonly specversion: "1.0";
  readonly id: string;
  readonly source: string;
  readonly type: string;
  readonly subject?: string;
  /** When it was produced, ISO. */
  readonly time: string;
  readonly correlationid: string;
  readonly causationid?: string;
  readonly traceparent?: string;
  readonly tracestate?: string;
  readonly datacontenttype: "application/json";
  readonly data: JsonValue;
};

/** A message in a broker's binary mode: its attributes as headers, its data as the body. */
export type BinaryMessage = {
  readonly headers: Readonly<Record<string, string | Uint8Array | null | undefined>>;
  readonly body: string | JsonValue;
};
