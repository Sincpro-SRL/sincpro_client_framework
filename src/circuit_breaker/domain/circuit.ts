import { failureOf } from "@sincpro/client-framework/common/failures";
import type { FailureKind } from "@sincpro/criteria";

/**
 * Where a circuit stands — for a health screen or a test; a call never needs it.
 *
 * - `closed`: calls go through.
 * - `open`: calls fail at once (`CircuitOpen`) until its time passes.
 * - `half_open`: its time passed; one call goes through to try, the others still fail at once.
 */
export type CircuitState = "closed" | "open" | "half_open";

/**
 * The kinds a circuit counts by default — the backend's `COUNTED`: the dependency did not answer,
 * may not have, asked to be left alone, or failed in a way nobody declared. Every other kind is
 * an answer: a refusal is the dependency working.
 */
export const COUNTED_KINDS: ReadonlySet<FailureKind> = new Set<FailureKind>([
  "unavailable",
  "unknown_outcome",
  "exhausted",
  "internal",
]);

/** Whether a failure says the dependency is not answering — not what it answered. */
export function countedByDefault(error: unknown): boolean {
  const failure = failureOf(error);
  return !failure.aborted && COUNTED_KINDS.has(failure.kind);
}

/** The least wait a refused call is told: a clock that rounds to nothing never says «now». */
const LEAST_RETRY_AFTER = 1;

/**
 * The dependency a circuit guards failed too often: the call was not made. It declares itself
 * `unavailable` with its wait, so a retry, a stored queue and a screen already know what to do.
 */
export class CircuitOpen extends Error {
  static readonly failureKind = "unavailable";
  readonly reason = "CIRCUIT_OPEN";
  /** Seconds to wait before trying again — one at least. */
  readonly retryAfter: number;

  constructor(
    readonly circuit: string,
    retryAfterSeconds: number,
  ) {
    const retryAfter = Math.max(LEAST_RETRY_AFTER, Math.ceil(retryAfterSeconds));
    super(`circuit ${circuit} is open — the call was not made; try again in ${retryAfter}s`);
    this.name = "CircuitOpen";
    this.retryAfter = retryAfter;
  }
}
