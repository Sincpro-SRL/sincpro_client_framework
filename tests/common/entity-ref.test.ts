import assert from "node:assert/strict";

import {
  type EntityRef,
  entityRefOf,
  isEntityRef,
  parseEntityRef,
} from "@sincpro/client-framework";
import { test } from "vitest";

/** sincpro_framework's `entity_ref.PATTERN`, as the contract publishes it (3.37.0). */
const PATTERN = /^[^:]+\.[A-Za-z_][A-Za-z0-9_]*:.+$/;

test("a ref reads as the backend reads it: the key after the first «:», the entity after the last «.»", () => {
  assert.deepEqual(parseEntityRef("billing.Invoice:01a1e6f2c0b37a4e9b1d2c3e4f5a6b7c"), {
    boundedContext: "billing",
    entity: "Invoice",
    key: "01a1e6f2c0b37a4e9b1d2c3e4f5a6b7c",
  });
  // A key may hold a «:»; a bounded context may hold a «.».
  assert.deepEqual(parseEntityRef("billing.Invoice:F:7"), {
    boundedContext: "billing",
    entity: "Invoice",
    key: "F:7",
  });
  assert.deepEqual(parseEntityRef("acme.billing.Invoice:1.2.3"), {
    boundedContext: "acme.billing",
    entity: "Invoice",
    key: "1.2.3",
  });
});

test("a text that is no ref is refused, saying how one is written", () => {
  for (const text of [
    "Invoice:0192",
    ".Invoice:0192",
    "billing.Invoice:",
    "billing.Invoice",
    "billing.1nvoice:0192",
    "billing.In-voice:0192",
    "billing.:0192",
    "",
  ])
    assert.throws(
      () => parseEntityRef(text),
      /is no entity ref: write bounded_context\.Entity:key/,
      text,
    );
});

test("what is a ref here is what the contract's pattern says is one", () => {
  for (const text of [
    "billing.Invoice:0192",
    "billing.Invoice:F:7",
    "a.b.C_1:x",
    "billing._Draft:1",
    "Invoice:0192",
    ".Invoice:1",
    "billing.Invoice:",
    "billing.1nvoice:1",
    "billing.Factura-x:1",
    "billing:Invoice.x",
    "bil:ling.Invoice:1",
  ])
    assert.equal(isEntityRef(text), PATTERN.test(text), text);
  assert.equal(isEntityRef(42), false);
  assert.equal(isEntityRef(null), false);
});

test("a ref is written as the backend writes it, and reads back as its parts", () => {
  const parts = { boundedContext: "billing", entity: "Invoice", key: "F:7" };
  const ref = entityRefOf(parts);
  assert.equal(ref, "billing.Invoice:F:7");
  assert.deepEqual(parseEntityRef(ref), parts);
  assert.equal(
    entityRefOf({ boundedContext: "acme.billing", entity: "Invoice", key: "1" }),
    "acme.billing.Invoice:1",
  );
});

test("parts that would not read back as themselves write no ref", () => {
  for (const parts of [
    { boundedContext: "bil:ling", entity: "Invoice", key: "1" },
    { boundedContext: "billing", entity: "Billing.Invoice", key: "1" },
    { boundedContext: "billing", entity: "In voice", key: "1" },
    { boundedContext: "", entity: "Invoice", key: "1" },
    { boundedContext: "billing", entity: "Invoice", key: "" },
  ])
    assert.throws(() => entityRefOf(parts), /writes no entity ref/, JSON.stringify(parts));
});

test("a ref is a text typed by its form: a literal in it type-checks, another text does not", () => {
  const ref: EntityRef = "billing.Invoice:0192";
  // @ts-expect-error — no bounded context: not a ref's form.
  const bare: EntityRef = "Invoice:0192";
  const read: unknown = "auth.Member:0193";
  const narrowed: EntityRef[] = isEntityRef(read) ? [read] : [];
  assert.equal(typeof ref, "string");
  assert.equal(typeof bare, "string");
  assert.deepEqual(narrowed, ["auth.Member:0193"]);
});
