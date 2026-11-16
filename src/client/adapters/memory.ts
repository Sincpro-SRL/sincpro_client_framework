import type { ChangeFeed } from "@sincpro/client-framework/client/domain/changes";
import {
  type Draft,
  type Method,
  type One,
  type SendOptions,
  type Transport,
  TransportError,
} from "@sincpro/client-framework/client/domain/transport";
import { announced, processChanges } from "@sincpro/client-framework/client/services/changes";
import { bindableTransport } from "@sincpro/client-framework/client/services/propagation";
import { pack, readValues } from "@sincpro/client-framework/common/serialization";
import type { AnyRecord, Criteria, Meta, Problem } from "@sincpro/criteria";
import { answer, answerGroups } from "@sincpro/criteria/engine";

/**
 * A server held in memory: tables of rows with their definition, answered with the same
 * engine sincpro_framework's criteria runs on.
 *
 * Context: not a test double. It is what a screen runs against before its server exists,
 * what Storybook and the tests run against, and what a domain with no server at all uses —
 * rows a screen already holds. It filters, orders, pages and counts
 * exactly as the server would (`answer` from `@sincpro/criteria/engine`), drops what the
 * model cannot answer and reports it, and refuses what the server would refuse. So the day a
 * real server answers, only the transport changes.
 *
 * A record is found at `<list route>/<id>`, by the field the model fetches by (`get_id`, else
 * the identity) — the convention sincpro_framework's REST routes follow.
 *
 *     const transport = memoryTransport({
 *       "/invoices": { meta: invoiceMeta, rows: invoices },
 *     }, { latency: 300 });
 */
export type MemoryTable = { meta: Meta; rows: readonly AnyRecord[] };

export type MemoryOptions = {
  /** Milliseconds every answer waits, so a screen's «loading» can be seen and tested. */
  latency?: number;
  /**
   * Answer a Command — a write, an action, a preview — the way the service would. It may
   * change the tables' rows (they are read on every request) and throw a `TransportError` to
   * refuse. Without it, every Command is a 404. What it returns is the answer; nothing — a
   * Command that answers nothing — is `null`, as REST's 204. An `Edit`'s `values` are read as the
   * server reads them with `assignableValues`.
   *
   * Its `body` is the Command's fields whatever the method — a `DELETE`'s too, which REST sends
   * in its query string (`restTransport`): this stands for the service, which reads a DTO, not a
   * URL.
   */
  handle?: (method: Method, route: string, body: unknown) => unknown;
  /** Answer a read that is neither a page nor a record (`GET /me`), its route with its query.
   *  Without it, the transport has no `read`. */
  read?: (route: string) => unknown;
  /** The draft this caller kept of a record, answered with it — sincpro_framework's `Drafts`. */
  draft?: (route: string) => Draft | null;
  /** Every list request, as it arrived: what a story or a test checks was really asked. */
  observe?: (route: string, criteria: Criteria) => void;
  /** Refuse a route the way a server would: return the problem it answers with. */
  refuse?: (route: string) => (Problem & { status?: number }) | undefined;
  /** Where each write is announced (`Change`), as a real server's transport does: the
   *  process's feed (`processChanges`) by default. */
  changes?: ChangeFeed;
};

/**
 * A deep copy written and read by the wire's rules (`pack`, `readValues`): what a real server
 * would have received and answered — a `Money` as `{ amount, currency }`, a `Decimal` as its text,
 * a `Date` as an instant, bytes as bytes — the same on every platform. `structuredClone` kept a
 * `Date` a `Date` in a browser and a JSON round trip made it text on a phone; neither is a wire.
 */
const copyOf = <T>(value: T): T =>
  // Through text, as a wire is: an answer that is a string («"2.50"», an instant) stays one.
  value === undefined ? value : (readValues(pack(value)) as T);

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((done, failed) => {
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      failed(signal.reason);
    });
  });
}

export function memoryTransport(
  tables: Readonly<Record<string, MemoryTable>>,
  options: MemoryOptions = {},
): Transport {
  const answered = new Map<string, unknown>();
  const changes = options.changes ?? processChanges;

  async function check(route: string, signal?: AbortSignal): Promise<void> {
    await wait(options.latency ?? 0, signal);
    const refused = options.refuse?.(route);
    if (refused !== undefined)
      throw new TransportError(route, refused.status ?? 400, refused);
  }

  function tableAt(route: string): MemoryTable {
    const path = route.split("?")[0] ?? route;
    const table = tables[path];
    if (table === undefined)
      throw new TransportError(route, 404, {
        kind: "not_found",
        reason: "ROUTE_NOT_FOUND",
        next_step: "fix_request",
        retryable: false,
        errors: [],
        extensions: {},
        detail: `No table answers ${path}.`,
      });
    return table;
  }

  return bindableTransport({
    async list(route, criteria, signal) {
      options.observe?.(route, criteria as Criteria);
      await check(route, signal);
      const table = tableAt(route);
      // A grouped question is answered with the groups — counted over EVERY row that matches,
      // each with the criteria that opens it — the way the server's aggregation answers it.
      const grouped = ((criteria as Criteria).grouping?.group_by?.length ?? 0) > 0;
      const page = grouped
        ? answerGroups(table.rows, criteria as never, table.meta)
        : answer(table.rows, criteria as never, table.meta);
      // A copy, as over a wire: a screen holding a row must not see the server change it.
      return { ...page, rows: copyOf(page.rows) } as never;
    },

    async one<T>(route: string, signal?: AbortSignal): Promise<One<T>> {
      await check(route, signal);
      // A record's route may carry a question (`?draft=true`): the id is the path's last part.
      const path = route.split("?")[0] ?? route;
      const slash = path.lastIndexOf("/");
      const table = tableAt(path.slice(0, slash));
      const id = decodeURIComponent(path.slice(slash + 1));
      const key = table.meta.get_id || table.meta.identity;
      const record = table.rows.find((row) => String(row[key]) === id);
      if (record === undefined)
        throw new TransportError(route, 404, {
          kind: "not_found",
          reason: "AGGREGATE_NOT_FOUND",
          next_step: "do_not_retry",
          retryable: false,
          errors: [],
          extensions: {},
          detail: `${table.meta.aggregate} ${id} does not exist.`,
        });
      return {
        record: copyOf(record) as T,
        meta: table.meta,
        dropped: [],
        draft: options.draft?.(route) ?? null,
      };
    },

    async send<T>(
      method: Method,
      route: string,
      body: unknown,
      signal?: AbortSignal,
      sending?: SendOptions,
    ) {
      return announced(changes, method, route, body, async () => {
        await check(route, signal);
        // A key already answered is answered again, without running the Command twice — what
        // sincpro_framework's `@idempotency` does with a repeated `Idempotency-Key`.
        const key = sending?.idempotencyKey;
        if (key !== undefined && answered.has(key)) return copyOf(answered.get(key)) as T;
        if (options.handle === undefined)
          throw new TransportError(route, 404, {
            kind: "not_found",
            reason: "ROUTE_NOT_FOUND",
            next_step: "fix_request",
            retryable: false,
            errors: [],
            extensions: {},
            detail: `Nothing answers ${method} ${route}.`,
          });
        // A deep copy: what the caller sent is not what the server keeps. A Command that
        // answers nothing is `null`, as REST's 204 is — never `undefined`.
        const answer = (await options.handle(method, route, copyOf(body))) ?? null;
        if (key !== undefined) answered.set(key, copyOf(answer));
        return answer as T;
      });
    },

    ...(options.read === undefined
      ? {}
      : {
          async read<T>(route: string, signal?: AbortSignal): Promise<T> {
            await check(route, signal);
            // A copy, as every answer: over a wire nobody holds the server's object.
            return copyOf(await options.read!(route)) as T;
          },
        }),
  });
}

/**
 * What sincpro_framework writes on a record — `Entity`'s fields and its mixins' (`AuditedMixin`'s
 * `created_by` / `updated_by`, `ArchivableMixin`'s `archived_at`): in a form's values only as the
 * record's echo. A record without a mixin never holds its fields, so a form never sends them.
 */
const FRAMEWORK_FIELDS: readonly string[] = [
  "id",
  "version",
  "created_at",
  "updated_at",
  "created_by",
  "updated_by",
  "archived_at",
];

/** Where a value is inside an `Edit`'s values: a field's name, a record's id or position. */
type ValuePath = readonly (string | number)[];

export type AssignableOptions = {
  /** The key of the record the edit names — its `Edit`'s `id`: an identity in the values other
   *  than it is refused. */
  id?: string;
  /** The record's definition: a name it does not declare is refused, and its `identity` is the
   *  field checked against `id`. */
  meta?: Meta;
  /** What the framework writes on the record — left out at every level, a nested record keeping
   *  its `id`. By default `Entity`'s (`id`, `version`, `created_at`, `updated_at`) and its
   *  mixins' (`created_by`, `updated_by`, `archived_at`); a project's own framework base names
   *  its own. */
  framework?: readonly string[];
};

/** A refusal of a value, as the server's `InvalidValue` answers it: a 422 pointing at it. */
function invalidValue(route: string, path: ValuePath, detail: string): TransportError {
  const pointer = ["values", ...path]
    .map((one) => String(one).replaceAll("~", "~0").replaceAll("/", "~1"))
    .join("/");
  return new TransportError(route, 422, {
    kind: "invalid",
    reason: "INVALID_VALUE",
    status: 422,
    detail,
    next_step: "fix_request",
    retryable: false,
    errors: [{ pointer: `#/${pointer}`, detail }],
    extensions: {},
  });
}

function isFields(value: unknown): value is AnyRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Each record of a list as a form sends it — its echo left out, its `id` kept —, named by its
 *  `id` where a refusal inside it points, by its position when it has none. */
function recordsOf(
  route: string,
  records: readonly unknown[],
  path: ValuePath,
  framework: ReadonlySet<string>,
): unknown[] {
  return records.map((one, index) => {
    if (!isFields(one)) return one;
    const named = one["id"];
    const at = named === undefined || named === null || named === "" ? index : String(named);
    return formValues(route, one, [...path, at], framework, true);
  });
}

/**
 * A list of records as a form sends it — sincpro_framework's `_sent_whole`: the list, or the
 * collection a reading answered (`{items, count, cursor}`) sent back whole, as its records. A page
 * of it — a cursor, or a count that is only a floor — is refused: written back, it would remove
 * every record it did not bring. An exact count above what it holds is a whole collection a form
 * edited (a record removed), not a page — the server's rule, not `isPartial`'s.
 */
function heldValue(
  route: string,
  value: unknown,
  path: ValuePath,
  framework: ReadonlySet<string>,
): unknown {
  if (Array.isArray(value)) return recordsOf(route, value, path, framework);
  if (!isFields(value) || !("items" in value)) return value;
  const name = String(path[path.length - 1]);
  const items = value["items"];
  if (!Array.isArray(items))
    throw invalidValue(route, path, `${name} holds records: send them as a list`);
  const count = isFields(value["count"]) ? value["count"] : {};
  const floor = count["exact"] === false;
  if ((value["cursor"] !== undefined && value["cursor"] !== null) || floor) {
    const total = typeof count["value"] === "number" ? count["value"] : items.length;
    throw invalidValue(
      route,
      path,
      `${name} was sent as a page — ${items.length} of ${floor ? "at least " : ""}${total} — ` +
        "and a page written back would remove every record it did not bring: send all of them",
    );
  }
  return recordsOf(route, items, path, framework);
}

/** A record's values without what the framework writes — a nested one keeping its `id`. */
function formValues(
  route: string,
  values: AnyRecord,
  path: ValuePath,
  framework: ReadonlySet<string>,
  nested: boolean,
): AnyRecord {
  const read: AnyRecord = {};
  for (const [name, value] of Object.entries(values)) {
    if (framework.has(name) && !(nested && name === "id")) continue;
    read[name] = heldValue(route, value, [...path, name], framework);
  }
  return read;
}

/**
 * The values of an `Edit` its record may be assigned, read as sincpro_framework 3.37 reads them
 * (`assignable`, `form_values`, `apply_values`) — for a `memoryTransport`'s `handle` that stands
 * for a service's `Edit`:
 *
 *     handle(method, route, body) {
 *       const sent = body as { id: string; values?: AnyRecord; action?: string };
 *       const values = assignableValues(route, sent.values, { id: sent.id, meta: invoiceMeta });
 *       …
 *     }
 *
 * 1. The values are an object of fields (none is `{}`); anything else is refused.
 * 2. An identity other than the record's (`id`) is refused: it would put one record's values on
 *    another.
 * 3. What the framework writes is the record's echo — a form reads a record whole and sends it
 *    back whole —: left out, never assigned and never refused. In a record a list holds (a line),
 *    all of it but its `id`, the way a form names the line it edits.
 * 4. A name the definition does not declare is refused.
 * 5. A list of records goes whole: the collection a reading answered is read as its records, each
 *    as in 3; a page of it is refused (`heldValue`). A record held as one object (a many2one
 *    sent expanded) is passed as it came: which fields of it are the record's is the service's.
 * Final: the values to assign. Each refusal is a `TransportError` 422 — `invalid`,
 *    `INVALID_VALUE` — pointing at the value (`#/values/lines/l1/parts`): a nested record by its
 *    `id`, by its position when it has none, as the server's `InvalidValue` points.
 *
 * Context: opt-in, and generic. A fake server that took whatever came hid that a form sent the
 * record whole — the framework's echo, a relation read as a page — while the real `Edit` refused
 * it: stories passed, and a stored record could not be edited against the real backend. A `handle`
 * that does not call it reads `values` as it likes.
 */
export function assignableValues(
  route: string,
  values: unknown,
  options: AssignableOptions = {},
): AnyRecord {
  if (values === undefined || values === null) return {};
  if (!isFields(values))
    throw invalidValue(route, [], "values is the record's fields, as an object");
  const { meta, id } = options;
  const aggregate = meta?.aggregate ?? "The record";
  const identity = meta?.identity ?? "id";
  const echoed = values[identity];
  // Only where the record is found by its identity: a key of its own is another field.
  const byIdentity = meta === undefined || (meta.get_id || meta.identity) === identity;
  if (
    id !== undefined &&
    byIdentity &&
    echoed !== undefined &&
    echoed !== null &&
    String(echoed) !== id
  )
    throw invalidValue(
      route,
      [identity],
      `${aggregate} ${id} was sent the values of ${aggregate} ${String(echoed)}`,
    );
  const framework = new Set(options.framework ?? FRAMEWORK_FIELDS);
  if (meta !== undefined) {
    const unknown = Object.keys(values).filter(
      (name) => !framework.has(name) && !(name in meta.fields),
    );
    const [first] = unknown;
    if (first !== undefined)
      throw invalidValue(
        route,
        [first],
        `${aggregate} has no field ${unknown.join(", ")} to assign`,
      );
  }
  return formValues(route, values, [], framework, false);
}
