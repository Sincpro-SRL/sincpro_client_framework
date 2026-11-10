import assert from "node:assert/strict";

import * as entry from "@sincpro/client-framework";
import { test } from "vitest";

test("the package entry loads in Node, with no browser and no React", () => {
  assert.equal(typeof entry, "object");
  assert.equal("UseBoundedContext" in entry, false);
  assert.equal("ServiceClasses" in entry, false);
  assert.equal(typeof entry.BoundedContext, "function");
  assert.equal("register" in new entry.BoundedContext("entry"), false);
});
