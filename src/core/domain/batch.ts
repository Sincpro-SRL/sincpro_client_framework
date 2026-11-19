import type { Failure } from "@sincpro/client-framework/common/failures";

/**
 * What became of one item of a batch: its answer, its failure, or nothing — it never ran.
 *
 * `index` is its place among the items given, whatever order they finished in; `item` is the
 * item itself (a key, a body), so a screen names what failed without looking it up again.
 */
export type ItemOutcome<I, R> =
  | { readonly index: number; readonly item: I; readonly status: "done"; readonly answer: R }
  | {
      readonly index: number;
      readonly item: I;
      readonly status: "failed";
      /** What kind of failure it was, read once (`failureOf`): what a screen says and decides on. */
      readonly failure: Failure;
      /** What was thrown, as it was. */
      readonly error: unknown;
    }
  | { readonly index: number; readonly item: I; readonly status: "skipped" };

/**
 * One outcome per item, in the items' order — sincpro_framework's `BatchResult` (#185): «per
 * index, the answer or the problem». A batch the client ran one item at a time and one a server
 * ran at once answer the same shape.
 *
 *     { outcomes: [done F-1, failed F-7 (conflict), done F-9], done: 2, failed: 1, skipped: 0 }
 */
export type BatchResult<I, R> = {
  readonly outcomes: readonly ItemOutcome<I, R>[];
  readonly done: number;
  readonly failed: number;
  /** Never ran: the batch was cancelled, or stopped at a failure (`stopOnFailure`). */
  readonly skipped: number;
};
