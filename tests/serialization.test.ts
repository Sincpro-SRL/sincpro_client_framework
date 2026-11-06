import assert from "node:assert/strict";

import {
  BYTES,
  Decimal,
  memoryTransport,
  Money,
  pack,
  readValues,
  rebuilt,
  unpack,
  valuesOf,
} from "@sincpro/client-framework";
import { test } from "vitest";

test("a value is written by the wire's rules: decimals as text, instants as ISO, money with its currency", () => {
  assert.deepEqual(
    valuesOf({
      total: new Money("12.50", "BOB"),
      qty: new Decimal("2.500"),
      big: 12n,
      at: new Date(Date.UTC(2026, 9, 2, 7, 53, 21)),
      day: "2026-10-02",
      tags: new Set(["a", "b"]),
      by: new Map([[7, "seven"]]),
      skipped: undefined,
      list: [1, undefined],
    }),
    {
      total: { amount: "12.50", currency: "BOB" },
      qty: "2.500",
      big: "12",
      at: "2026-10-02T07:53:21.000Z",
      day: "2026-10-02",
      tags: ["a", "b"],
      by: { "7": "seven" },
      list: [1, null],
    },
  );
});

test("bytes travel tagged, so binary is never mistaken for text, and come back as bytes", () => {
  const hi = new Uint8Array([104, 105]);
  assert.deepEqual(valuesOf(hi), { [BYTES]: "aGk=" });
  assert.deepEqual(valuesOf(new Uint8Array([0, 1, 2, 253, 254, 255])), {
    [BYTES]: "AAEC/f7/",
  });
  const back = readValues('{"photo":{"$bytes":"aGk="},"note":{"$bytes":"aGk=","x":1}}') as {
    photo: Uint8Array;
    note: Record<string, unknown>;
  };
  assert.deepEqual([...back.photo], [104, 105]);
  // A tag never shares its object: anything beside it, and it is an object.
  assert.deepEqual(back.note, { $bytes: "aGk=", x: 1 });
  const parsed = readValues({ photo: { $bytes: "AAEC/f7/" } }) as { photo: Uint8Array };
  assert.deepEqual([...parsed.photo], [0, 1, 2, 253, 254, 255]);
});

test("what JSON cannot write is refused at once, naming where — never sent as null", () => {
  assert.throws(() => valuesOf({ line: { qty: Number.NaN } }), /value\.line\.qty: NaN/);
  assert.throws(() => valuesOf({ run: () => 1 }), /value\.run: a function/);
  const cycle: Record<string, unknown> = {};
  cycle["self"] = cycle;
  assert.throws(() => valuesOf(cycle), /a cycle/);
});

test("a typed read is asked for, never imposed: as it is, as a class that reads itself, or a function", () => {
  const text = pack({ amount: "10.50", currency: "BOB" });
  assert.deepEqual(unpack(text), { amount: "10.50", currency: "BOB" });
  const money = unpack(text, Money);
  assert.ok(money instanceof Money);
  assert.equal(money.amount, "10.50");
  assert.equal(rebuilt("2.5", (value) => new Decimal(String(value))).toString(), "2.5");
  assert.throws(() => unpack('{"amount":"1"}', Money), /without its currency/);
});

test("the in-memory server answers what a real one would: what it was sent, by the wire's rules", async () => {
  let received: unknown;
  const transport = memoryTransport(
    {},
    {
      handle: (_method, _route, body) => {
        received = body;
        return { ok: true };
      },
    },
  );
  await transport.send("POST", "/orders", {
    total: new Money("12.50", "BOB"),
    at: new Date(Date.UTC(2026, 9, 2)),
  });
  assert.deepEqual(received, {
    total: { amount: "12.50", currency: "BOB" },
    at: "2026-10-02T00:00:00.000Z",
  });
});
