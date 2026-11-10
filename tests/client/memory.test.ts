import assert from "node:assert/strict";

import { memoryTransport, TransportError } from "@sincpro/client-framework";
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
