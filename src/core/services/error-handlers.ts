import type { ErrorHandler } from "@sincpro/client-framework/core/domain/errors";

/**
 * The answer of a chain of error handlers to `error`, or what its last handler threw.
 *
 *     await handled([toEmpty, logAndRethrow], new IssueNotFound())   ->  toEmpty's answer
 *
 * 1. Each handler, first-registered-first, receives what the one before it threw.
 * Final: the first answer; when every handler threw, the last thrown — the original error when
 *    there is no handler at all.
 */
export async function handled(
  handlers: readonly ErrorHandler[],
  error: unknown,
): Promise<unknown> {
  let current = error;
  for (const handler of handlers) {
    try {
      return await handler(current);
    } catch (thrown) {
      current = thrown;
    }
  }
  throw current;
}
