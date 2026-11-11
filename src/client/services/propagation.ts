import type {
  OperationOptions,
  OperationTransport,
  RemoteOperation,
} from "@sincpro/client-framework/client/domain/operation";
import type {
  CallOptions,
  SendOptions,
  Transport,
} from "@sincpro/client-framework/client/domain/transport";
import { plainCodec } from "@sincpro/client-framework/context/adapters/plain-codec";
import { CONTEXT_HEADER, travels } from "@sincpro/client-framework/context/domain/codec";
import { BIND, type Execution } from "@sincpro/client-framework/context/domain/execution";
import { traceparentOf } from "@sincpro/client-framework/observability/services/trace-context";
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
  const traceparent = traceparentOf(span);
  if (traceparent !== undefined) {
    headers["traceparent"] = traceparent;
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
 * The operation transport, calling as `execution`: every call carries the run's trace and
 * context as headers and is cancelled with the run — the caller's own headers and signal still
 * win.
 */
export function bindOperations(
  transport: OperationTransport,
  execution: Execution,
): OperationTransport {
  const own = headersOf(execution);
  const cancels = execution.signal;
  if (Object.keys(own).length === 0 && cancels === undefined) return transport;
  return {
    call: <T>(operation: RemoteOperation, input: unknown, options?: OperationOptions) =>
      transport.call<T>(operation, input, {
        ...options,
        headers: { ...own, ...options?.headers },
        ...((options?.signal ?? cancels) ? { signal: options?.signal ?? cancels } : {}),
      }),
  };
}

/** A transport of either kind, bound to `execution`. */
export function bound<W extends Transport | OperationTransport>(
  wire: W,
  execution: Execution,
): W {
  return (
    isTransport(wire)
      ? bindTransport(wire, execution)
      : bindOperations(wire as OperationTransport, execution)
  ) as W;
}

/**
 * A client made over a transport, made again over the transport bound to each execution it is
 * used in. What a generated `clientOf(operations)` answers, so a Feature that calls
 * `this.client.sendIssue(…)` sends that request with its own trace, context and signal.
 *
 *     export function clientOf(operations: OperationTransport) {
 *       return bindable(operations, (operations) => ({
 *         sendIssue: (input) => operations.call(operations_.CommandSendIssue, input),
 *       }));
 *     }
 *
 * Context: it takes the function that makes the client, not the client — rebuilding through
 * `clientOf` itself would make TypeScript infer `clientOf` from its own return. A REST
 * `Transport` binds the same way, for a client written over it by hand.
 */
export function bindable<W extends Transport | OperationTransport, T extends object>(
  wire: W,
  make: (wire: W) => T,
): T {
  const client = make(wire);
  Object.defineProperty(client, BIND, {
    value: (execution: Execution) => bindable(bound(wire, execution), make),
    enumerable: false,
  });
  return client;
}
