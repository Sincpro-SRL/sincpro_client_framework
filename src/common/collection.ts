import type { AnyRecord, Count, Criteria, Expression } from "@sincpro/criteria";

/**
 * A to-many as a reading answers it — sincpro_framework's `EntityCollection`: the records, how
 * many there are, and the cursor to go on inside this parent. Never a bare list, which would
 * say the page is all there is.
 *
 *     customer.invoices   ->  { items: [i1, …, i40], count: { value: 1000, exact: false }, cursor: "eyJ…" }
 *
 * Context: a customer may have a million invoices, and the read brings forty of them with
 * «at least a thousand» — the backend counts up to a cap (`RELATION_COUNT_CAP`) because an exact
 * total reads every child. A screen that counted `items` showed forty and called it the total;
 * one that iterated an array never knew there was more. The same type on every platform, so the
 * web, the phone and a script read a relation the same way.
 *
 * `count` is `null` when the read asked for none (`CountMode.NONE`): the cursor alone says there
 * is more. A collection is written back only whole — the backend refuses a page of it, because
 * written back it would remove what it did not bring.
 */
export type EntityCollection<T> = {
  readonly items: readonly T[];
  readonly count?: Count | null;
  readonly cursor?: string | null;
};

/**
 * A collection with every part said — what `collectionOf` answers —, edited the way a string or
 * a date is: `append`, `extend`, `remove` and `replace` answer a new collection and never change
 * this one, as sincpro_framework's `EntityCollection` does.
 *
 *     const lines = collectionOf(invoice.lines);
 *     const next = lines.append(newLine).remove(oldLine.id);   // lines is as it was
 *
 * An edit keeps what the collection says: a page stays a page (its cursor; a floor stays a
 * floor), an exact count moves with what was added or removed. `remove` and `replace` of a record
 * it does not hold throw, as Python's `list.remove` does. Written as JSON it is the wire's shape:
 * `{ items, count, cursor }`.
 */
export class HeldCollection<T> implements EntityCollection<T> {
  readonly items: readonly T[];
  readonly count: Count | null;
  readonly cursor: string | null;
  /** The field each record's identity is in — what `remove` and `replace` match by. */
  readonly #identity: string;

  constructor(
    items: readonly T[],
    count: Count | null = null,
    cursor: string | null = null,
    identity = "id",
  ) {
    this.items = Object.freeze([...items]);
    this.count = count;
    this.cursor = cursor;
    this.#identity = identity;
    Object.freeze(this);
  }

  /** How many records are held — this page, never the total (`count` is that). */
  get length(): number {
    return this.items.length;
  }

  /** Whether it holds less than there is (`isPartial`). */
  get partial(): boolean {
    return isPartial(this);
  }

  [Symbol.iterator](): Iterator<T> {
    return this.items[Symbol.iterator]();
  }

  /** A new collection with `records` at the end. */
  append(...records: T[]): HeldCollection<T> {
    return this.#edited([...this.items, ...records], records.length);
  }

  /** A new collection with every one of `records` at the end, in order. */
  extend(records: Iterable<T>): HeldCollection<T> {
    return this.append(...records);
  }

  /** A new collection without these records — each named by itself or by its identity. */
  remove(...records: unknown[]): HeldCollection<T> {
    const unwanted = new Set(records.map((one) => this.#keyOf(one)));
    const held = new Set(this.items.map((one) => this.#keyOf(one)));
    const missing = [...unwanted].filter((key) => !held.has(key));
    if (missing.length > 0) throw new Error(`not in the collection: ${missing.join(", ")}`);
    return this.#edited(
      this.items.filter((one) => !unwanted.has(this.#keyOf(one))),
      -unwanted.size,
    );
  }

  /** A new collection where each of `records` takes the place of the held one with its identity. */
  replace(...records: T[]): HeldCollection<T> {
    const byKey = new Map(records.map((one) => [this.#keyOf(one), one] as const));
    const held = new Set(this.items.map((one) => this.#keyOf(one)));
    const missing = [...byKey.keys()].filter((key) => !held.has(key));
    if (missing.length > 0)
      throw new Error(`not in the collection: ${missing.join(", ")} — append adds a record`);
    return this.#edited(
      this.items.map((one) => byKey.get(this.#keyOf(one)) ?? one),
      0,
    );
  }

  toJSON(): EntityCollection<T> {
    return { items: this.items, count: this.count, cursor: this.cursor };
  }

  #keyOf(record: unknown): unknown {
    if (typeof record !== "object" || record === null) return record;
    const key = (record as Record<string, unknown>)[this.#identity];
    // A record not stored yet has no identity: it is itself, never every other new one too.
    return key === undefined || key === null || key === "" ? record : key;
  }

  #edited(items: readonly T[], moved: number): HeldCollection<T> {
    const count =
      this.count !== null && this.count.exact
        ? { value: Math.max(this.count.value + moved, 0), exact: true }
        : this.count;
    return new HeldCollection(items, count, this.cursor, this.#identity);
  }
}

/** Whether `value` is a collection as a reading answers one (`{items, …}`). */
export function isCollection(value: unknown): value is EntityCollection<unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  if (!("items" in value)) return false;
  const items = (value as { items?: unknown }).items;
  // A page whose records did not come (`items: null`) is still a page: its count says so.
  return Array.isArray(items) || items === null || items === undefined;
}

/**
 * Whatever a relation arrived as, as a collection with every part said.
 *
 *     collectionOf({ items: [a, b], count: { value: 30, exact: true }, cursor: "x" })
 *       -> the same, `cursor` and `count` said
 *     collectionOf([a, b])        -> { items: [a, b], count: { value: 2, exact: true }, cursor: null }
 *     collectionOf(undefined)     -> { items: [], count: { value: 0, exact: true }, cursor: null }
 *
 * An array — a domain written by hand, a record built in memory — holds all there is. `identity`
 * is the field `remove` and `replace` match records by (the model's `identity`, `"id"`).
 */
export function collectionOf<T>(
  value: EntityCollection<T> | readonly T[] | null | undefined,
  identity = "id",
): HeldCollection<T> {
  if (value instanceof HeldCollection && identity === "id") return value as HeldCollection<T>;
  if (Array.isArray(value))
    return new HeldCollection(
      value as readonly T[],
      { value: value.length, exact: true },
      null,
      identity,
    );
  if (isCollection(value)) {
    const page = value as EntityCollection<T>;
    return new HeldCollection(
      page.items ?? [],
      page.count ?? null,
      page.cursor ?? null,
      identity,
    );
  }
  return new HeldCollection<T>([], { value: 0, exact: true }, null, identity);
}

/**
 * Whether the collection holds less than there is — sincpro_framework's `is_partial`, the same
 * rule: a cursor says there is more; no count claims nothing; a floor, or a count above what it
 * holds, says there is more.
 *
 *     isPartial({ items: [a], cursor: "x" })                          -> true
 *     isPartial({ items: [a], count: { value: 1000, exact: false } }) -> true
 *     isPartial({ items: [a, b], count: { value: 2, exact: true } })  -> false
 *     isPartial({ items: [a] })                                       -> false
 */
export function isPartial(collection: EntityCollection<unknown>): boolean {
  if (collection.cursor != null) return true;
  const count = collection.count;
  if (count == null) return false;
  return !count.exact || count.value > (collection.items ?? []).length;
}

/**
 * How many there are, as well as the collection knows: its count, or — when the read asked for
 * none — what it holds, exact only when nothing says there is more.
 *
 *     totalOf({ items: [a, b], count: { value: 1000, exact: false } })  -> { value: 1000, exact: false }
 *     totalOf({ items: [a, b], cursor: "x" })                           -> { value: 2, exact: false }
 */
export function totalOf(collection: EntityCollection<unknown>): Count {
  return (
    collection.count ?? {
      value: (collection.items ?? []).length,
      exact: collection.cursor == null,
    }
  );
}

/** How a relation ties two records, as a model's definition says it (`FieldMeta`). */
export type RelationKeys = {
  identified_by?: string | null;
  parent_field?: string | null;
  related_field?: string | null;
};

/**
 * The question «the related records of this one», over the related entity — sincpro_framework's
 * `References.criteria()`: what pages a relation past what its record brought, searches it and
 * orders it, a list like any other. `criteria` narrows it; it never widens it.
 *
 *     relatedCriteria(meta.fields.invoices, customer, "id")
 *       -> { selection: { field: "customer_id", operator: "=", value: customer.id } }
 *     relatedCriteria(field, customer, "id", { order: [{ field: "issued_on", descending: true }] })
 *
 * The two fields the definition names (`parent_field`, `related_field`) are read when it names
 * them — a relation by a business key —; `identified_by` against the record's own key otherwise.
 * A relation whose definition says neither cannot be asked, and says so.
 */
export function relatedCriteria<T extends AnyRecord>(
  keys: RelationKeys,
  record: AnyRecord,
  identity = "id",
  criteria: Criteria<T> = {},
): Criteria<T> {
  const there = keys.related_field ?? keys.identified_by;
  const here = keys.related_field != null ? (keys.parent_field ?? identity) : identity;
  if (there == null || there === "")
    throw new Error(
      "this relation's definition names no key to ask it by (identified_by, related_field)",
    );
  const mine = { field: there, operator: "=", value: record[here] } as Expression<T>;
  return {
    ...criteria,
    selection: (criteria.selection === undefined
      ? mine
      : { all: [criteria.selection, mine] }) as Criteria<T>["selection"],
  };
}
