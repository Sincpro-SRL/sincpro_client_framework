import { queryOf, withQuery } from "@sincpro/client-framework/client/adapters/rest";
import {
  OperationNotPublished,
  type OperationOptions,
  type OperationTransport,
  type RemoteOperation,
} from "@sincpro/client-framework/client/domain/operation";
import {
  downloadRoute,
  type Method,
  readRoute,
  type Transport,
} from "@sincpro/client-framework/client/domain/transport";
import { bindableOperations } from "@sincpro/client-framework/client/services/propagation";

const PATH_KEY = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** The path with each `{field}` taken from the input, and the input's fields it did not take. */
function placed(
  operation: RemoteOperation,
  path: string,
  input: Readonly<Record<string, unknown>>,
): { route: string; rest: Record<string, unknown> } {
  const rest: Record<string, unknown> = { ...input };
  const route = path.replace(PATH_KEY, (_whole, name: string) => {
    const value = input[name];
    if (value === undefined || value === null || value === "")
      throw new TypeError(`${operation.identity} needs "${name}" for ${path}`);
    delete rest[name];
    return encodeURIComponent(String(value));
  });
  return { route, rest };
}

/**
 * Operations over REST, as sincpro_framework's REST gateway publishes them — on a `Transport`
 * (`restTransport`, `memoryTransport`, a platform's):
 *
 *     const operations = restOperations(restTransport({ base: "/v1", headers: session }));
 *     const forge = clientOf(operations);
 *
 * 1. The operation's REST binding (`operation.rest`); none: `OperationNotPublished`.
 * 2. Each `{field}` of its path taken from the input.
 * 3. A `GET` — a Query — sends every other field as its query, as the wire reads it back
 *    (`queryOf`: plain values as text, `criteria` and any other value as JSON), and reads the
 *    answer as it came; one that answers bytes (`streamed`, an export) is downloaded.
 * 4. Anything else — a Command — is sent with the gesture's `Idempotency-Key`: the input whole as
 *    its body; a `DELETE`, read from its URL as a `GET` is, only the fields its path did not take
 *    — the REST transport writes them as its query (`restTransport`), and a key is not said twice.
 * Final: the operation's answer, as the contract describes it — `null` for one that answers
 *    nothing (a `DELETE`'s 204).
 */
export function restOperations(transport: Transport): OperationTransport {
  return bindableOperations({
    call<T>(operation: RemoteOperation, input: unknown, options: OperationOptions = {}) {
      const rest = operation.rest;
      if (rest === undefined)
        return Promise.reject(new OperationNotPublished(operation.identity, "REST"));
      const { signal, ...call } = options;
      const fields = (input ?? {}) as Readonly<Record<string, unknown>>;
      try {
        const { route, rest: others } = placed(operation, rest.path, fields);
        if (rest.method === "GET") {
          const asked = withQuery(route, queryOf(others));
          return operation.streamed
            ? (downloadRoute(transport, asked, signal, call) as Promise<T>)
            : readRoute<T>(transport, asked, signal, call);
        }
        const sent = rest.method === "DELETE" ? others : fields;
        return transport.send<T>(rest.method as Method, route, sent, signal, call);
      } catch (error) {
        return Promise.reject(error);
      }
    },
  });
}
