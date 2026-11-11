import type {
  CallOptions,
  SendOptions,
  Transport,
} from "@sincpro/client-framework/client/domain/transport";
import { plainCodec } from "@sincpro/client-framework/context/adapters/plain-codec";
import { CONTEXT_HEADER, travels } from "@sincpro/client-framework/context/domain/codec";
import { BIND, type Execution } from "@sincpro/client-framework/context/domain/execution";
import type { Criteria } from "@sincpro/criteria";

/** Whether a value is a `Transport`: what a run binds to itself even without `BIND`. */
export function isTransport(value: unknown): value is Transport {
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
 * cases running at once, so they travel per call (`CallOptions`). A call that gives no signal of
 * its own is cancelled with the run.
 */
export function bindTransport(transport: Transport, execution: Execution): Transport {
  const own = headersOf(execution);
  const cancels = execution.signal;
  if (Object.keys(own).length === 0 && cancels === undefined) return transport;
  const call = <O extends CallOptions>(options?: O): O =>
    ({ ...options, headers: { ...own, ...options?.headers } }) as O;
  const bound: Transport = {
    list: <T>(
      route: string,
      criteria: Criteria<T>,
      signal?: AbortSignal,
      options?: CallOptions,
    ) => transport.list<T>(route, criteria, signal ?? cancels, call(options)),
    one: <T>(route: string, signal?: AbortSignal, options?: CallOptions) =>
      transport.one<T>(route, signal ?? cancels, call(options)),
    send: <T>(
      method: Parameters<Transport["send"]>[0],
      route: string,
      body: unknown,
      signal?: AbortSignal,
      options?: SendOptions,
    ) => transport.send<T>(method, route, body, signal ?? cancels, call(options)),
  };
  const read = transport.read;
  if (read !== undefined)
    bound.read = <T>(route: string, signal?: AbortSignal, options?: CallOptions) =>
      read.call(transport, route, signal ?? cancels, call(options)) as Promise<T>;
  const download = transport.download;
  if (download !== undefined)
    bound.download = (route: string, signal?: AbortSignal, options?: CallOptions) =>
      download.call(transport, route, signal ?? cancels, call(options));
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
