import { failureOf } from "@sincpro/client-framework/common/failures";
import type { Outcome } from "@sincpro/client-framework/observability/domain/tracing";

/**
 * How an error ended a use case, by default — read off the failure it is (`failureOf`).
 *
 * Context: the backend reports what nobody expected and only that — a refusal it explained is
 * the business answering, not a fault. Here the same: a failure that is the caller's answer (a
 * 4xx, an error that declares a kind such as `domain` or `not_found`) is `refused`; a request
 * the caller stopped waiting for is `aborted`; a fault — a bug, a 5xx, a server nobody could
 * reach — is `failed`, and reported. A bounded context adds its own expected errors
 * (`expectErrors`); a process replaces this whole (`configureProcess({ outcomeOf })`).
 */
export function outcomeOf(error: unknown): Outcome {
  const failure = failureOf(error);
  if (failure.aborted) return "aborted";
  return failure.fault ? "failed" : "refused";
}
