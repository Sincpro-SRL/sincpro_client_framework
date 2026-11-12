import {
  OperationNotPublished,
  type OperationOptions,
  type OperationTransport,
  type RemoteOperation,
} from "@sincpro/client-framework/client/domain/operation";
import { bindableOperations } from "@sincpro/client-framework/client/services/propagation";
import { kindOfJsonRpcCode } from "@sincpro/client-framework/common/failures";
import { type FailureKind, type Problem, readProblem } from "@sincpro/criteria";

export type JsonRpcOptions = {
  /** Where the gateway answers: `"/rpc"`, `"https://forge.sincpro.com.bo/rpc"`. */
  endpoint: string;
  /** Sent with every request. A function is called fresh each time — a token that rotates. */
  headers?: Record<string, string> | (() => Record<string, string>);
  /** Defaults to the global `fetch`. Inject one for tests, or a platform's. */
  fetch?: typeof fetch;
};

/**
 * A JSON-RPC call that failed: the error the gateway answered — its `code` and, when it sent
 * one, its `Problem` — or a request nobody answered (`code: null`). `failureOf` reads its
 * `Problem`; without one, the kind its code stands for (`kindOfJsonRpcCode`).
 */
export class JsonRpcError extends Error {
  /** Declared only when the gateway sent no `Problem` — the `Problem` says more when it did. */
  readonly failureKind: FailureKind | undefined;

  constructor(
    readonly method: string,
    readonly code: number | null,
    readonly problem: Problem | null,
    message?: string,
  ) {
    super(
      message ??
        problem?.detail ??
        problem?.title ??
        `${method} failed (${code ?? "no answer"})`,
    );
    this.name = "JsonRpcError";
    this.failureKind =
      problem !== null
        ? undefined
        : code === null
          ? "unknown_outcome"
          : kindOfJsonRpcCode(code);
  }
}

let next = 0;

/**
 * Operations over JSON-RPC 2.0, as sincpro_framework's RPC gateway publishes them: one `POST` to
 * its endpoint, the operation's method (`operation.rpc.method`) with its input as named params.
 *
 *     const operations = jsonRpcOperations({ endpoint: "/rpc", headers: () => session() });
 *     const forge = clientOf(operations);
 *
 * 1. The operation's JSON-RPC binding; none: `OperationNotPublished`.
 * 2. The request — `{jsonrpc: "2.0", id, method, params}` — with the call's headers (the run's
 *    trace and context) and the gesture's `Idempotency-Key`, cancelled with its signal.
 * 3. An answer with `error`: a `JsonRpcError` with its code and the `Problem` its `data` carries
 *    (its `message` the detail when the problem has none).
 * 4. No answer (the network, an `AbortError` aside): a `JsonRpcError` nobody answered — it may
 *    have run.
 * Final: the `result`, the operation's answer as the contract describes it.
 */
export function jsonRpcOperations(options: JsonRpcOptions): OperationTransport {
  const send = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const own = () =>
    typeof options.headers === "function" ? options.headers() : options.headers;
  return bindableOperations({
    async call<T>(operation: RemoteOperation, input: unknown, call: OperationOptions = {}) {
      const method = operation.rpc?.method;
      if (method === undefined)
        throw new OperationNotPublished(operation.identity, "JSON-RPC");
      const id = ++next;
      let response: Response;
      try {
        response = await send(options.endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            ...own(),
            ...call.headers,
            ...(call.idempotencyKey ? { "Idempotency-Key": call.idempotencyKey } : {}),
          },
          body: JSON.stringify({ jsonrpc: "2.0", id, method, params: input ?? {} }),
          ...(call.signal ? { signal: call.signal } : {}),
        });
      } catch (error) {
        if ((error as { name?: unknown })?.name === "AbortError") throw error;
        throw new JsonRpcError(method, null, null, `${method} got no answer`);
      }
      const text = await response.text();
      let answer: { result?: unknown; error?: unknown };
      try {
        answer = JSON.parse(text) as typeof answer;
      } catch {
        throw new JsonRpcError(
          method,
          null,
          readProblem(text),
          `${method} answered no JSON-RPC`,
        );
      }
      if (answer.error !== undefined) {
        const { code, message, data } = answer.error as {
          code?: unknown;
          message?: unknown;
          data?: unknown;
        };
        const said = typeof message === "string" ? message : undefined;
        const problem = readProblem(data);
        throw new JsonRpcError(
          method,
          typeof code === "number" ? code : null,
          problem && problem.detail === undefined && said
            ? { ...problem, detail: said }
            : problem,
          said,
        );
      }
      return answer.result as T;
    },
  });
}
