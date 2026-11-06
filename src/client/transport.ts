import type { Criteria, Dropped, Meta, Page, Problem } from "@sincpro/criteria";

/**
 * The one seam between this package and a server.
 *
 * Context: a list and a record are the same two questions whatever the wire is — «a page of
 * these, under this criteria» and «this one». REST today; JSON-RPC and gRPC are the other
 * wires sincpro_framework serves. Each of those is
 * one adapter implementing this, and nothing above it changes. A route is a string the adapter
 * understands: a path for REST, a method for RPC.
 *
 * Every adapter throws `TransportError` for a refusal, so a screen explains a failure once
 * whichever wire it came over.
 */
export interface Transport {
  /** A page of records under the criteria. */
  list<T>(
    route: string,
    criteria: Criteria<T>,
    signal?: AbortSignal,
    options?: CallOptions,
  ): Promise<Page<T>>;
  /** One record, with the definition of its model. */
  one<T>(route: string, signal?: AbortSignal, options?: CallOptions): Promise<One<T>>;
  /** A Command — a write, an action, a preview: `method` and a JSON body, its answer back. */
  send<T>(
    method: Method,
    route: string,
    body: unknown,
    signal?: AbortSignal,
    options?: SendOptions,
  ): Promise<T>;
  /**
   * A read that is neither a page nor one record — a Query of the context's own, `GET /me` —:
   * the route with its parameters already in it (`listRoute`), its answer as it came. Optional,
   * so a transport written before it keeps compiling; call it through `readRoute`.
   */
  read?<T>(route: string, signal?: AbortSignal, options?: CallOptions): Promise<T>;
}

/**
 * A read through `transport.read`, or the reason it cannot be: a transport that has no `read`
 * is said so by name, never a `TypeError` from somewhere inside a screen.
 */
export function readRoute<T>(
  transport: Transport,
  route: string,
  signal?: AbortSignal,
  options?: CallOptions,
): Promise<T> {
  if (transport.read === undefined)
    return Promise.reject(
      new Error(`this transport has no read(): it cannot ask GET ${route} — give it one`),
    );
  return transport.read<T>(route, signal, options);
}

export type Method = "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * How a Command travels besides its body.
 *
 * Context: sincpro_framework runs a Command declared `@idempotency` once per key (REST: the
 * `Idempotency-Key` header; 400 `IDEMPOTENCY_KEY_MISSING` without it) and answers a repeat with
 * the first answer. That is what makes «retry» safe after a request that got no answer: the
 * server may have created the invoice, and the same key cannot create it twice.
 */
export type SendOptions = CallOptions & {
  /** One per gesture, kept while it is retried — `retryKeys()`. */
  idempotencyKey?: string;
};

/**
 * What one call carries besides its question: headers of that call alone.
 *
 * Context: the trace and the context of the use case that asked travel with each request
 * (`traceparent`, `sincpro-context`) — and two use cases run at once, so they cannot be the
 * transport's own headers. A transport bound to a use case's execution (`bindTransport`) writes
 * them here; a transport that has nowhere to send headers ignores them.
 */
export type CallOptions = {
  headers?: Readonly<Record<string, string>>;
};

/** One record as sincpro_framework answers it (`ResponseRecord`): the record, its model. */
export type One<T> = {
  record: T;
  meta: Meta | null;
  dropped: Dropped[];
  /** What this caller kept of an edit between requests (sincpro_framework `Drafts`). */
  draft: Draft | null;
};

/** A kept edit: the values typed, the version of the draft, the record version it started on. */
/**
 * The caller's draft of a record (sincpro_framework's `DraftState`): the version the next edit
 * names, the stored version it started from, and whether the record moved on since (`stale`).
 * `values` only when a server answers them apart from the record — sincpro_framework answers the
 * record FROM the draft instead.
 */
export type Draft = {
  values?: Record<string, unknown>;
  version: number;
  origin_version?: number;
  kept_at?: string;
  stale?: boolean;
};

/**
 * A refusal, from any wire. `problem` is what the server said about it (RFC 9457 plus the
 * engine's `kind`, `next_step`, `guidance`) or `null` when it said nothing readable — a proxy's
 * HTML page. `status` is `null` when the request never got an answer.
 */
export class TransportError extends Error {
  constructor(
    readonly route: string,
    readonly status: number | null,
    readonly problem: Problem | null,
    message?: string,
  ) {
    super(
      message ?? problem?.detail ?? problem?.title ?? `${status ?? "no answer"} at ${route}`,
    );
    this.name = "TransportError";
  }
}
