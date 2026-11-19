import type { AnyRecord, Expression } from "@sincpro/criteria";

/**
 * Which records of one entity a person — or a script — chose: THESE, by their keys, or EVERY ONE a
 * question matches («the 37 contacts of SINCPRO»), but these.
 *
 *     chosen(["F-1", "F-7"])                         these two
 *     allMatching(overdue, 187)                       the 187 the server counted for `overdue`
 *     toggled(allMatching(overdue, 187), "F-9")       all 187 but F-9: 186
 *
 * Context: acting on many records — confirming three invoices, paying the months ticked, adding
 * every contact of a company to a mail, a script closing what is overdue — is the same on every
 * platform, and each one kept it its own way: a list held the keys of its page in its state, the
 * workspace heard references, and «every one that matches» could be drawn but not held. It is a
 * VALUE here — plain data, never a store —, so it crosses whatever a platform puts it through: a
 * screen's state, a chooser's answer, a link.
 *
 * Two forms, because a person chooses in two ways. Ticking chooses keys; «all that match» chooses
 * a question, whose records are the server's to count and may be millions — they are never
 * brought here to be chosen (`keysOf` reads them, with a ceiling, when someone needs them).
 */
export type Selection<T = AnyRecord> = ChosenKeys | AllMatching<T>;

/** These records, by their keys, in the order they were chosen. */
export type ChosenKeys = { readonly by: "keys"; readonly keys: readonly string[] };

/** Every record the question matches, but `except`. `total` is how many the server counted for
 *  the question — `null` when it did not say. */
export type AllMatching<T = AnyRecord> = {
  readonly by: "matching";
  /** The question; `undefined` is every record of the entity. */
  readonly matching: Expression<T> | undefined;
  readonly total: number | null;
  readonly except: readonly string[];
};

/** These keys, each once, in the order given. */
export function chosen(keys: Iterable<string>): ChosenKeys {
  return Object.freeze({ by: "keys", keys: Object.freeze([...new Set(keys)]) });
}

/** No record. */
export const NOTHING_CHOSEN: ChosenKeys = chosen([]);

/** Every record `matching` asks for — `total` as the server counted it. */
export function allMatching<T = AnyRecord>(
  matching: Expression<T> | undefined,
  total: number | null = null,
): AllMatching<T> {
  return Object.freeze({ by: "matching", matching, total, except: Object.freeze([]) });
}

/** Whether the record of `key` is among the chosen. */
export function isChosen(selection: Selection, key: string): boolean {
  return selection.by === "keys"
    ? selection.keys.includes(key)
    : !selection.except.includes(key);
}

/**
 * The same choice with `key` flipped: added if it was not chosen, taken out if it was. Out of an
 * «all that match», a key is an exception — what Gmail does when one row is unticked after
 * «select all».
 */
export function toggled<T>(selection: Selection<T>, key: string): Selection<T> {
  if (selection.by === "keys")
    return chosen(
      selection.keys.includes(key)
        ? selection.keys.filter((one) => one !== key)
        : [...selection.keys, key],
    );
  const except = selection.except.includes(key)
    ? selection.except.filter((one) => one !== key)
    : [...selection.except, key];
  return Object.freeze({ ...selection, except: Object.freeze(except) });
}

/** How many records are chosen; `null` when «all that match» has no count from the server. */
export function sizeOf(selection: Selection): number | null {
  if (selection.by === "keys") return selection.keys.length;
  return selection.total === null
    ? null
    : Math.max(0, selection.total - selection.except.length);
}

/** Whether nothing is chosen — an «all that match» of unknown size is not known to be empty. */
export function isEmpty(selection: Selection): boolean {
  return sizeOf(selection) === 0;
}

/**
 * The one question that asks for exactly the chosen records — what a reading or a server batch
 * sends. `identity` is the field the keys are of (the model's `get_id` or `identity`).
 *
 *     criteriaOf(chosen(["F-1", "F-7"]), "number")
 *       ->  { field: "number", operator: "in", value: ["F-1", "F-7"] }
 *     criteriaOf(toggled(allMatching(overdue), "F-9"), "number")
 *       ->  { all: [overdue, { field: "number", operator: "not in", value: ["F-9"] }] }
 *
 * No key chosen asks for no record (`in []`); «all that match» with no question and no exception
 * is every record (`undefined`, no condition).
 */
export function criteriaOf<T>(
  selection: Selection<T>,
  identity: string,
): Expression<T> | undefined {
  if (selection.by === "keys")
    return { field: identity, operator: "in", value: [...selection.keys] } as Expression<T>;
  if (selection.except.length === 0) return selection.matching;
  const except = {
    field: identity,
    operator: "not in",
    value: [...selection.except],
  } as Expression<T>;
  return selection.matching === undefined
    ? except
    : ({ all: [selection.matching, except] } as Expression<T>);
}

/**
 * A selection asked for more keys than its caller takes at once — «all that match» counted 5 000
 * where a mail takes 200. Declared `invalid`: the caller narrows the question or acts on the server
 * with it, never on a part of it chosen at random.
 */
export class SelectionTooLarge extends Error {
  static readonly failureKind = "invalid";
  readonly reason = "SELECTION_TOO_LARGE";

  constructor(
    /** How many the caller takes. */
    readonly limit: number,
    /** How many were chosen, when known. */
    readonly size: number | null,
  ) {
    super(
      size === null
        ? `more than ${limit} records chosen`
        : `${size} records chosen, ${limit} at most`,
    );
    this.name = "SelectionTooLarge";
  }
}
