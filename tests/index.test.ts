import assert from "node:assert/strict";

import * as entry from "@sincpro/client-framework";
import { test } from "vitest";

test("the package entry loads in Node, with no browser and no React", () => {
  assert.equal(typeof entry, "object");
});
