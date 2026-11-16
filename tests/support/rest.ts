import {
  type MemoryTable,
  memoryTransport,
  type Method,
  TransportError,
} from "@sincpro/client-framework";
import type { AnyRecord, Criteria } from "@sincpro/criteria";

import { discoveryDocument, VERSION } from "./discovery";
import type { servidorVentas } from "./servidor";

/**
 * A `fetch` that speaks sincpro_framework's REST wire — the HTTP a running service answers —
 * over the sales service in memory.
 *
 * Context: `memoryTransport` answers with function calls, so a story over it never sends a URL,
 * never parses an envelope and never reads a `problem+json`. This puts the wire back in the
 * middle: the stories that use it go through `restTransport` exactly as an app does in
 * production, and only the far end is fake.
 *
 *     GET  /openapi.json               → the discovery document: each model's contract
 *     GET  /v1/facturas?criteria={…}   → {facturas: […], cursor, count, model_version, dropped}
 *     GET  /v1/facturas/F-1            → {factura: {…}, model_version, dropped, draft}
 *     POST /v1/facturas/F-1/confirm    → the Command's response, as JSON
 *     DELETE /v1/facturas/F-1?dry_run=true → read from its URL, never its body
 *     a Command that answers nothing   → 204, no body
 *     a refusal                        → its status, `application/problem+json`
 *
 * `calls` keeps every request, for a story or a test to check what really travelled.
 */
export type Call = { method: string; url: string; body: unknown; key?: string };

/** The methods the wire reads from the URL alone (sincpro_framework's `READ_FROM_URL`). */
const FROM_URL = new Set(["DELETE"]);

/**
 * A DELETE's fields, as the wire reads them from its query string (`payload_from_query`): a
 * plain value as it came, which the DTO coerces — here, decoded as JSON when it reads as JSON
 * (`true`, `3`), kept as text otherwise —, and anything else decoded from JSON.
 */
function fieldsOfQuery(query: URLSearchParams): AnyRecord {
  return Object.fromEntries(
    [...query].map(([name, value]) => {
      try {
        return [name, JSON.parse(value) as unknown];
      } catch {
        return [name, value];
      }
    }),
  );
}

export function restServer(
  servidor: ReturnType<typeof servidorVentas>,
  base = "/v1",
  onCall?: (call: Call) => void,
) {
  const tables = servidor.tables as Readonly<Record<string, MemoryTable>>;
  const engine = memoryTransport(tables, { handle: servidor.handle, draft: servidor.draft });
  const calls: Call[] = [];

  const json = (status: number, body: unknown, type = "application/json") =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": type } });

  async function answer(
    method: string,
    path: string,
    query: URLSearchParams,
    body: unknown,
    key: string | undefined,
  ) {
    if (method !== "GET") {
      const answered = await engine.send(
        method as Method,
        path,
        // A DELETE is read from its URL: a body it carried is never read.
        FROM_URL.has(method) ? fieldsOfQuery(query) : body,
        undefined,
        key === undefined ? {} : { idempotencyKey: key },
      );
      return answered === null ? new Response(null, { status: 204 }) : json(200, answered);
    }

    if (path === "/openapi.json") return json(200, discoveryDocument(tables, base));

    const table = tables[path];
    if (table !== undefined) {
      const written = query.get("criteria");
      const criteria = (written === null ? {} : JSON.parse(written)) as Criteria;
      const page = await engine.list<AnyRecord>(path, criteria);
      const name = path.slice(path.lastIndexOf("/") + 1);
      return json(200, {
        [name]: page.rows,
        cursor: page.cursor,
        count: page.count,
        model_version: VERSION,
        dropped: page.dropped,
      });
    }

    const one = await engine.one<AnyRecord>(path);
    const name = (one.meta?.aggregate ?? "record").toLowerCase();
    return json(200, {
      [name]: one.record,
      model_version: VERSION,
      dropped: one.dropped,
      draft: one.draft,
    });
  }

  const fetcher: typeof globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = new URL(String(input), "http://ventas.local");
    const method = init?.method ?? "GET";
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    const key = new Headers(init?.headers).get("Idempotency-Key") ?? undefined;
    const call = { method, url: url.pathname + url.search, body, ...(key ? { key } : {}) };
    calls.push(call);
    onCall?.(call);
    const path = url.pathname.startsWith(base)
      ? url.pathname.slice(base.length)
      : url.pathname;
    try {
      return await answer(method, path, url.searchParams, body, key);
    } catch (error) {
      if (error instanceof TransportError && error.problem !== null)
        return json(
          error.status ?? 500,
          { status: error.status, ...error.problem },
          "application/problem+json",
        );
      throw error;
    }
  }) as typeof globalThis.fetch;

  return { fetch: fetcher, calls, base };
}
