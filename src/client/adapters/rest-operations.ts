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

const PATH_KEY = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** What a value is in a query string: text as it is, anything else as JSON (`criteria`). */
function queryValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

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

/** The route with every other field of a GET as its query. */
function withQuery(route: string, fields: Readonly<Record<string, unknown>>): string {
  const query = new URLSearchParams(
    Object.entries(fields)
      .filter(([, value]) => value !== undefined && value !== null && value !== "")
      .map(([name, value]) => [name, queryValue(value)]),
  ).toString();
  return query === "" ? route : `${route}${route.includes("?") ? "&" : "?"}${query}`;
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
 * 3. A `GET` — a Query — sends every other field as its query (text as it is, `criteria` and any
 *    other value as JSON) and reads the answer as it came; one that answers bytes (`streamed`,
 *    an export) is downloaded.
 * 4. Anything else — a Command — sends the input as its body, with the gesture's
 *    `Idempotency-Key`.
 * Final: the operation's answer, as the contract describes it.
 */
export function restOperations(transport: Transport): OperationTransport {
  return {
    call<T>(operation: RemoteOperation, input: unknown, options: OperationOptions = {}) {
      const rest = operation.rest;
      if (rest === undefined)
        return Promise.reject(new OperationNotPublished(operation.identity, "REST"));
      const { signal, ...call } = options;
      const fields = (input ?? {}) as Readonly<Record<string, unknown>>;
      try {
        const { route, rest: others } = placed(operation, rest.path, fields);
        if (rest.method === "GET") {
          const asked = withQuery(route, others);
          return operation.streamed
            ? (downloadRoute(transport, asked, signal, call) as Promise<T>)
            : readRoute<T>(transport, asked, signal, call);
        }
        return transport.send<T>(rest.method as Method, route, fields, signal, call);
      } catch (error) {
        return Promise.reject(error);
      }
    },
  };
}
