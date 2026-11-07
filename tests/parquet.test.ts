import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { restTransport } from "@sincpro/client-framework";
import { PARQUET, parquetDecoder, parquetRecords } from "@sincpro/client-framework/parquet";
import { test } from "vitest";

/** Written by sincpro_framework's `searched_as_parquet`: a page of two of three entries, from a
 *  store that declares no scale (the amount travels as its text), and postings from a column
 *  declared `Numeric(14, 2)` (a decimal128). */
const fixture = (name: string): ArrayBuffer => {
  const bytes = readFileSync(new URL(`./support/${name}`, import.meta.url));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
};

test("a Parquet answer reads as the JSON wire writes each value, with its footer", async () => {
  const { records, footer } = await parquetRecords(fixture("entries.parquet"));

  assert.equal(footer?.records, "entries");
  assert.equal(typeof footer?.cursor, "string");
  assert.deepEqual(footer?.count, { value: 3, exact: true });
  assert.equal(records.length, 2);
  const [first] = records;
  assert.equal(first?.["id"], "e1");
  assert.equal(first?.["number"], 1);
  assert.equal(first?.["amount"], "12345678901.25");
  assert.equal(first?.["posted_on"], "2026-11-01");
  assert.equal(first?.["booked_at"], "2026-11-06T14:30:00.123456Z");
  assert.deepEqual(first?.["tags"], ["cierre"]);
  assert.equal(first?.["memo"], null);
});

test("a decimal column comes back as its exact text at the column's scale", async () => {
  const { records } = await parquetRecords(fixture("postings.parquet"));

  assert.deepEqual(
    records.map((one) => one["amount"]),
    ["90071992547.99", "-0.05"],
  );
});

test("a transport with the decoder says it reads Parquet and reads a Parquet page as any page", async () => {
  const sent: Record<string, string>[] = [];
  const transport = restTransport({
    base: "/v1",
    document: null,
    decoders: [parquetDecoder],
    fetch: (async (_url: string, init?: RequestInit) => {
      sent.push((init?.headers ?? {}) as Record<string, string>);
      return new Response(fixture("entries.parquet"), {
        status: 200,
        headers: { "content-type": PARQUET },
      });
    }) as typeof fetch,
  });

  const page = await transport.list("/entries", {
    pagination: { limit: 2_000_000 },
  } as never);

  assert.match(sent[0]?.["Accept"] ?? "", /application\/vnd\.apache\.parquet/);
  assert.equal(page.rows.length, 2);
  assert.equal((page.rows[0] as Record<string, unknown>)["amount"], "12345678901.25");
  assert.deepEqual(page.count, { value: 3, exact: true });
  assert.equal(typeof page.cursor, "string");
});

test("a transport without the decoder never says it reads Parquet", async () => {
  const sent: Record<string, string>[] = [];
  const transport = restTransport({
    document: null,
    fetch: (async (_url: string, init?: RequestInit) => {
      sent.push((init?.headers ?? {}) as Record<string, string>);
      return new Response(JSON.stringify({ entries: [], cursor: null, count: null }), {
        status: 200,
      });
    }) as typeof fetch,
  });

  await transport.list("/entries", {});

  assert.equal(sent[0]?.["Accept"], undefined);
});
