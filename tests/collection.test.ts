import assert from "node:assert/strict";

import {
  collectionOf,
  downloadRoute,
  exportRoute,
  isCollection,
  isPartial,
  relatedCriteria,
  restTransport,
  screensTransport,
  totalOf,
  TransportError,
} from "@sincpro/client-framework";
import { test } from "vitest";

const a = { id: "a" };
const b = { id: "b" };

test("a relation reads the same whether it came as a page or as an array", () => {
  assert.deepEqual(
    collectionOf({ items: [a, b], count: { value: 30, exact: true }, cursor: "x" }).toJSON(),
    { items: [a, b], count: { value: 30, exact: true }, cursor: "x" },
  );
  assert.deepEqual(collectionOf([a, b]).toJSON(), {
    items: [a, b],
    count: { value: 2, exact: true },
    cursor: null,
  });
  assert.deepEqual(collectionOf({ items: [a] }).toJSON(), {
    items: [a],
    count: null,
    cursor: null,
  });
  assert.deepEqual(collectionOf(undefined).toJSON(), {
    items: [],
    count: { value: 0, exact: true },
    cursor: null,
  });
  assert.equal(isCollection({ items: [] }), true);
  assert.equal(isCollection([a]), false);
});

test("each edit answers a new collection and leaves the one it was asked, as in Python", () => {
  const c = { id: "c" };
  const whole = collectionOf([a, b]);

  const appended = whole.append(c);
  const removed = whole.remove("a");
  const replaced = whole.replace({ id: "a", qty: 9 } as never);

  assert.deepEqual(whole.items, [a, b]);
  assert.deepEqual(appended.items, [a, b, c]);
  assert.deepEqual(appended.count, { value: 3, exact: true });
  assert.deepEqual(removed.items, [b]);
  assert.deepEqual(removed.count, { value: 1, exact: true });
  assert.deepEqual(replaced.items[0], { id: "a", qty: 9 });
  assert.deepEqual(whole.extend([c]).items, [a, b, c]);
  assert.equal(
    JSON.stringify(appended),
    JSON.stringify({ items: [a, b, c], count: { value: 3, exact: true }, cursor: null }),
  );
  assert.throws(() => whole.remove("z"), /not in the collection/);
  assert.throws(() => whole.replace({ id: "z" }), /append adds/);
});

test("an edited page is still a page, never the whole", () => {
  const page = collectionOf({
    items: [a],
    cursor: "x",
    count: { value: 1000, exact: false },
  });

  const appended = page.append(b);

  assert.equal(appended.cursor, "x");
  assert.equal(appended.partial, true);
  assert.deepEqual(appended.count, { value: 1000, exact: false });
  assert.deepEqual([...appended], [a, b]);
});

test("partial is sincpro_framework's rule: a cursor, a floor, or more counted than held", () => {
  assert.equal(isPartial({ items: [a], cursor: "x" }), true);
  assert.equal(isPartial({ items: [a], count: { value: 1000, exact: false } }), true);
  assert.equal(isPartial({ items: [a], count: { value: 3, exact: true } }), true);
  assert.equal(isPartial({ items: [a, b], count: { value: 2, exact: true } }), false);
  assert.equal(isPartial({ items: [a] }), false);
});

test("how many there are is the count, or what it holds when the read asked for none", () => {
  assert.deepEqual(totalOf({ items: [a], count: { value: 1000, exact: false } }), {
    value: 1000,
    exact: false,
  });
  assert.deepEqual(totalOf({ items: [a, b], cursor: "x" }), { value: 2, exact: false });
  assert.deepEqual(totalOf({ items: [a, b] }), { value: 2, exact: true });
});

test("the question of a relation is asked over the related entity, and only narrowed", () => {
  const customer = { id: "c1", code: "ACME" };

  assert.deepEqual(relatedCriteria({ identified_by: "customer_id" }, customer), {
    selection: { field: "customer_id", operator: "=", value: "c1" },
  });
  assert.deepEqual(
    relatedCriteria(
      { parent_field: "code", related_field: "customer_code" },
      customer,
      "id",
      {
        selection: { field: "paid", operator: "=", value: false },
        order: [{ field: "issued_on", descending: true }],
      },
    ),
    {
      selection: {
        all: [
          { field: "paid", operator: "=", value: false },
          { field: "customer_code", operator: "=", value: "ACME" },
        ],
      },
      order: [{ field: "issued_on", descending: true }],
    },
  );
  assert.throws(() => relatedCriteria({}, customer), /names no key/);
});

test("an export is downloaded: its bytes, what they are and the name to save them under", async () => {
  const asked: string[] = [];
  const transport = restTransport({
    base: "/v1",
    document: null,
    fetch: (async (url: string) => {
      asked.push(url);
      return new Response("{}\n{}\n", {
        status: 200,
        headers: {
          "content-type": "application/jsonl",
          "content-disposition": 'attachment; filename="entry.jsonl"',
        },
      });
    }) as typeof fetch,
  });
  const route = exportRoute(
    "/entries/export",
    { selection: { field: "paid", operator: "=", value: false } },
    "jsonl",
  );

  const file = await downloadRoute(screensTransport(transport), route);

  assert.equal(file.mediaType, "application/jsonl");
  assert.equal(file.filename, "entry.jsonl");
  assert.equal(await (await file.blob()).text(), "{}\n{}\n");
  const url = new URL(asked[0] ?? "", "http://x");
  assert.equal(url.pathname, "/v1/entries/export");
  assert.equal(url.searchParams.get("format"), "jsonl");
  assert.deepEqual(JSON.parse(url.searchParams.get("criteria") ?? ""), {
    selection: { field: "paid", operator: "=", value: false },
  });
});

test("a refused export is a TransportError, and a transport without download says so", async () => {
  const transport = restTransport({
    document: null,
    fetch: (async () =>
      new Response(JSON.stringify({ status: 403, title: "Forbidden" }), {
        status: 403,
      })) as typeof fetch,
  });

  await assert.rejects(downloadRoute(transport, "/entries/export"), TransportError);
  const { download: _, ...without } = transport;
  await assert.rejects(downloadRoute(without, "/entries/export"), /has no download\(\)/);
});

test("a record not stored yet is itself: removing one never removes the other new ones", () => {
  const first = { qty: 1 };
  const second = { qty: 2 };
  const lines = collectionOf<{ id?: string; qty: number }>([
    { id: "a", qty: 0 },
    first,
    second,
  ]);

  const removed = lines.remove(first);

  assert.deepEqual(removed.items, [{ id: "a", qty: 0 }, second]);
  assert.deepEqual(removed.count, { value: 2, exact: true });
});

test("a page whose records did not come is still a page, its count kept", () => {
  const page = collectionOf({
    items: null as never,
    count: { value: 1000, exact: false },
    cursor: "x",
  });

  assert.deepEqual(page.items, []);
  assert.equal(page.partial, true);
  assert.deepEqual(totalOf(page), { value: 1000, exact: false });
});

test("only a page says it reads other formats; a download is saved under the name it is given", async () => {
  const sent: { url: string; accept: string | undefined }[] = [];
  const transport = restTransport({
    document: null,
    decoders: [
      { mediaType: "application/vnd.apache.parquet", decode: async () => ({}) as never },
    ],
    fetch: (async (url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      sent.push({ url, accept: headers["Accept"] });
      if (url.includes("download"))
        return new Response("x", {
          status: 200,
          headers: {
            "content-disposition": url.includes("plain")
              ? 'attachment; filename="report 100%.csv"'
              : "attachment; filename*=UTF-8'es'informe%20final.parquet",
          },
        });
      return new Response(JSON.stringify({ entries: [], cursor: null, count: null }), {
        status: 200,
      });
    }) as typeof fetch,
  });

  await transport.list("/entries", {});
  await downloadRoute(transport, "/download/plain").then((file) =>
    assert.equal(file.filename, "report 100%.csv"),
  );
  await downloadRoute(transport, "/download/encoded").then((file) =>
    assert.equal(file.filename, "informe final.parquet"),
  );

  assert.match(sent[0]?.accept ?? "", /parquet/);
  assert.equal(sent[1]?.accept, undefined);
});
