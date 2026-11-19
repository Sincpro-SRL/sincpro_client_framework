import assert from "node:assert/strict";

import {
  allMatching,
  chosen,
  criteriaOf,
  defineMeta,
  field,
  isChosen,
  isEmpty,
  keysOf,
  memoryTransport,
  NOTHING_CHOSEN,
  SelectionTooLarge,
  sizeOf,
  toggled,
} from "@sincpro/client-framework";
import type { Criteria, Expression } from "@sincpro/criteria";
import { test } from "vitest";

const contactMeta = defineMeta({
  aggregate: "Contact",
  identity: "id",
  display: "name",
  fields: { id: field.text(), name: field.text(), company: field.text() },
});

/** Contacts of two companies: 5 of SINCPRO, 3 of ACME. */
function contacts() {
  const rows = [
    ...Array.from({ length: 5 }, (_, i) => ({
      id: `S-${i + 1}`,
      name: `S ${i + 1}`,
      company: "SINCPRO",
    })),
    ...Array.from({ length: 3 }, (_, i) => ({
      id: `A-${i + 1}`,
      name: `A ${i + 1}`,
      company: "ACME",
    })),
  ];
  const asked: Criteria[] = [];
  const transport = memoryTransport(
    { "/contacts": { meta: contactMeta, rows } },
    { observe: (_route, criteria) => void asked.push(criteria) },
  );
  return { transport, asked };
}

const ofSincpro: Expression = { field: "company", operator: "=", value: "SINCPRO" };

test("keys chosen are each chosen once, in order, and ticking flips one", () => {
  const two = chosen(["S-1", "S-2", "S-1"]);
  assert.deepEqual(two.keys, ["S-1", "S-2"]);
  assert.equal(isChosen(two, "S-2"), true);
  assert.deepEqual(toggled(two, "S-2"), chosen(["S-1"]));
  assert.deepEqual(toggled(two, "S-3"), chosen(["S-1", "S-2", "S-3"]));
  assert.equal(isEmpty(NOTHING_CHOSEN), true);
  // A value: the selection it came from is as it was.
  assert.deepEqual(two.keys, ["S-1", "S-2"]);
});

test("«all that match» counts what the server counted, and an unticked one is an exception", () => {
  const all = allMatching(ofSincpro, 5);
  assert.equal(sizeOf(all), 5);
  const butOne = toggled(all, "S-3");
  assert.equal(isChosen(butOne, "S-3"), false);
  assert.equal(isChosen(butOne, "S-4"), true);
  assert.equal(sizeOf(butOne), 4);
  // Ticked again, it is one of all again.
  assert.equal(sizeOf(toggled(butOne, "S-3")), 5);
  // Without a count it is not known to be empty.
  assert.equal(sizeOf(allMatching(ofSincpro)), null);
  assert.equal(isEmpty(allMatching(ofSincpro)), false);
});

test("the question for exactly the chosen records, in both forms", () => {
  assert.deepEqual(criteriaOf(chosen(["S-1", "S-2"]), "id"), {
    field: "id",
    operator: "in",
    value: ["S-1", "S-2"],
  });
  assert.equal(criteriaOf(allMatching(ofSincpro), "id"), ofSincpro);
  assert.deepEqual(criteriaOf(toggled(allMatching(ofSincpro), "S-3"), "id"), {
    all: [ofSincpro, { field: "id", operator: "not in", value: ["S-3"] }],
  });
  // Every record but one: no question, the exception alone.
  assert.deepEqual(criteriaOf(toggled(allMatching(undefined), "S-3"), "id"), {
    field: "id",
    operator: "not in",
    value: ["S-3"],
  });
});

test("the keys of «all that match» are read as one page of references, the exceptions left out", async () => {
  const { transport, asked } = contacts();
  const keys = await keysOf(toggled(allMatching(ofSincpro, 5), "S-3"), {
    transport,
    route: "/contacts",
    identity: "id",
    limit: 10,
  });
  assert.deepEqual([...keys].sort(), ["S-1", "S-2", "S-4", "S-5"]);
  assert.equal(asked.length, 1);
  assert.equal(asked[0]?.pagination?.limit, 11);
  assert.deepEqual(asked[0]?.specification, { id: {} });
});

test("keys in hand are the answer: nothing is read", async () => {
  const { transport, asked } = contacts();
  const keys = await keysOf(chosen(["A-2", "S-1"]), {
    transport,
    route: "/contacts",
    identity: "id",
    limit: 10,
  });
  assert.deepEqual(keys, ["A-2", "S-1"]);
  assert.equal(asked.length, 0);
});

test("past the ceiling a selection is refused, never cut: counted before reading, else by reading one more", async () => {
  const { transport, asked } = contacts();
  const options = { transport, route: "/contacts", identity: "id", limit: 4 };
  // Counted: refused before anything is read.
  await assert.rejects(keysOf(allMatching(ofSincpro, 5), options), (error: unknown) => {
    assert.ok(error instanceof SelectionTooLarge);
    assert.equal(error.size, 5);
    return true;
  });
  assert.equal(asked.length, 0);
  // Not counted: the one more than the ceiling says it.
  await assert.rejects(keysOf(allMatching(ofSincpro), options), SelectionTooLarge);
  assert.equal(asked.length, 1);
  // Declared `invalid`: a caller narrows the question.
  assert.equal(SelectionTooLarge.failureKind, "invalid");
});
