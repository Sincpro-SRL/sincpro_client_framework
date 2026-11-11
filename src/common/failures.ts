import type { FailureKind, NextStep, Problem } from "@sincpro/criteria";

/**
 * What kind of failure an error is, whatever raised it — the backend's `common/failures`, read
 * on a client: a refusal the server explained, a request nobody answered, a run a screen
 * cancelled, a local domain's own refusal, another backend's error a platform translated.
 *
 *     failureOf(new TransportError("/pay", 409, problem))   ->  { kind: "conflict", nextStep: "refresh_and_retry", … }
 *     failureOf(new TransportError("/pay", null, null))      ->  { kind: "unknown_outcome", fault: true, … }
 *     failureOf(new CreditExhausted())                       ->  what the class declares (`failureKind`)
 *     failureOf(new TypeError("x"))                          ->  { kind: "internal", fault: true, … }
 *
 * Context: every client decides the same things about a failure — show it or report it, retry it
 * or set it aside, ask to sign in again —, and each app was deciding them its own way. The words
 * are the wire's (`FailureKind`, `NextStep`, `Problem` from @sincpro/criteria), the rules the
 * backend's: a retryable kind is retried after `retryAfter`; a permanent one fails the same way on
 * every attempt and is set aside; a fault is the system's problem and is reported. An error says
 * its own kind (`failureKind`, as the backend's errors do), so nothing here knows who raised it:
 * a platform's adapter translates its backend's errors into errors that declare one.
 */
export type Failure = {
  readonly kind: FailureKind;
  /** UPPER_SNAKE and stable: what a client switches on. */
  readonly reason: string;
  /** What the caller does next. */
  readonly nextStep: NextStep;
  /** Whether sending the same thing again — as it is, or after a fresh read — may succeed. */
  readonly retryable: boolean;
  /** Seconds to wait before retrying; none when retrying does not help. */
  readonly retryAfter: number | undefined;
  /** It fails the same way on every attempt: a queue sets it aside, never retries it. */
  readonly permanent: boolean;
  /** The system's problem — a bug, a server down, no answer —, not an answer to the caller. */
  readonly fault: boolean;
  /** Whoever asked stopped waiting: not a failure of anyone. */
  readonly aborted: boolean;
  /** What the server said, when it said it. */
  readonly problem: Problem | undefined;
};

/**
 * What an error can say about itself — on the instance or as a static of its class:
 *
 *     class CreditExhausted extends Error {
 *       static readonly failureKind = "exhausted";
 *       readonly retryAfter = 30;
 *     }
 */
export type DeclaredFailure = {
  readonly failureKind?: FailureKind;
  readonly reason?: string;
  readonly retryAfter?: number;
};

/** The kinds that fail the same way on every attempt — set aside at the first failure. */
export const PERMANENT_KINDS: ReadonlySet<FailureKind> = new Set<FailureKind>([
  "invalid",
  "unauthenticated",
  "permission_denied",
  "not_found",
  "key_reused",
  "domain",
]);

/** What the caller does next, by kind — the backend's `NEXT_STEP_OF`. */
const NEXT_STEP_OF: Readonly<Record<FailureKind, NextStep>> = {
  invalid: "fix_request",
  unauthenticated: "authenticate",
  permission_denied: "ask_for_access",
  not_found: "do_not_retry",
  conflict: "refresh_and_retry",
  in_progress: "retry_later",
  key_reused: "fix_request",
  domain: "do_not_retry",
  exhausted: "retry_later",
  unavailable: "retry_later",
  unknown_outcome: "verify_then_retry",
  internal: "retry_later",
};

/** The kinds that are the system's problem: reported, never shown as the caller's answer. */
const FAULTS: ReadonlySet<FailureKind> = new Set<FailureKind>([
  "internal",
  "unavailable",
  "unknown_outcome",
]);

const RETRYABLE_STEPS: ReadonlySet<NextStep> = new Set<NextStep>([
  "retry_later",
  "refresh_and_retry",
]);

/** A retryable kind that says nothing waits a second, as the backend's `DEFAULT_RETRY_AFTER`. */
const DEFAULT_RETRY_AFTER = 1;

const KINDS: ReadonlySet<string> = new Set(Object.keys(NEXT_STEP_OF));

function isKind(value: unknown): value is FailureKind {
  return typeof value === "string" && KINDS.has(value);
}

/**
 * The kind each wire's own code stands for, when an answer carries no `Problem` — the backend's
 * tables, read back, so a transport of any wire (REST, JSON-RPC, gRPC, another backend's) builds
 * errors that declare the same kinds:
 *
 *     class RpcError extends Error {
 *       constructor(readonly code: number, message: string) { super(message); }
 *       get failureKind() { return kindOfJsonRpcCode(this.code); }
 *     }
 */
export function kindOfHttpStatus(status: number): FailureKind {
  if (status === 401) return "unauthenticated";
  if (status === 403) return "permission_denied";
  if (status === 404 || status === 410) return "not_found";
  if (status === 409 || status === 412) return "conflict";
  if (status === 429) return "exhausted";
  if (status === 502 || status === 503) return "unavailable";
  if (status === 504) return "unknown_outcome";
  if (status >= 500) return "internal";
  return "invalid";
}

/** The kind a gRPC status code stands for — the backend's gRPC table, read back. */
export function kindOfGrpcCode(code: number): FailureKind {
  switch (code) {
    case 3: // INVALID_ARGUMENT
    case 11: // OUT_OF_RANGE
      return "invalid";
    case 16: // UNAUTHENTICATED
      return "unauthenticated";
    case 7: // PERMISSION_DENIED
      return "permission_denied";
    case 5: // NOT_FOUND
    case 12: // UNIMPLEMENTED
      return "not_found";
    case 6: // ALREADY_EXISTS
    case 10: // ABORTED — also an idempotent run in flight
      return "conflict";
    case 9: // FAILED_PRECONDITION — also a reused idempotency key
      return "domain";
    case 8: // RESOURCE_EXHAUSTED
      return "exhausted";
    case 14: // UNAVAILABLE
      return "unavailable";
    case 1: // CANCELLED
    case 4: // DEADLINE_EXCEEDED
      return "unknown_outcome";
    default: // UNKNOWN, INTERNAL, DATA_LOSS
      return "internal";
  }
}

/** The kind a JSON-RPC error code stands for — the backend's catalogue, read back. */
export function kindOfJsonRpcCode(code: number): FailureKind {
  switch (code) {
    case -32700:
    case -32600:
    case -32602:
      return "invalid";
    case -32601:
    case -32004:
      return "not_found";
    case -32000:
      return "unavailable";
    case -32001:
      return "unauthenticated";
    case -32003:
      return "permission_denied";
    case -32009:
      return "conflict";
    case -32010:
      return "domain";
    case -32022:
      return "key_reused";
    case -32024:
      return "unknown_outcome";
    case -32029: // an idempotent run in flight, or a limit spent — the problem says which
      return "exhausted";
    default:
      return "internal";
  }
}

function upperSnake(kind: string): string {
  return kind.toUpperCase();
}

/** What the error declares: on itself first, then on its class. */
function declared(error: object): DeclaredFailure {
  const own = error as DeclaredFailure;
  const type = (error.constructor ?? {}) as DeclaredFailure;
  return {
    ...(isKind(own.failureKind ?? type.failureKind)
      ? { failureKind: own.failureKind ?? type.failureKind }
      : {}),
    ...(typeof (own.reason ?? type.reason) === "string"
      ? { reason: own.reason ?? type.reason }
      : {}),
    ...(typeof (own.retryAfter ?? type.retryAfter) === "number"
      ? { retryAfter: own.retryAfter ?? type.retryAfter }
      : {}),
  };
}

function isProblem(value: unknown): value is Problem {
  return (
    value !== null &&
    typeof value === "object" &&
    isKind((value as Partial<Problem>).kind) &&
    typeof (value as Partial<Problem>).next_step === "string"
  );
}

function failure(
  kind: FailureKind,
  said: { reason?: string; nextStep?: NextStep; retryAfter?: number; problem?: Problem },
  aborted = false,
): Failure {
  const nextStep = said.nextStep ?? NEXT_STEP_OF[kind];
  const retryable = RETRYABLE_STEPS.has(nextStep);
  return {
    kind,
    reason: said.reason ?? upperSnake(kind),
    nextStep,
    retryable,
    retryAfter: retryable ? (said.retryAfter ?? DEFAULT_RETRY_AFTER) : undefined,
    permanent: !aborted && PERMANENT_KINDS.has(kind),
    fault: !aborted && FAULTS.has(kind),
    aborted,
    problem: said.problem,
  };
}

/**
 * The failure `error` is.
 *
 * 1. Whoever asked stopped waiting (`AbortError`): aborted — a write may have run, so its kind is
 *    `unknown_outcome`, but it is nobody's failure.
 * 2. What the error declares (`failureKind`, `reason`, `retryAfter`), on itself or its class.
 * 3. What the server said (`problem`, a `Problem` — the same over REST, JSON-RPC and gRPC): its
 *    kind, reason, next step and wait.
 * 4. A REST answer (`TransportError`) with a status and no problem: the kind its HTTP status
 *    stands for. Another wire's transport declares its kind instead (`kindOfGrpcCode`,
 *    `kindOfJsonRpcCode`).
 * 5. A request that got no answer (`status: null`): `unknown_outcome` — it may have run.
 * Final: anything else is `internal`, a fault.
 */
export function failureOf(error: unknown): Failure {
  if (error === null || typeof error !== "object") return failure("internal", {});
  const named = (error as { name?: unknown }).name;
  if (named === "AbortError") return failure("unknown_outcome", {}, true);
  const own = declared(error);
  if (own.failureKind !== undefined)
    return failure(own.failureKind, {
      ...(own.reason !== undefined ? { reason: own.reason } : {}),
      ...(own.retryAfter !== undefined ? { retryAfter: own.retryAfter } : {}),
    });
  const answered = error as { problem?: unknown; status?: unknown };
  if (isProblem(answered.problem)) {
    const problem = answered.problem;
    return failure(problem.kind, {
      reason: problem.reason,
      nextStep: problem.next_step,
      ...(problem.retry_after !== undefined ? { retryAfter: problem.retry_after } : {}),
      problem,
    });
  }
  if ("problem" in answered && "status" in answered) {
    if (typeof answered.status === "number")
      return failure(kindOfHttpStatus(answered.status), {});
    if (answered.status === null) return failure("unknown_outcome", {});
  }
  return failure("internal", {});
}
