import { failureOf } from "@sincpro/client-framework/common/failures";
import type { BatchResult, ItemOutcome } from "@sincpro/client-framework/core/domain/batch";

/** What a batch's step is handed beside its item. */
export type BatchStep<I, R> = (
  item: I,
  run: {
    /** The item's place among those given. */
    readonly index: number;
    /** The batch's signal: hand it to what the step runs, so cancelling stops the item too. */
    readonly signal: AbortSignal | undefined;
  },
) => Promise<R>;

export type BatchOptions<I, R> = {
  /** How many items run at once. One by default: in order, as `for rec in self`. */
  concurrency?: number;
  /** Cancels the batch: what has not started is skipped, what runs gets the signal. */
  signal?: AbortSignal;
  /** At the first failure, start nothing more — what is running finishes. */
  stopOnFailure?: boolean;
  /** Heard as each item settles, in the order they settle: a screen's progress. */
  onOutcome?: (
    outcome: ItemOutcome<I, R>,
    progress: { settled: number; total: number },
  ) => void;
};

/**
 * Runs a step once per item and answers one outcome per item — Odoo's `for rec in self:`, where a
 * failure is that item's, not the batch's.
 *
 *     const result = await runBatch(keys, (key, { signal }) =>
 *       billingBoundedContext.execute(new CommandConfirmInvoice(key), { signal }),
 *     );
 *     result.failed     // 1
 *     result.outcomes   // [done F-1, failed F-7 (conflict: already cancelled), done F-9]
 *
 * Context: confirming the invoices ticked, paying the months chosen, closing what a script finds
 * overdue — each platform wrote its loop, and each loop stopped at the first error or swallowed
 * it. The step is any work for one item: a bounded context's `execute` — each item then runs as
 * its own use case, with its span, its context and its error handling: nothing escapes
 * execution —, a generated client's operation, a transport's send.
 *
 * A failure is read once (`failureOf`) and kept as that item's outcome: never thrown out of the
 * batch, never reported again — the run that failed already reported it if it had to. The
 * outcomes come in the items' order, whatever order they settled in.
 *
 * 1. Up to `concurrency` items run at once, each taking the next one not started.
 * 2. Before starting one: cancelled, or stopped by a failure (`stopOnFailure`)? Then no more start.
 * 3. Each settles as done (its answer) or failed (its failure); `onOutcome` hears it.
 * Final: every item has an outcome — the ones never started, skipped — and the counts.
 */
export async function runBatch<I, R>(
  items: readonly I[],
  step: BatchStep<I, R>,
  options: BatchOptions<I, R> = {},
): Promise<BatchResult<I, R>> {
  const { concurrency = 1, signal, stopOnFailure = false, onOutcome } = options;
  if (!Number.isInteger(concurrency) || concurrency < 1)
    throw new RangeError(
      `concurrency must be a whole number of at least 1, not ${concurrency}`,
    );

  const outcomes: (ItemOutcome<I, R> | undefined)[] = new Array(items.length);
  let next = 0;
  let settled = 0;
  let stopped = false;

  const settle = (outcome: ItemOutcome<I, R>) => {
    outcomes[outcome.index] = outcome;
    settled += 1;
    onOutcome?.(outcome, { settled, total: items.length });
  };

  const worker = async () => {
    while (next < items.length && !stopped && signal?.aborted !== true) {
      const index = next++;
      const item = items[index] as I;
      try {
        // Through a promise: a step that throws before it awaits fails its item, not the batch.
        const answer = await Promise.resolve().then(() => step(item, { index, signal }));
        settle({ index, item, status: "done", answer });
      } catch (error) {
        if (stopOnFailure) stopped = true;
        settle({ index, item, status: "failed", failure: failureOf(error), error });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));

  const all = items.map(
    (item, index): ItemOutcome<I, R> => outcomes[index] ?? { index, item, status: "skipped" },
  );
  const count = (status: ItemOutcome<I, R>["status"]) =>
    all.filter((one) => one.status === status).length;
  return {
    outcomes: all,
    done: count("done"),
    failed: count("failed"),
    skipped: count("skipped"),
  };
}
