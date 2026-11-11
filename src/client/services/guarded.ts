import type { CircuitBreaker } from "@sincpro/client-framework/circuit_breaker/entrypoint/circuit-breaker";
import {
  isOperationTransport,
  type OperationOptions,
  type OperationTransport,
  type RemoteOperation,
} from "@sincpro/client-framework/client/domain/operation";
import type {
  CallOptions,
  SendOptions,
  Transport,
} from "@sincpro/client-framework/client/domain/transport";
import type { Criteria } from "@sincpro/criteria";

/**
 * `transport`, every call through `breaker` — an `OperationTransport` of any wire, or REST's
 * `Transport`:
 *
 *     const operations = guardedTransport(jsonRpcOperations({ endpoint }), new CircuitBreaker("forge"));
 *     project.addDependency("client", clientOf(operations));
 *
 * Context: the circuit belongs where the dependency is — the transport —, not in each Feature. A
 * run binds it as it binds any transport, so the trace and the context still travel; an open
 * circuit fails at once with `CircuitOpen` (`unavailable`, with its wait), which the outcome, a
 * stored queue and a screen already read.
 */
export function guardedTransport(
  transport: OperationTransport,
  breaker: CircuitBreaker,
): OperationTransport;
export function guardedTransport(transport: Transport, breaker: CircuitBreaker): Transport;
export function guardedTransport(
  transport: Transport | OperationTransport,
  breaker: CircuitBreaker,
): Transport | OperationTransport {
  if (isOperationTransport(transport))
    return {
      call: <T>(operation: RemoteOperation, input: unknown, options?: OperationOptions) =>
        breaker.call(() => transport.call<T>(operation, input, options)),
    };
  const guarded: Transport = {
    list: <T>(
      route: string,
      criteria: Criteria<T>,
      signal?: AbortSignal,
      options?: CallOptions,
    ) => breaker.call(() => transport.list<T>(route, criteria, signal, options)),
    one: <T>(route: string, signal?: AbortSignal, options?: CallOptions) =>
      breaker.call(() => transport.one<T>(route, signal, options)),
    send: <T>(
      method: Parameters<Transport["send"]>[0],
      route: string,
      body: unknown,
      signal?: AbortSignal,
      options?: SendOptions,
    ) => breaker.call(() => transport.send<T>(method, route, body, signal, options)),
  };
  const read = transport.read;
  if (read !== undefined)
    guarded.read = <T>(route: string, signal?: AbortSignal, options?: CallOptions) =>
      breaker.call(() => read.call(transport, route, signal, options) as Promise<T>);
  const download = transport.download;
  if (download !== undefined)
    guarded.download = (route: string, signal?: AbortSignal, options?: CallOptions) =>
      breaker.call(() => download.call(transport, route, signal, options));
  return guarded;
}
