import { TransportError } from "@sincpro/client-framework/client/domain/transport";
import type { Outcome } from "@sincpro/client-framework/observability/domain/tracing";

/**
 * How an error ended a use case, by default.
 *
 * Context: the backend reports what nobody expected and only that — a refusal it explained is
 * the business answering, not a fault. Here the same: a `TransportError` the server answered
 * with a 4xx is `refused`; a request the caller stopped waiting for is `aborted`; everything
 * else — a bug, a 5xx, a server nobody could reach — is `failed`, and reported. A bounded
 * context adds its own expected errors (`expectErrors`); a process replaces this whole
 * (`configureProcess({ outcomeOf })`).
 */
export function outcomeOf(error: unknown): Outcome {
  if (error instanceof TransportError && error.status !== null)
    return error.status >= 400 && error.status < 500 ? "refused" : "failed";
  if (
    error !== null &&
    typeof error === "object" &&
    (error as { name?: unknown }).name === "AbortError"
  )
    return "aborted";
  return "failed";
}
