import type {
  CallOptions,
  SendOptions,
  Transport,
} from "@sincpro/client-framework/client/transport";
import { CONTEXT_HEADER, plainCodec, travels } from "@sincpro/client-framework/context/codec";
import type { Span } from "@sincpro/client-framework/observability/ports";
import type { Criteria } from "@sincpro/criteria";

/**
 * One run of a use case: its span, what it runs with, and who ran it.
 *
 * Context: sincpro_framework keeps the running use case in a context variable; a browser has
 * nothing like it that survives an `await` (AsyncContext is a proposal, Zone.js patches the
 * world), and a global stack mixes the parents of two use cases running at once — which a
 * screen with several windows does all the time. So an execution is a value, handed to what
 * the use case calls: its Features (`this.feature`) and its dependencies (`BIND`).
 */
export type Execution = {
  /** UUID v7, as 32 hex: this run. */
  readonly id: string;
  /** `<bounded context>.<Service>[.<method>]` — the use case's identity, as the backend names its own. */
  readonly useCase: string;
  /** The bounded context the use case belongs to. */
  readonly boundedContext: string;
  /** The run that executed this one: an ApplicationService, for its Features. */
  readonly parent: Execution | undefined;
  readonly span: Span;
  /** What it runs with, read once where the gesture started and inherited by every child. */
  readonly context: Readonly<Record<string, unknown>>;
};

/**
 * A dependency that has something to say about the execution it is used in: given that
 * execution, it answers itself bound to it. The transport and every generated client are;
 * any other dependency of a bounded context is handed as it is.
 */
export const BIND: unique symbol = Symbol.for("sincpro.client-framework.bind");

export type Bindable<T> = { [BIND]: (execution: Execution) => T };

function isBindable<T>(value: T): value is T & Bindable<T> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as Partial<Bindable<T>>)[BIND] === "function"
  );
}

function isTransport(value: unknown): value is Transport {
  if (value === null || typeof value !== "object") return false;
  const one = value as Partial<Transport>;
  return (
    typeof one.list === "function" &&
    typeof one.one === "function" &&
    typeof one.send === "function"
  );
}

/**
 * What every request of an execution carries: its trace (`traceparent`, W3C) and its context
 * (`sincpro-context`, the header sincpro_framework's entrances read, written with `plainCodec`).
 * Nothing when there is no trace and no context that travels.
 */
export function headersOf(execution: Execution): Record<string, string> {
  const headers: Record<string, string> = {};
  const { span, context } = execution;
  if (span.traceId !== "" && span.spanId !== "") {
    headers["traceparent"] =
      `00-${span.traceId}-${span.spanId}-${span.sampled ? "01" : "00"}`;
    if (span.state) headers["tracestate"] = span.state;
  }
  // Only what travels: an object or a function held in the context stays in this process.
  if (Object.values(context).some(travels))
    headers[CONTEXT_HEADER] = plainCodec.dumps(context);
  return headers;
}

/**
 * The transport, writing the execution's headers on every call — the caller's own headers of a
 * call still win.
 *
 * Context: the transport's own headers (`restTransport({ headers })`) are the session's — the
 * token, the tenant — the same for every call; these are the use case's, different for two use
 * cases running at once, so they travel per call (`CallOptions`).
 */
export function bindTransport(transport: Transport, execution: Execution): Transport {
  const own = headersOf(execution);
  if (Object.keys(own).length === 0) return transport;
  const call = <O extends CallOptions>(options?: O): O =>
    ({ ...options, headers: { ...own, ...options?.headers } }) as O;
  const bound: Transport = {
    list: <T>(
      route: string,
      criteria: Criteria<T>,
      signal?: AbortSignal,
      options?: CallOptions,
    ) => transport.list<T>(route, criteria, signal, call(options)),
    one: <T>(route: string, signal?: AbortSignal, options?: CallOptions) =>
      transport.one<T>(route, signal, call(options)),
    send: <T>(
      method: Parameters<Transport["send"]>[0],
      route: string,
      body: unknown,
      signal?: AbortSignal,
      options?: SendOptions,
    ) => transport.send<T>(method, route, body, signal, call(options)),
  };
  const read = transport.read;
  if (read !== undefined)
    bound.read = <T>(route: string, signal?: AbortSignal, options?: CallOptions) =>
      read.call(transport, route, signal, call(options)) as Promise<T>;
  return bound;
}

/**
 * A client made over a transport, made again over the transport bound to each execution it is
 * used in. What a generated `clientOf(transport)` answers, so a Feature that calls
 * `this.client.sendIssue(…)` sends that request with its own trace.
 *
 *     export function clientOf(transport: Transport) {
 *       return bindable(transport, (transport) => ({ sendIssue: (body) => transport.send(…) }));
 *     }
 *
 * Context: it takes the function that makes the client, not the client — rebuilding through
 * `clientOf` itself would make TypeScript infer `clientOf` from its own return.
 */
export function bindable<T extends object>(
  transport: Transport,
  make: (transport: Transport) => T,
): T {
  const client = make(transport);
  Object.defineProperty(client, BIND, {
    value: (execution: Execution) => bindable(bindTransport(transport, execution), make),
    enumerable: false,
  });
  return client;
}

/** A dependency as the execution should see it: bound when it can be, as it is otherwise. */
export function bindDependency<T>(value: T, execution: Execution): T {
  if (isBindable(value)) return value[BIND](execution);
  if (isTransport(value)) return bindTransport(value, execution) as T;
  return value;
}
