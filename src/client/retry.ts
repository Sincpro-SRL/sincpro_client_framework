import { TransportError } from "@sincpro/client-framework/client/transport";

/**
 * The `Idempotency-Key` of a gesture: one per thing a person meant to do, the SAME one while
 * that thing is retried.
 *
 * Context: a Command that got no answer — the network dropped, a proxy answered 502 — may have
 * run. Sending it again with a new key could pay twice; with the same key the server answers
 * what it already did (sincpro_framework's `@idempotency`). So a key lives until the server
 * gives a definite answer: done, or refused for a reason a retry does not change. Changing the
 * body is a different gesture, and gets a new key — the server refuses a key that comes back
 * with another payload.
 *
 *     const keys = retryKeys();
 *     const key = keys.keyFor(body);          // the same while the previous one went unanswered
 *     try { await send(…, { idempotencyKey: key }); keys.settle(null); }
 *     catch (error) { keys.settle(error); }   // kept when nobody knows what happened
 */
export type RetryKeys = {
  keyFor: (body: unknown) => string;
  /** What the last attempt ended in: `null` when it was answered. */
  settle: (error: unknown) => void;
};

/** Whether a failure leaves it unknown if the Command ran — so a retry must reuse its key. */
export function unanswered(error: unknown): boolean {
  if (!(error instanceof TransportError)) return true;
  if (error.status === null || error.status >= 500) return true;
  // The same key is still running elsewhere: retry once it completes, with that key.
  return error.problem?.kind === "in_progress";
}

export function retryKeys(
  make: () => string = () => globalThis.crypto.randomUUID(),
): RetryKeys {
  let pending: { body: string; key: string } | null = null;
  return {
    keyFor: (body) => {
      const sent = JSON.stringify(body ?? null);
      if (pending === null || pending.body !== sent) pending = { body: sent, key: make() };
      return pending.key;
    },
    settle: (error) => {
      if (error === null || !unanswered(error)) pending = null;
    },
  };
}
