import { failureOf } from "@sincpro/client-framework/common/failures";
import type { StoredMessage } from "@sincpro/client-framework/event_driven/domain/store";
import type { FailureKind } from "@sincpro/criteria";

/**
 * How one message is delivered — what its class declares, what the application sets for it by
 * name, over the queue's:
 *
 *     { retries: 0, maxAttempts: Infinity, requiresNetwork: false }   // the defaults
 */
export type DeliveryPolicy = {
  /**
   * How many times it is sent again after a failure (0): sent once, and a failure is set aside —
   * the dead-letter queue — for a person to retry.
   */
  readonly retries?: number;
  /**
   * Every send, waits included, before it is set aside although it could still wait (Infinity):
   * what bounds a message waiting for a server that never comes back.
   */
  readonly maxAttempts?: number;
  /**
   * Its work goes over the network: a failure that says the other side is not there now
   * (`WAITING_KINDS`) waits instead of failing, as long as it takes; a platform's `ready` holds it
   * while there is no connection.
   */
  readonly requiresNetwork?: boolean;
};

/** A policy with every rule said. */
export type FullDeliveryPolicy = Required<DeliveryPolicy>;

/** The queue's policy when nothing says otherwise. */
export const DEFAULT_DELIVERY_POLICY: FullDeliveryPolicy = {
  retries: 0,
  maxAttempts: Number.POSITIVE_INFINITY,
  requiresNetwork: false,
};

/**
 * The kinds that mean the other side is not there now — down, an open circuit, out of quota, or
 * the call went out and no answer came back —: a message whose work goes over the network waits
 * them out instead of failing. Sending it again is safe because it carries its key (its id),
 * which the backend runs once (`Idempotency-Key`); a server without keys is verified by the use
 * case before it writes again.
 */
export const WAITING_KINDS: ReadonlySet<FailureKind> = new Set<FailureKind>([
  "unavailable",
  "exhausted",
  "in_progress",
  "unknown_outcome",
]);

/** One delivery, as the verdict reads it. */
export type Delivery = {
  readonly stored: StoredMessage;
  /** Sends so far, this one included. */
  readonly attempts: number;
  /** What each consumer that failed this time raised. */
  readonly errors: readonly unknown[];
  readonly policy: FullDeliveryPolicy;
  /** The wait before the next send, in ms, as the queue's backoff counts it. */
  readonly backoff: number;
};

/**
 * - `delivered`: every consumer has it.
 * - `wait`: not a failure to judge — it waits, `after` ms or, without it, for `ready`.
 * - `retry`: it failed, and is sent again `after` ms.
 * - `set_aside`: it failed, and waits for a person.
 */
export type Verdict =
  | { readonly settlement: "delivered" }
  | { readonly settlement: "wait"; readonly after?: number }
  | { readonly settlement: "retry"; readonly after: number }
  | { readonly settlement: "set_aside" };

/**
 * The verdict on one delivery — the queue column of sincpro_framework's failure table
 * (`entrypoints/adapters/queue/verdicts.py`), for a client:
 *
 * 1. Nothing failed: delivered.
 * 2. It used its `maxAttempts`: set aside.
 * 3. A failure every attempt would repeat (`PERMANENT_KINDS`): set aside.
 * 4. Its work goes over the network and the other side is not there now (`WAITING_KINDS`): it
 *    waits — what the failure asks for (`retryAfter`, an open circuit's time left) or the backoff.
 * 5. Any other failure — a bug, a device that did not answer, a conflict —: sent again while it
 *    has `retries`, after the backoff; else set aside.
 * Final: several consumers failed — the one that asks the most: wait, then retry, then set aside.
 *
 * Context: pure, and the queue's default — a platform extends it by wrapping it
 * (`storedQueue({ verdict: (delivery) => mine(delivery) ?? verdictOf(delivery) })`), never by
 * changing the queue.
 */
export function verdictOf(delivery: Delivery): Verdict {
  const { errors, attempts, policy, backoff } = delivery;
  if (errors.length === 0) return { settlement: "delivered" };
  if (attempts >= policy.maxAttempts) return { settlement: "set_aside" };
  const verdicts = errors.map((error): Verdict => {
    const failure = failureOf(error);
    if (failure.permanent) return { settlement: "set_aside" };
    const asked = (failure.retryAfter ?? 0) * 1000;
    if (policy.requiresNetwork && WAITING_KINDS.has(failure.kind)) {
      return { settlement: "wait", after: Math.max(backoff, asked) };
    }
    if (attempts <= policy.retries) {
      return { settlement: "retry", after: Math.max(backoff, asked) };
    }
    return { settlement: "set_aside" };
  });
  return combined(verdicts);
}

const WORST_FIRST: readonly Verdict["settlement"][] = [
  "wait",
  "retry",
  "set_aside",
  "delivered",
];

/** The one verdict of several consumers: the one that asks the most, its longest wait. */
export function combined(verdicts: readonly Verdict[]): Verdict {
  for (const settlement of WORST_FIRST) {
    const same = verdicts.filter((one) => one.settlement === settlement);
    if (same.length === 0) continue;
    const afters = same.flatMap((one) =>
      "after" in one && one.after !== undefined ? [one.after] : [],
    );
    const after = afters.length > 0 ? Math.max(...afters) : undefined;
    if (settlement === "wait")
      return after === undefined ? { settlement } : { settlement, after };
    if (settlement === "retry") return { settlement, after: after ?? 0 };
    return { settlement };
  }
  return { settlement: "delivered" };
}
