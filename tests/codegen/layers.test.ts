/**
 * What `generate` writes goes in the layer it belongs to: the domain's types apart by kind —
 * entities and value objects, Commands and Responses, domain events — and the adapters beside
 * the application's own.
 */

import assert from "node:assert/strict";

import {
  domainFilesOf,
  generatedFilesOf,
  type Metamodel,
} from "@sincpro/client-framework/codegen";
import { test } from "vitest";

/** An order that holds its money, a payment only a Command sends, a fact only an event carries. */
const shop: Metamodel = {
  format: "sincpro.client-contract/1",
  bounded_context: "shop",
  version: "1",
  models: {
    Order: {
      type: "object",
      "x-sincpro": { identity: "id" },
      properties: {
        id: { type: "string" },
        total: { $ref: "#/$defs/Money" },
      },
    },
  },
  $defs: {
    Money: {
      type: "object",
      required: ["amount", "currency"],
      properties: { amount: { type: "string" }, currency: { type: "string" } },
    },
    Payment: {
      type: "object",
      required: ["method"],
      properties: { method: { type: "string" }, paid: { $ref: "#/$defs/Money" } },
    },
    Receipt: {
      type: "object",
      required: ["number"],
      properties: { number: { type: "string" } },
    },
  },
  operations: {
    "shop.CommandPayOrder": {
      role: "command",
      query: false,
      entities: ["Order"],
      targets: { Order: "order_id" },
      dry_run: false,
      input: {
        type: "object",
        required: ["order_id", "payment"],
        properties: { order_id: { type: "string" }, payment: { $ref: "#/$defs/Payment" } },
      },
      output: {
        title: "ResponsePayOrder",
        type: "object",
        required: ["order"],
        properties: { order: { $ref: "#/models/Order" } },
      },
    },
  },
  events: {
    "shop.order.v1.paid": {
      title: "OrderPaid",
      recorded: true,
      handled: false,
      schema: {
        type: "object",
        properties: {
          name: { const: "shop.order.v1.paid" },
          order_id: { type: "string" },
          receipt: { $ref: "#/$defs/Receipt" },
          paid: { $ref: "#/$defs/Payment" },
        },
      },
    },
  },
  bindings: {
    rest: {
      "shop.CommandPayOrder": {
        method: "POST",
        path: "/v1/orders/{order_id}/pay",
        path_fields: ["order_id"],
      },
    },
  },
};

test("each layer gets its own folder: the domain's types, then the adapters", () => {
  assert.deepEqual(Object.keys(generatedFilesOf(shop, { base: "/v1" })), [
    "domain/generated/models.ts",
    "domain/generated/commands.ts",
    "domain/generated/events.ts",
    "domain/generated/index.ts",
    "adapters/generated/client.ts",
    "adapters/generated/entities.ts",
  ]);
  // A bare metamodel is only a domain: nothing to call, no adapter.
  const { bindings: _, events: __, ...bare } = shop;
  assert.deepEqual(Object.keys(generatedFilesOf(bare)), [
    "domain/generated/models.ts",
    "domain/generated/commands.ts",
    "domain/generated/index.ts",
  ]);
});

test("entities and value objects, Commands and Responses, and events are three files", () => {
  const files = domainFilesOf(shop);
  const models = files["models.ts"]!;
  const commands = files["commands.ts"]!;
  const events = files["events.ts"]!;

  assert.ok(models.includes("export type Order = {"));
  assert.ok(!/export type (Command|Response|OrderPaid|DomainEvent)\b/.test(models));

  assert.ok(commands.includes("export type CommandPayOrder = {"));
  assert.ok(commands.includes("export type ResponsePayOrder = {"));
  assert.ok(!/export type (Order|OrderPaid|DomainEvent) /.test(commands));

  assert.ok(events.includes("export type OrderPaid = {"));
  assert.ok(events.includes("export type DomainEvent =\n  | OrderPaid;"));
  assert.ok(!/export type (Order|CommandPayOrder|ResponsePayOrder) =/.test(events));
});

test("a definition goes with the first kind that names it; another file imports it from there", () => {
  const files = domainFilesOf(shop);

  // Money: an order holds it — the domain's. The Command's Payment names it from there.
  assert.ok(files["models.ts"]!.includes("export type Money = {"));
  // Payment: only a Command sends it — the application layer's. The event that repeats it imports it.
  assert.ok(files["commands.ts"]!.includes("export type Payment = {"));
  // Receipt: only an event carries it.
  assert.ok(files["events.ts"]!.includes("export type Receipt = {"));

  assert.ok(files["commands.ts"]!.includes('import type { Money, Order } from "./models";'));
  assert.ok(files["events.ts"]!.includes('import type { Payment } from "./commands";'));
  assert.ok(!files["models.ts"]!.includes('from "./'));
  for (const name of ["Money", "Payment", "Receipt"]) {
    const written = Object.values(files).filter((one) =>
      one.includes(`export type ${name} = `),
    );
    assert.equal(written.length, 1, `${name} is written once`);
  }
});

test("index re-exports every file there is, and the adapters import the domain from it", () => {
  const files = generatedFilesOf(shop, { base: "/v1" });
  assert.ok(
    files["domain/generated/index.ts"]!.endsWith(
      'export type * from "./models";\nexport type * from "./commands";\nexport type * from "./events";\n',
    ),
  );
  for (const adapter of ["adapters/generated/client.ts", "adapters/generated/entities.ts"])
    assert.ok(
      files[adapter]!.includes('import type * as dto from "../../domain/generated/index";'),
      adapter,
    );
  const { events: _, ...quiet } = shop;
  assert.ok(!domainFilesOf(quiet)["index.ts"]!.includes("./events"));
});

test("a name is claimed once across the files: index puts them side by side", () => {
  // A definition only an event carries, named as an operation: two files, one name.
  const clash: Metamodel = {
    ...shop,
    $defs: { ...shop.$defs, CommandPayOrder: { type: "object", properties: {} } },
    events: {
      "shop.order.v1.paid": {
        ...shop.events!["shop.order.v1.paid"]!,
        schema: {
          type: "object",
          properties: {
            name: { const: "shop.order.v1.paid" },
            asked: { $ref: "#/$defs/CommandPayOrder" },
          },
        },
      },
    },
  };
  assert.throws(
    () => domainFilesOf(clash),
    /definition CommandPayOrder and operation shop\.CommandPayOrder are both "CommandPayOrder"/,
  );
});
