import assert from "node:assert/strict";

import type { IDomainEvent, IEntity } from "@sincpro/client-framework/core";
import { test } from "vitest";

test("domain contracts add no queue, mapping or entity implementation", () => {
  class Product implements IEntity {
    constructor(readonly id: string) {}
  }
  class ProductCreated implements IDomainEvent {
    readonly name = "catalog.product.v1.created";
    constructor(
      readonly id: string,
      readonly createdAt: string,
    ) {}
  }
  assert.equal(new Product("p-1").id, "p-1");
  const event = new ProductCreated("e-1", "2026-11-10T00:00:00.000Z");
  assert.equal(event.name, "catalog.product.v1.created");
});
