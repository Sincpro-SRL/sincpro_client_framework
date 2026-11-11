import type { SendOptions } from "@sincpro/client-framework/client/domain/transport";

/**
 * One operation of a remote service, as its client contract names it: who it is, what it does
 * for its entities, and how each wire reaches it. What a generated client's `operations` holds,
 * one entry per Command or Query the backend publishes.
 *
 *     {
 *       identity: "sincpro-forge-project.CommandSendIssue",
 *       role: "command", query: false, entities: ["Issue"], targets: { Issue: "issue_id" },
 *       rest: { method: "POST", path: "/issues/{issue_id}/messages" },
 *       rpc: { method: "project.send_issue" },
 *     }
 */
export type RemoteOperation = {
  /** `<bounded context>.<Command>`: the same on every wire. */
  readonly identity: string;
  /** What it is for its entity: `search`, `get`, `edit`, `export`, `command`… */
  readonly role: string;
  /** It writes nothing: retrying or caching it is safe. */
  readonly query: boolean;
  readonly entities: readonly string[];
  readonly targets: Readonly<Record<string, string>>;
  /** It answers bytes as they are produced (an export), not JSON. */
  readonly streamed?: boolean;
  readonly rest?: { readonly method: string; readonly path: string };
  readonly rpc?: { readonly method: string };
  readonly grpc?: { readonly method: string };
  readonly mcp?: { readonly tool: string };
};

/**
 * What one call carries besides its input: its headers (the run's trace and context), what
 * cancels it, and — for a write — the gesture's idempotency key.
 */
export type OperationOptions = SendOptions & { signal?: AbortSignal };

/**
 * Calls an operation of a remote service by who it is — the port every wire implements, and
 * what a generated client is made over:
 *
 *     clientOf(restOperations(restTransport({ base: "/v1" })));    // REST
 *     clientOf(jsonRpcOperations({ endpoint: "/rpc" }));          // JSON-RPC
 *     clientOf(grpcOperations(channel));                          // gRPC — a platform's adapter
 *
 * Context: the contract publishes each operation once, with how every wire reaches it; the
 * generated client names only the operation and its input, never a route, a verb or a method.
 * Which wire it travels on is the adapter an application injects — the backend's, another
 * backend's, a platform's —, so the same client and the same Features run over any of them. An
 * adapter answers the operation's answer as the contract describes it, and fails with errors
 * `failureOf` reads (a `Problem`, or a declared `failureKind`).
 */
export interface OperationTransport {
  call<T>(operation: RemoteOperation, input: unknown, options?: OperationOptions): Promise<T>;
}

/** An operation the wire an adapter speaks does not publish: a client asked for what is not there. */
export class OperationNotPublished extends Error {
  static readonly failureKind = "not_found";
  readonly reason = "OPERATION_NOT_PUBLISHED";

  constructor(
    readonly operation: string,
    readonly wire: string,
  ) {
    super(`${operation} is not published over ${wire}: its contract has no ${wire} binding`);
    this.name = "OperationNotPublished";
  }
}

/** Whether a value is an `OperationTransport`: what a run binds to itself even without `BIND`. */
export function isOperationTransport(value: unknown): value is OperationTransport {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as Partial<OperationTransport>).call === "function"
  );
}
