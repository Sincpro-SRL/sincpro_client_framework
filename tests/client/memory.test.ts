import assert from "node:assert/strict";

import {
  assignableValues,
  defineMeta,
  field,
  memoryTransport,
  TransportError,
} from "@sincpro/client-framework";
import { criteria, plain } from "@sincpro/criteria";
import { test } from "vitest";

import { FACTURAS, facturas, VENTAS } from "../support/ventas";

const transport = memoryTransport(VENTAS);

test("a page comes back the size asked, with the total and the definition", async () => {
  const page = await transport.list("/facturas", plain(criteria().limit(10)));
  assert.equal(page.rows.length, 10);
  assert.equal(page.count?.value, FACTURAS.length);
  assert.equal(page.meta?.aggregate, "Factura");
  assert.notEqual(page.cursor, null);
});

test("filters and orders with the server's semantics", async () => {
  const page = await transport.list(
    "/facturas",
    plain(criteria().selection(["state", "=", "paid"]).order("-amount_total").limit(100)),
  );
  assert.ok(page.rows.length > 0);
  assert.ok(page.rows.every((row) => row["state"] === "paid"));
  const totals = page.rows.map((row) => Number(row["amount_total"]));
  assert.deepEqual(
    totals,
    [...totals].sort((a, b) => b - a),
  );
});

test("a condition the model cannot answer is dropped and reported, never thrown", async () => {
  const page = await transport.list(
    "/facturas",
    plain(criteria().selection(["nope", "=", 1])),
  );
  assert.deepEqual(
    page.dropped.map((d) => d.field),
    ["nope"],
  );
});

test("relations come back in the rows: a many2one expanded, a one2many as a page", async () => {
  const page = await transport.list("/facturas", plain(criteria().limit(1)));
  const [row] = page.rows;
  assert.equal(typeof row?.["customer"], "object");
  assert.ok("items" in (row?.["lines"] as object));
});

test("one record by the route <list>/<id>, with its definition", async () => {
  const one = await transport.one<{ number: string }>(facturas.one("F-2026-0003"));
  assert.equal(one.record.number, "F-2026-0003");
  assert.equal(one.meta?.aggregate, "Factura");
});

test("a record that does not exist is a not_found refusal", async () => {
  await assert.rejects(transport.one(facturas.one("F-0")), (error: unknown) => {
    assert.ok(error instanceof TransportError);
    assert.equal(error.status, 404);
    assert.equal(error.problem?.kind, "not_found");
    return true;
  });
});

test("a refusal is answered the way the server would, with its problem", async () => {
  const refusing = memoryTransport(VENTAS, {
    refuse: () => ({
      kind: "permission_denied",
      reason: "MISSING_PERMISSION",
      next_step: "ask_for_access",
      retryable: false,
      errors: [],
      extensions: {},
      status: 403,
      guidance: "Pedí acceso a ventas.",
    }),
  });
  await assert.rejects(refusing.list("/facturas", {}), (error: unknown) => {
    assert.ok(error instanceof TransportError);
    assert.equal(error.status, 403);
    return true;
  });
});

test("what it answers is a copy, as over a wire: the server changing a row does not reach it", async () => {
  const rows = [{ id: "a", version: 1 }];
  const meta = (await memoryTransport(VENTAS).list("/clientes", {})).meta!;
  const local = memoryTransport({
    "/x": { meta: { ...meta, identity: "id", get_id: "id" }, rows },
  });
  const one = await local.one<{ version: number }>("/x/a");
  rows[0]!.version = 2;
  assert.equal(one.record.version, 1);
});

test("a Command that answers nothing resolves null, as REST's 204 — again under the same key", async () => {
  let runs = 0;
  const silent = memoryTransport(VENTAS, {
    handle: () => {
      runs += 1;
    },
  });
  assert.equal(await silent.send("DELETE", "/facturas/F-1", { dry_run: false }), null);
  const key = { idempotencyKey: "k-1" };
  assert.equal(await silent.send("POST", "/facturas/F-1/archive", {}, undefined, key), null);
  assert.equal(await silent.send("POST", "/facturas/F-1/archive", {}, undefined, key), null);
  assert.equal(runs, 2);
});

/** A banner with its pictures — lines a form edits whole — as a hand-written definition. */
const bannerMeta = defineMeta({
  aggregate: "Banner",
  identity: "id",
  fields: {
    id: field.text({ readonly: true }),
    version: field.integer({ readonly: true }),
    created_at: field.datetime({ readonly: true }),
    updated_at: field.datetime({ readonly: true }),
    title: field.text(),
    pictures: field.one2many("Picture", { identifiedBy: "banner_id" }),
  },
});

/** What an `Edit` refusal says: its status, kind and where it points. */
function refusedAt(pointer: string) {
  return (error: unknown) => {
    assert.ok(error instanceof TransportError);
    assert.equal(error.status, 422);
    assert.equal(error.problem?.kind, "invalid");
    assert.equal(error.problem?.reason, "INVALID_VALUE");
    assert.equal(error.problem?.errors[0]?.pointer, pointer);
    return true;
  };
}

test("an Edit's values: the framework's echo is left out, never assigned and never refused", () => {
  const read = {
    id: "b1",
    version: 3,
    created_at: "2026-11-01T10:00:00Z",
    updated_at: "2026-11-02T10:00:00Z",
    title: "Rebajas",
    pictures: [{ id: "p1", version: 2, created_at: "2026-11-01T10:00:00Z", url: "a.png" }],
  };
  assert.deepEqual(
    assignableValues("/banners/b1/edit", read, { id: "b1", meta: bannerMeta }),
    {
      title: "Rebajas",
      // A line keeps the id that names it; the rest of its echo goes.
      pictures: [{ id: "p1", url: "a.png" }],
    },
  );
  // Without a definition the same echo goes; nothing is checked against it.
  assert.deepEqual(assignableValues("/x", { version: 1, anything: 2 }), { anything: 2 });
  assert.deepEqual(assignableValues("/x", undefined), {});
  // What the framework's mixins write is echo too: a trash's stamp, who created and changed it.
  assert.deepEqual(
    assignableValues("/x", {
      archived_at: null,
      created_by: "u1",
      updated_by: "u2",
      title: "t",
    }),
    { title: "t" },
  );
  // A project's own framework base names its own echo.
  assert.deepEqual(
    assignableValues(
      "/x",
      { stamped: 1, version: 2, title: "t" },
      { framework: ["stamped"] },
    ),
    { version: 2, title: "t" },
  );
});

test("an Edit's values of another record are refused, pointing at its identity", () => {
  assert.throws(
    () =>
      assignableValues(
        "/banners/b1/edit",
        { id: "b2", title: "x" },
        { id: "b1", meta: bannerMeta },
      ),
    refusedAt("#/values/id"),
  );
  // The record's own id, and no id at all, are its echo.
  assert.deepEqual(assignableValues("/b", { id: "b1", title: "x" }, { id: "b1" }), {
    title: "x",
  });
  assert.deepEqual(assignableValues("/b", { title: "x" }, { id: "b1" }), { title: "x" });
});

test("a relation read as a page is refused: written back it would remove what it did not bring", () => {
  const page = (over: object) => ({
    title: "x",
    pictures: {
      items: [{ id: "p1", url: "a.png" }],
      count: { value: 1, exact: true },
      ...over,
    },
  });
  for (const over of [{ cursor: "eyJ…" }, { count: { value: 40, exact: false } }])
    assert.throws(
      () => assignableValues("/banners/b1/edit", page(over), { id: "b1", meta: bannerMeta }),
      refusedAt("#/values/pictures"),
    );
  // Whole, it is its records; an exact count above them is a record the form removed.
  assert.deepEqual(
    assignableValues("/b", page({ count: { value: 2, exact: true }, cursor: null }), {
      meta: bannerMeta,
    }),
    { title: "x", pictures: [{ id: "p1", url: "a.png" }] },
  );
  // Inside a line, the refusal points at the line by its id, by its position without one.
  const nested = (line: object) => ({ pictures: [line] });
  const cut = { items: [], cursor: "c" };
  assert.throws(
    () => assignableValues("/b", nested({ id: "p1", tags: cut })),
    refusedAt("#/values/pictures/p1/tags"),
  );
  assert.throws(
    () => assignableValues("/b", nested({ tags: cut })),
    refusedAt("#/values/pictures/0/tags"),
  );
  assert.throws(
    () => assignableValues("/b", { pictures: { items: "p1" } }),
    refusedAt("#/values/pictures"),
  );
});

test("a name the definition does not declare is refused, and values that are no fields too", () => {
  assert.throws(
    () => assignableValues("/b", { title: "x", subtitle: "y" }, { meta: bannerMeta }),
    refusedAt("#/values/subtitle"),
  );
  assert.throws(() => assignableValues("/b", ["title"]), refusedAt("#/values"));
});

test("a memory server's Edit refuses what the real one refuses, and saves what it takes", async () => {
  const rows = [{ id: "b1", version: 1, title: "Rebajas", pictures: [] }];
  const transport = memoryTransport(
    { "/banners": { meta: bannerMeta, rows } },
    {
      handle(_method, route, body) {
        const sent = body as { id: string; values?: Record<string, unknown> };
        const values = assignableValues(route, sent.values, {
          id: sent.id,
          meta: bannerMeta,
        });
        Object.assign(
          rows.find((one) => one.id === sent.id)!,
          values,
        );
      },
    },
  );
  const read = (await transport.one<Record<string, unknown>>("/banners/b1")).record;
  const edit = (values: object) =>
    transport.send("PUT", "/banners/b1/edit", { id: "b1", values, action: "save" });
  // The record whole, as the form read it: its echo and all.
  assert.equal(await edit({ ...read, title: "Liquidación" }), null);
  assert.equal(rows[0]?.title, "Liquidación");
  assert.equal(rows[0]?.version, 1);
  await assert.rejects(edit({ ...read, id: "b2" }), refusedAt("#/values/id"));
});
