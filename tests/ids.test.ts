import assert from "node:assert/strict";

import { isEntityId, newEntityId } from "@sincpro/client-framework";
import { test } from "vitest";

test("a new record's key is a UUID v7 written as sincpro_framework writes it: 32 hex", () => {
  const id = newEntityId();
  assert.equal(id.length, 32);
  assert.ok(isEntityId(id), id);
  assert.equal(id[12], "7");
  assert.match(id[16]!, /[89ab]/);
});

test("its first 48 bits are the millisecond it was minted in", () => {
  // Ahead of every id minted before it: the clock of these ids never runs backwards.
  const at = Date.now() + 86_400_000;
  assert.equal(parseInt(newEntityId(at).slice(0, 12), 16), at);
});

test("minted in order is sorted in order, in the same millisecond and with the clock moved back", () => {
  const at = Date.UTC(2026, 10, 4, 13, 0, 0);
  const minted = [
    ...Array.from({ length: 50 }, () => newEntityId(at)),
    newEntityId(at - 5_000),
    newEntityId(at + 1),
  ];
  assert.deepEqual([...minted].sort(), minted);
  assert.equal(new Set(minted).size, minted.length);
});

test("a full counter borrows the next millisecond instead of repeating", () => {
  const at = Date.UTC(2026, 10, 4, 14, 0, 0);
  const minted = Array.from({ length: 5_000 }, () => newEntityId(at));
  assert.equal(new Set(minted).size, minted.length);
  assert.deepEqual([...minted].sort(), minted);
});

test("a UUID with dashes, another version or a text key is not one", () => {
  assert.equal(isEntityId("019a4c2e-7f10-74a8-b13f-a739ccbdcd53"), false);
  assert.equal(isEntityId("019a4c2e7f1044a8b13fa739ccbdcd53"), false);
  assert.equal(isEntityId("C-004"), false);
});
