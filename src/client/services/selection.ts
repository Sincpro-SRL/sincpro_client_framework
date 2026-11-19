import {
  criteriaOf,
  type Selection,
  SelectionTooLarge,
  sizeOf,
} from "@sincpro/client-framework/client/domain/selection";
import type { Transport } from "@sincpro/client-framework/client/domain/transport";
import type { AnyRecord } from "@sincpro/criteria";

/**
 * The keys of the chosen records — what a Command run once per record needs, what a many2many
 * stores —, never more than `limit`.
 *
 *     await keysOf(chosen(["F-1", "F-7"]), { transport, route: "/invoices", identity: "number", limit: 200 })
 *       ->  ["F-1", "F-7"]
 *     await keysOf(allMatching(ofSincpro, 37), { …, identity: "id", limit: 200 })
 *       ->  the 37 keys, read as one page of references
 *
 * Context: «all that match» is a question, and its records may be millions: they are read only
 * when someone needs their keys, as references (the identity alone, `specification`), one page
 * of `limit + 1`. Past the ceiling it refuses (`SelectionTooLarge`) instead of answering a part:
 * running a Command on 200 of 5 000 chosen, with nothing said, is worse than running none.
 *
 * 1. A size already known past the ceiling is refused before anything is read.
 * 2. Keys are in hand: they are the answer.
 * 3. Else one page of references for exactly the chosen records (`criteriaOf`), one more than the
 *    ceiling — the one more says the ceiling was passed.
 * Final: the keys, in the order the server answered them.
 */
export async function keysOf(
  selection: Selection,
  options: {
    transport: Transport;
    /** Where the entity is listed: `listRoute(entity.list)`. */
    route: string;
    /** The field the keys are of: the model's `get_id`, else its `identity`. */
    identity: string;
    /** The most keys the caller takes at once. */
    limit: number;
    signal?: AbortSignal;
  },
): Promise<readonly string[]> {
  const { transport, route, identity, limit, signal } = options;
  const size = sizeOf(selection);
  if (size !== null && size > limit) throw new SelectionTooLarge(limit, size);
  if (selection.by === "keys") return selection.keys;
  const question = criteriaOf(selection, identity);
  const page = await transport.list<AnyRecord>(
    route,
    {
      ...(question === undefined ? {} : { selection: question }),
      pagination: { limit: limit + 1 },
      specification: { [identity]: {} },
    },
    signal,
  );
  if (page.rows.length > limit) throw new SelectionTooLarge(limit, page.count?.value ?? null);
  return page.rows.map((row) => String(row[identity]));
}
