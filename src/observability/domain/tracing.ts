/**
 * What a platform plugs for execution traces: one span per use case.
 *
 * Context: sincpro_framework opens one span per use case; a client has to do the same, and
 * continue the backend's trace. The vendor — OpenTelemetry in a browser, a queue on a phone,
 * memory in a test — is the platform's, so this package defines the contract and calls it, and
 * bundles none. Two implementations at least (a platform's and a test's) are why it is a port.
 *
 * Nothing here may break a use case: a tracer that fails is ignored, and the use case answers as
 * it would have.
 */

/** What is said about a span: plain values only, the way OpenTelemetry takes them. */
export type Attributes = Readonly<Record<string, string | number | boolean>>;

/**
 * How a use case ended.
 *
 * - `ok`: it answered.
 * - `refused`: expected — the server said no and explained why (a validation, a conflict, a
 *   permission), or the bounded context declared the error expected (`expectErrors`). Never
 *   reported.
 * - `aborted`: whoever asked stopped waiting (a screen that closed). Never reported.
 * - `failed`: anything else — a bug, a server that broke, a server nobody could reach. Reported.
 */
export type Outcome = "ok" | "refused" | "aborted" | "failed";

/** One span: a use case, open while it runs. */
export interface Span {
  /** 32 hex — the id the server continues and a person quotes as a support code. Empty when
   *  nothing traces. */
  readonly traceId: string;
  /** 16 hex. Empty when nothing traces. */
  readonly spanId: string;
  /** Whether this trace is kept: the server follows the same decision. */
  readonly sampled: boolean;
  /** Vendor state that travels beside the trace (`tracestate`), when there is any. */
  readonly state?: string;
  /** Says more about the use case while it runs. */
  set(attributes: Attributes): void;
  /** Closes it, once. `error` is what it failed or was refused with. */
  end(outcome: Outcome, error?: unknown): void;
}

/** Opens spans. One per platform; `NO_TRACER` when nothing traces. */
export interface Tracer {
  start(name: string, options: { parent?: Span; attributes?: Attributes }): Span;
}

const EMPTY_SPAN: Span = {
  traceId: "",
  spanId: "",
  sampled: false,
  set: () => undefined,
  end: () => undefined,
};

/** Traces nothing: what a use case runs with until a platform plugs a tracer. */
export const NO_TRACER: Tracer = { start: () => EMPTY_SPAN };
