import {
  type Draft,
  type Method,
  type One,
  type SendOptions,
  type Transport,
  TransportError,
} from "@sincpro/client-framework/client/transport";
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
   * refuse. Without it, every Command is a 404.
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

  return {
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
      // A deep copy: what the caller sent is not what the server keeps.
      const answer = await options.handle(method, route, copyOf(body));
      if (key !== undefined) answered.set(key, copyOf(answer));
      return answer as T;
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
  };
}
