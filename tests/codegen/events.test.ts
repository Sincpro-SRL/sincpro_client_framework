import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  clientFileOf,
  domainFileOf,
  type Metamodel,
} from "@sincpro/client-framework/codegen";
import ts from "typescript";
import { test } from "vitest";

/** A contract exported with its events (`export-client-contract --events`). */
const shop: Metamodel = {
  bounded_context: "shop",
  version: "1",
  models: {
    Order: {
      type: "object",
      "x-sincpro": { identity: "id" },
      properties: { id: { type: "string" } },
      required: ["id"],
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
        properties: { order_id: { type: "string" } },
        required: ["order_id"],
      },
      output: null,
    },
  },
  $defs: {
    Money: {
      type: "object",
      properties: { amount: { type: "string" }, currency: { type: "string" } },
      required: ["amount", "currency"],
    },
  },
  events: {
    "shop.order.v1.paid": {
      title: "OrderPaid",
      description: "An order was paid in full.",
      recorded: true,
      handled: false,
      schema: {
        type: "object",
        title: "OrderPaid",
        properties: {
          name: { const: "shop.order.v1.paid", type: "string" },
          id: { type: "string" },
          created_at: { type: "string", format: "date-time" },
          correlation_id: { anyOf: [{ type: "string" }, { type: "null" }] },
          order_id: { type: "string" },
          amount: { $ref: "#/$defs/Money" },
        },
        required: ["name", "order_id", "amount"],
      },
    },
    "billing.invoice.v1.voided": {
      title: "InvoiceVoided",
      description: null,
      recorded: false,
      handled: true,
      schema: {
        type: "object",
        title: "InvoiceVoided",
        properties: {
          name: { const: "billing.invoice.v1.voided", type: "string" },
          id: { type: "string" },
          invoice_id: { type: "string" },
        },
        required: ["name", "invoice_id"],
      },
    },
  },
  bindings: {
    rest: {
      "shop.CommandPayOrder": {
        method: "POST",
        path: "/orders/{order_id}/pay",
        path_fields: ["order_id"],
      },
    },
  },
};

test("each event is a type as it is received: every field there, its wire name a literal", () => {
  const source = domainFileOf(shop);
  assert.ok(
    source.includes(
      [
        "/**",
        " * An order was paid in full.",
        " *",
        " * `shop.order.v1.paid` on the wire · recorded by «shop».",
        " */",
        "export type OrderPaid = {",
        "  amount: Money;",
        "  correlation_id: string | null;",
        "  created_at: string;",
        "  id: string;",
        '  name: "shop.order.v1.paid";',
        "  order_id: string;",
        "};",
      ].join("\n"),
    ),
  );
  assert.ok(
    source.includes(
      "/** `billing.invoice.v1.voided` on the wire · handled by «shop». */\nexport type InvoiceVoided = {",
    ),
  );
  // What an event reaches is written once, beside the models.
  assert.ok(
    source.includes("export type Money = {\n  amount: string;\n  currency: string;\n};"),
  );
});

test("DomainEvent is the union of every event, in the order of their wire names", () => {
  assert.ok(
    domainFileOf(shop).endsWith(
      "/** Every domain event of «shop» in the contract: a `switch` on `name` tells which. */\nexport type DomainEvent =\n  | InvoiceVoided\n  | OrderPaid;\n",
    ),
  );
});

test("the client holds every event as data: its wire name, and who records or handles it", () => {
  assert.ok(
    clientFileOf(shop).includes(
      [
        "export const events = {",
        '  InvoiceVoided: { name: "billing.invoice.v1.voided", recorded: false, handled: true },',
        '  OrderPaid: { name: "shop.order.v1.paid", recorded: true, handled: false },',
        "} as const;",
      ].join("\n"),
    ),
  );
});

test("a contract without events writes neither the union nor the data", () => {
  const { events: _, ...plain } = shop;
  assert.equal(domainFileOf(plain).includes("DomainEvent"), false);
  assert.equal(clientFileOf(plain).includes("export const events"), false);
});

test("an event whose class is a model is that model, narrowed to its name", () => {
  const based: Metamodel = {
    ...shop,
    models: {
      ...shop.models,
      ShopEvent: {
        type: "object",
        "x-sincpro": { identity: "id" },
        properties: { id: { type: "string" }, name: { type: "string" } },
      },
    },
    events: {
      ...shop.events,
      ShopEvent: {
        title: "ShopEvent",
        description: null,
        recorded: true,
        handled: true,
        schema: shop.models["Order"]!,
      },
    },
  };
  const source = domainFileOf(based);
  assert.equal(source.match(/export type ShopEvent =/g)?.length, 1);
  assert.ok(source.includes('  | (ShopEvent & { name: "ShopEvent" })\n'));
});

test("two events of one class name are refused, naming both", () => {
  const twice: Metamodel = {
    ...shop,
    events: {
      ...shop.events,
      "shop.order.v2.paid": { ...shop.events!["shop.order.v1.paid"]! },
    },
  };
  assert.throws(
    () => domainFileOf(twice),
    /OrderPaid.*shop\.order\.v1\.paid|shop\.order\.v2\.paid/s,
  );
});

test("what is generated compiles, and a switch on name narrows the union", () => {
  const root = mkdtempSync(join(tmpdir(), "events-"));
  symlinkSync(resolve("node_modules"), join(root, "node_modules"));
  const generated = join(root, "generated");
  mkdirSync(generated);
  writeFileSync(join(generated, "domain.ts"), domainFileOf(shop));
  writeFileSync(join(generated, "client.ts"), clientFileOf(shop));
  writeFileSync(
    join(root, "subscriber.ts"),
    [
      'import { events } from "./generated/client";',
      'import type * as remote from "./generated/domain";',
      "",
      "export function subjectOf(event: remote.DomainEvent): string {",
      "  switch (event.name) {",
      '    case "shop.order.v1.paid":',
      "      return `${event.order_id} ${event.amount.amount}`;",
      '    case "billing.invoice.v1.voided":',
      "      return event.invoice_id;",
      "  }",
      "}",
      "",
      'export const paid: "shop.order.v1.paid" = events.OrderPaid.name;',
      "",
    ].join("\n"),
  );
  const program = ts.createProgram([join(root, "subscriber.ts")], {
    strict: true,
    noEmit: true,
    noImplicitReturns: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
    noUnusedLocals: true,
    baseUrl: resolve("."),
    paths: {
      "@sincpro/client-framework": ["./src/index.ts"],
      "@sincpro/client-framework/*": ["./src/*"],
    },
    typeRoots: [resolve("node_modules/@types")],
    types: [],
  });
  const problems = ts
    .getPreEmitDiagnostics(program)
    .filter((one) => one.file?.fileName.startsWith(root))
    .map((one) => ts.flattenDiagnosticMessageText(one.messageText, "\n"));
  assert.deepEqual(problems, []);
});
