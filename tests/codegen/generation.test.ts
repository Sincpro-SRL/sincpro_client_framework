import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { type ClientContract, memoryTransport, metasOf } from "@sincpro/client-framework";
import {
  clientFileOf,
  domainFileOf,
  entitiesFileOf,
  type Metamodel,
  type Operation,
} from "@sincpro/client-framework/codegen";
import { test } from "vitest";

import { clientOf } from "../support/forge-contract/project/client";
import type { CommandSendIssue, Issue } from "../support/forge-contract/project/domain";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const forge = (context: string) =>
  JSON.parse(read(`../support/forge-contract/${context}.contract.json`)) as Metamodel;

/** The same JSON with every object's keys in reverse order. */
function reversed(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reversed);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, one]) => [key, reversed(one)]),
  );
}

function operation(over: Partial<Operation>): Operation {
  return {
    role: "command",
    query: false,
    entities: [],
    targets: {},
    dry_run: false,
    description: null,
    input: { type: "object", properties: {} },
    output: null,
    ...over,
  };
}

const order = { $ref: "#/models/Order" };

/** A small context with every case: a page, a record, an edit, a write on a record, one that
 *  creates, a GET no transport reads, a model with two searches, and a value a record holds. */
const shop: Metamodel = {
  format: "sincpro.client-contract/1",
  bounded_context: "shop",
  alias: "shop",
  version: "v1",
  models: {
    Order: {
      type: "object",
      required: [],
      "x-sincpro": { identity: "id" },
      properties: {
        id: { type: "string", "x-sincpro": { type: "text" } },
        state: { type: "string", enum: ["draft", "paid"], "x-sincpro": { type: "text" } },
        note: {
          anyOf: [{ type: "string" }, { type: "null" }],
          "x-sincpro": { type: "text" },
        },
        customer_id: {
          type: "string",
          description: "Who pays it.",
          "x-sincpro": { type: "text", relation: "crm.Customer" },
        },
        lines: {
          type: "object",
          properties: {
            items: { type: "array", items: { $ref: "#/$defs/Line" } },
            count: { type: "integer" },
            cursor: { anyOf: [{ type: "string" }, { type: "null" }] },
          },
          "x-sincpro": { type: "one2many", relation: "Line" },
        },
        delivery: { $ref: "#/models/Address", "x-sincpro": { type: "embedded" } },
      },
    },
    Line: {
      type: "object",
      "x-sincpro": { identity: "id" },
      properties: { qty: { type: "integer", "x-sincpro": { type: "integer" } } },
    },
    Address: {
      type: "object",
      required: [],
      properties: {
        street: { type: "string", "x-sincpro": { type: "text" } },
        city: { type: "string", "x-sincpro": { type: "text" } },
      },
    },
  },
  operations: {
    "shop.QueryListOrders": operation({
      role: "search",
      query: true,
      entities: ["Order"],
      description: "The orders.",
      input: {
        type: "object",
        properties: {
          criteria: { $ref: "#/$defs/Criteria" },
          customer_id: { type: "string" },
        },
      },
      output: {
        type: "object",
        required: ["orders"],
        properties: { orders: { type: "array", items: order } },
      },
    }),
    "shop.QueryGetOrder": operation({
      role: "get",
      query: true,
      entities: ["Order"],
      targets: { Order: "id" },
      input: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
      output: { type: "object", properties: { order } },
    }),
    "shop.CommandEditOrder": operation({
      role: "edit",
      entities: ["Order"],
      targets: { Order: "id" },
      input: {
        type: "object",
        required: ["id", "values"],
        properties: { id: { type: "string" }, values: order },
      },
    }),
    "shop.CommandPayOrder": operation({
      entities: ["Order"],
      targets: { Order: "order_id" },
      dry_run: true,
      deprecated: true,
      sunset: "2027-01-01",
      replacement: "shop.CommandSettleOrder",
      input: {
        type: "object",
        required: ["order_id"],
        properties: { order_id: { type: "string" }, amount: { $ref: "#/$defs/Money" } },
      },
      output: { type: "null" },
    }),
    "shop.CommandPlaceOrder": operation({
      entities: ["Order"],
      input: {
        type: "object",
        required: ["customer_id"],
        properties: { customer_id: { type: "string" } },
      },
    }),
    "shop.QueryGetCaller": operation({ query: true }),
    "shop.QueryListLines": operation({ role: "search", query: true, entities: ["Line"] }),
    "shop.QueryLookupLines": operation({ role: "search", query: true, entities: ["Line"] }),
  },
  $defs: {
    Criteria: { type: "object" },
    Money: {
      type: "object",
      required: ["amount"],
      properties: { amount: { type: "number" }, currency: { type: "string" } },
    },
    Unused: { type: "object" },
  },
  bindings: {
    rest: {
      "shop.QueryListOrders": { method: "GET", path: "/v1/orders", path_fields: [] },
      "shop.QueryGetOrder": { method: "GET", path: "/v1/orders/{id}", path_fields: ["id"] },
      "shop.CommandEditOrder": {
        method: "PUT",
        path: "/v1/orders/{id}/edit",
        path_fields: ["id"],
      },
      "shop.CommandPayOrder": {
        method: "POST",
        path: "/v1/orders/{order_id}/payments",
        path_fields: ["order_id"],
      },
      "shop.CommandPlaceOrder": { method: "POST", path: "/v1/orders", path_fields: [] },
      "shop.QueryGetCaller": { method: "GET", path: "/v1/me", path_fields: [] },
      "shop.QueryListLines": { method: "GET", path: "/v1/lines", path_fields: [] },
      "shop.QueryLookupLines": { method: "GET", path: "/v1/lines/lookup", path_fields: [] },
    },
    mcp: { "shop.CommandPayOrder": { tool: "pay_order" } },
  },
};

const options = { base: "/v1" };

// Never called: the generated files are the compiler's to check (`make typecheck`). How a
// platform's hooks take a generated entity is that platform's to prove.
function useForgeAsGenerated(issue: Issue) {
  const status: "idle" | "running" | "stopped" | "finished" | "failed" = issue.status;
  // @ts-expect-error — an issue's status is one of the words the server publishes
  const wrong: Issue["status"] = "closed";
  const sent: CommandSendIssue = { issue_id: "i1", message: "y el reporte también" };
  // @ts-expect-error — sending an issue needs its message
  const missing: CommandSendIssue = { issue_id: "i1" };

  const client = clientOf(memoryTransport({}));
  void client.sendIssue({ issue_id: "i1", message: "y el reporte también" });
  // @ts-expect-error — the client takes the Command whole: its key goes in the body
  void client.sendIssue({ message: "y el reporte también" });
  return [status, wrong, sent, missing];
}

test("forge's contexts are written as the committed files, byte for byte", () => {
  for (const context of ["project", "auth", "sandbox"]) {
    const contract = forge(context);
    const written = { domain: domainFileOf(contract) } as Record<string, string>;
    written["client"] = clientFileOf(contract, { domain: context, base: "/v1" });
    written["entities"] = entitiesFileOf(contract, { domain: context, base: "/v1" });
    for (const [file, source] of Object.entries(written))
      assert.equal(
        source,
        read(`../support/forge-contract/${context}/${file}.ts`),
        `${context}/${file}.ts: the generator changed; if on purpose, make codegen-fixtures`,
      );
  }
});

test("the same contract with its keys in another order is the same files", () => {
  const contract = forge("project");
  const shuffled = reversed(contract) as Metamodel;
  const at = { domain: "project", base: "/v1" };
  assert.equal(domainFileOf(shuffled), domainFileOf(contract));
  assert.equal(clientFileOf(shuffled, at), clientFileOf(contract, at));
  assert.equal(entitiesFileOf(shuffled, at), entitiesFileOf(contract, at));
});

test("a record brings every field but a related one, which comes when the read expands it", () => {
  const source = domainFileOf(shop);
  assert.match(source, /export type Order = \{\n {2}\/\*\*\n {3}\* Who pays it\./);
  assert.ok(source.includes("  id: string;\n"));
  assert.ok(source.includes('  state: "draft" | "paid";\n'));
  assert.ok(source.includes("  note: string | null;\n"));
  // A to-many is a page of its records, as the read answers it.
  assert.ok(source.includes("  lines?: EntityCollection<Line>;\n"));
  assert.ok(
    source.includes('import type { EntityCollection } from "@sincpro/client-framework";'),
  );
  assert.ok(
    source.includes("   * The key of a `crm.Customer`.\n   */\n  customer_id: string;"),
  );
});

test("an operation's input requires what its DTO requires, and its answer is its own type", () => {
  const source = domainFileOf(shop);
  assert.ok(
    source.includes(
      "export type CommandPayOrder = {\n  amount?: Money;\n  order_id: string;\n};",
    ),
  );
  assert.ok(source.includes("export type CommandPayOrderAnswer = null;"));
  assert.ok(
    source.includes(
      "`command` of `Order` · may run dry · its record: `Order` in `order_id`.",
    ),
  );
  assert.ok(source.includes("The orders.\n *\n * `search` of `Order` · reads only."));
  assert.ok(
    source.includes(
      "@deprecated It stops being served on 2027-01-01. Use `CommandSettleOrder`.",
    ),
  );
});

test("a model a caller sends is its Input: what the contract requires, the server fills the rest", () => {
  const source = domainFileOf(forge("project"));
  // A read answers the specification whole; registering a project sends what it chooses.
  assert.ok(source.includes("  specification: ProjectSpecification;\n"));
  assert.ok(source.includes("  specification?: ProjectSpecificationInput;\n"));
  assert.ok(
    source.includes("export type ProjectSpecificationInput = {\n  agent_binary?: string;"),
  );
  // A model inside one is its Input too.
  assert.ok(source.includes("  preparation?: ProjectPreparationInput;\n"));
});

test("a record's events (DomainEvents) are its entity's history, read by its key", () => {
  const project = entitiesFileOf(forge("project"), options);
  assert.ok(project.includes('  history: "/issues/{id}/events",'));
  assert.ok(project.includes('  history: "/projects/{id}/events",'));
  assert.ok(
    entitiesFileOf(forge("auth"), options).includes('  history: "/tenants/{id}/events",'),
  );
});

test("criteria is imported from its package, and only the definitions something reaches are written", () => {
  const source = domainFileOf(shop);
  assert.ok(source.includes('import type { Criteria } from "@sincpro/criteria";'));
  assert.ok(source.includes("  criteria?: Criteria;\n"));
  assert.ok(!source.includes("export type Criteria"));
  assert.ok(
    source.includes("export type Money = {\n  amount: number;\n  currency?: string;\n};"),
  );
  assert.ok(!source.includes("Unused"));
  assert.ok(source.includes("export type Line = {"));
});

test("a page is listed, a record is read, a write is sent — under the base the transport adds", () => {
  const source = clientFileOf(shop, options);
  assert.ok(
    source.includes(
      'listOrders: (criteria: Criteria<dto.Order>, params?: Partial<Record<"customer_id", string>>) =>\n      transport.list<dto.Order>(listRoute("/orders", params), criteria),',
    ),
  );
  assert.ok(
    source.includes(
      "getOrder: (id: string) =>\n      transport.one<dto.Order>(`/orders/${encodeURIComponent(id)}`),",
    ),
  );
  assert.ok(source.includes('  payOrder: writeRoute("POST /orders/{order_id}/payments"),'));
  assert.ok(source.includes("pathFor(routes.payOrder, undefined, body),"));
  assert.ok(
    source.includes(
      "pathFor(routes.editOrder, body.id === undefined ? undefined : String(body.id), body),",
    ),
  );
  assert.ok(source.includes('targets: { Order: "order_id" },'));
  assert.ok(source.includes('mcp: { tool: "pay_order" },'));
});

test("a GET that is no page and no record is read as it answers", () => {
  const source = clientFileOf(shop, options);
  assert.ok(
    source.includes(
      'getCaller: () =>\n      readRoute<dto.QueryGetCallerAnswer>(transport, "/me"),',
    ),
  );
  assert.ok(
    source.includes("import { bindable, listRoute, pathFor, readRoute, type SendOptions"),
  );
});

test("a list under a record asks for its key; the rest of its fields are optional", () => {
  const members: Metamodel = {
    ...shop,
    operations: {
      ...shop.operations,
      "shop.QueryListOrders": {
        ...shop.operations["shop.QueryListOrders"]!,
        input: {
          type: "object",
          properties: {
            criteria: { $ref: "#/$defs/Criteria" },
            customer_id: { type: "string" },
            state: { type: "string" },
          },
        },
      },
    },
    bindings: {
      rest: {
        ...shop.bindings!.rest,
        "shop.QueryListOrders": {
          method: "GET",
          path: "/v1/customers/{customer_id}/orders",
          path_fields: ["customer_id"],
        },
      },
    },
  };
  assert.ok(
    clientFileOf(members, options).includes(
      'listOrders: (criteria: Criteria<dto.Order>, params: Readonly<Record<"customer_id", string>> & Partial<Record<"state", string>>) =>\n      transport.list<dto.Order>(listRoute("/customers/{customer_id}/orders", params), criteria),',
    ),
  );
  assert.ok(
    entitiesFileOf(members, options).includes('  list: "/customers/{customer_id}/orders",'),
  );
});

test("what REST does not publish gets no method, and the client says why", () => {
  const mcpOnly: Metamodel = {
    ...shop,
    operations: { ...shop.operations, "shop.CommandRecount": operation({}) },
  };
  assert.ok(
    clientFileOf(mcpOnly, options).includes(
      " * - `CommandRecount`: REST does not publish it.",
    ),
  );
});

test("a path outside the base is refused, never sent half-right", () => {
  assert.throws(
    () => clientFileOf(shop, { base: "/v2" }),
    /shop\.CommandEditOrder is at \/v1\/orders\/\{id\}\/edit, outside the base \/v2/,
  );
});

test("an entity's routes come from what each operation is for it", () => {
  const source = entitiesFileOf(shop, { ...options, domain: "tienda" });
  // The edit is the record's `edit`, never one of its Commands.
  assert.ok(!source.includes("editOrder"));
  assert.ok(
    source.includes(
      '>("tienda:order", {\n  list: "/orders",\n  one: "/orders/{id}",\n  edit: "PUT /orders/{id}/edit",',
    ),
  );
  assert.ok(source.includes('    payOrder: Omit<dto.CommandPayOrder, "order_id">;'));
  assert.ok(source.includes("    placeOrder: dto.CommandPlaceOrder;"));
  assert.ok(source.includes("    payOrder: dto.CommandPayOrderAnswer;"));
  assert.ok(
    source.includes(
      '    payOrder: { route: "POST /orders/{order_id}/payments", target: "order_id" },',
    ),
  );
  assert.ok(source.includes('    placeOrder: "POST /orders",'));
  assert.ok(source.includes("export const entities = [orders] as const;"));
});

test("an entity edited through `Edit` reads its record with the caller's draft; one without, as it is", () => {
  const drafted = (over: Partial<Metamodel>): Metamodel => ({
    ...shop,
    ...over,
    operations: {
      ...shop.operations,
      "shop.QueryGetOrder": {
        ...shop.operations["shop.QueryGetOrder"]!,
        input: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" }, draft: { type: "boolean" } },
        },
      },
      ...over.operations,
    },
  });
  assert.ok(
    entitiesFileOf(drafted({}), options).includes('  one: "/orders/{id}?draft=true",'),
  );
  // No `Edit`: no draft is kept, so none is asked for.
  const { "shop.CommandEditOrder": _edit, ...withoutEdit } = drafted({}).operations;
  const source = entitiesFileOf({ ...drafted({}), operations: withoutEdit }, options);
  assert.ok(source.includes('  one: "/orders/{id}",'));
  assert.ok(!source.includes("draft=true"));
});

test("a value a record holds is a named type, never an entity nor a preloaded definition", () => {
  const domain = domainFileOf(shop);
  assert.ok(domain.includes("  delivery: Address;\n"));
  assert.ok(
    domain.includes("export type Address = {\n  city: string;\n  street: string;\n};"),
  );
  const entities = entitiesFileOf(shop, options);
  assert.ok(!entities.includes("addresses") && !entities.includes("`Address`"));
  assert.deepEqual(Object.keys(metasOf(shop as unknown as ClientContract, "shop")).sort(), [
    "shop:line",
    "shop:order",
  ]);
});

test("a list of keys as a Command's target is the screen's to send: no `target`", () => {
  const archive: Metamodel = {
    ...shop,
    operations: {
      ...shop.operations,
      "shop.CommandArchiveOrders": operation({
        entities: ["Order"],
        targets: { Order: "order_ids" },
        input: {
          type: "object",
          required: ["order_ids"],
          properties: { order_ids: { type: "array", items: { type: "string" } } },
        },
      }),
    },
    bindings: {
      rest: {
        ...shop.bindings!.rest,
        "shop.CommandArchiveOrders": {
          method: "POST",
          path: "/v1/orders/archive",
          path_fields: [],
        },
      },
    },
  };
  const source = entitiesFileOf(archive, options);
  assert.ok(source.includes("    archiveOrders: dto.CommandArchiveOrders;"));
  assert.ok(source.includes('    archiveOrders: "POST /orders/archive",'));
});

test("the context is named by its alias, else by its bounded context; a contract that names neither is refused", () => {
  const aliased: Metamodel = { ...shop, alias: "ventas" };
  assert.ok(domainFileOf(aliased).startsWith("// The DTOs of «ventas» (shop), generated"));
  assert.ok(entitiesFileOf(aliased, options).includes('>("ventas:order", {'));
  const { alias: _, ...own } = shop;
  assert.ok(domainFileOf(own).startsWith("// The DTOs of «shop», generated"));
  const { bounded_context: __, ...nameless } = own;
  assert.throws(() => domainFileOf(nameless), /names no bounded context/);
});

test("two searches for one model and none `own`: no entity, and the file says which", () => {
  assert.ok(
    entitiesFileOf(shop, options).includes(
      " * - `Line`: 2 of role `search` (`QueryListLines`, `QueryLookupLines`) and none `own`.",
    ),
  );
  const owned: Metamodel = {
    ...shop,
    operations: {
      ...shop.operations,
      "shop.QueryListLines": { ...shop.operations["shop.QueryListLines"]!, own: true },
    },
  };
  assert.ok(
    entitiesFileOf(owned, options).includes(
      'export const lines = entity<dto.Line>("shop:line", {\n  list: "/lines",\n});',
    ),
  );
});

test("two things with one TypeScript name are refused, naming both", () => {
  const types: Metamodel = {
    ...shop,
    models: { ...shop.models, QueryListOrders: { type: "object", properties: {} } },
  };
  assert.throws(
    () => domainFileOf(types),
    /operation shop\.QueryListOrders and model QueryListOrders are both "QueryListOrders"/,
  );
  const methods: Metamodel = {
    ...shop,
    operations: { ...shop.operations, "shop.QueryPayOrder": operation({}) },
    bindings: {
      rest: {
        ...shop.bindings!.rest,
        "shop.QueryPayOrder": { method: "POST", path: "/v1/pay", path_fields: [] },
      },
    },
  };
  assert.throws(
    () => clientFileOf(methods, options),
    /operation shop\.QueryPayOrder and operation shop\.CommandPayOrder are both "payOrder"/,
  );
});

test("a reference outside the metamodel is refused, never guessed", () => {
  const broken: Metamodel = {
    ...shop,
    operations: {
      "shop.CommandPayOrder": operation({ input: { $ref: "#/$defs/Nowhere" } }),
    },
  };
  assert.throws(
    () => domainFileOf(broken),
    /"#\/\$defs\/Nowhere" names no definition of shop/,
  );
});

test("the generated files are checked by the compiler: this file only has to compile", () => {
  assert.equal(typeof useForgeAsGenerated, "function");
});

/** `shop` where the backend named some answers, as pydantic titles a Response DTO. */
function titled(titles: Readonly<Record<string, string>>): Metamodel {
  return {
    ...shop,
    operations: Object.fromEntries(
      Object.entries(shop.operations).map(([identity, one]) => [
        identity,
        titles[identity] === undefined
          ? one
          : {
              ...one,
              output: {
                title: titles[identity],
                type: "object",
                properties: { order_id: { type: "string" } },
              },
            },
      ]),
    ),
  };
}

test("an answer goes by the backend's own name, never under a second one", () => {
  const named = titled({ "shop.CommandPlaceOrder": "ResponsePlaceOrder" });
  const domain = domainFileOf(named);
  assert.ok(domain.includes("export type ResponsePlaceOrder = {\n  order_id?: string;\n};"));
  assert.ok(!domain.includes("CommandPlaceOrderAnswer"));
  assert.ok(
    entitiesFileOf(named, options).includes("    placeOrder: dto.ResponsePlaceOrder;"),
  );
  assert.ok(clientFileOf(named, options).includes("transport.send<dto.ResponsePlaceOrder>("));
  // Without a name of its own, as before.
  assert.ok(domain.includes("export type CommandPayOrderAnswer = null;"));
});

test("a Response two Commands answer with is one type, written once; a name two shapes share is nobody's", () => {
  const shared = titled({
    "shop.CommandPlaceOrder": "ResponseOrder",
    "shop.CommandPayOrder": "ResponseOrder",
  });
  const domain = domainFileOf(shared);
  assert.equal(domain.split("export type ResponseOrder = {").length - 1, 1);
  assert.ok(!domain.includes("CommandPlaceOrderAnswer"));
  assert.ok(!domain.includes("CommandPayOrderAnswer"));
  // Two different shapes under one title are two types: neither takes the name.
  const differ: Metamodel = {
    ...shared,
    operations: {
      ...shared.operations,
      "shop.CommandPayOrder": {
        ...shared.operations["shop.CommandPayOrder"]!,
        output: {
          title: "ResponseOrder",
          type: "object",
          properties: { paid: { type: "boolean" } },
        },
      },
    },
  };
  const two = domainFileOf(differ);
  assert.ok(!two.includes("export type ResponseOrder"));
  assert.ok(two.includes("export type CommandPlaceOrderAnswer = {"));
  // A name another type has is not taken either.
  const clash = domainFileOf(titled({ "shop.CommandPlaceOrder": "Order" }));
  assert.ok(clash.includes("export type CommandPlaceOrderAnswer = {"));
});

/** A context whose relation is published as the collection a read answers, and whose orders
 *  are exported: what sincpro_framework 3.33 writes. */
const ledger: Metamodel = {
  format: "sincpro.client-contract/1",
  bounded_context: "ledger",
  alias: "ledger",
  version: "v1",
  models: {
    Account: {
      type: "object",
      "x-sincpro": { identity: "id" },
      properties: {
        id: { type: "string", "x-sincpro": { type: "text" } },
        entries: {
          type: "object",
          properties: {
            items: { type: "array", items: { $ref: "#/$defs/Entry" } },
            count: { anyOf: [{ $ref: "#/$defs/Count" }, { type: "null" }] },
            cursor: { anyOf: [{ type: "string" }, { type: "null" }] },
          },
          required: ["items"],
          "x-sincpro": { type: "one2many", relation: "Entry", reference: true },
        },
      },
    },
    Entry: {
      type: "object",
      "x-sincpro": { identity: "id" },
      properties: { amount: { type: "string", "x-sincpro": { type: "number" } } },
    },
  },
  operations: {
    "ledger.QueryListEntries": operation({
      role: "search",
      query: true,
      entities: ["Entry"],
    }),
    "ledger.QueryExportEntries": operation({
      role: "export",
      query: true,
      entities: ["Entry"],
      input: {
        type: "object",
        properties: {
          criteria: { $ref: "#/$defs/Criteria" },
          cursor: { anyOf: [{ type: "string" }, { type: "null" }] },
          format: { type: "string", enum: ["parquet", "arrow", "jsonl"] },
        },
      },
      output: {
        type: "object",
        properties: { media_type: { type: "string" }, filename: { type: "string" } },
        "x-sincpro-streamed": ["application/vnd.apache.parquet"],
      },
    }),
  },
  $defs: {
    Criteria: { type: "object" },
    Count: {
      type: "object",
      properties: { value: { type: "integer" }, exact: { type: "boolean" } },
    },
  },
  bindings: {
    rest: {
      "ledger.QueryListEntries": { method: "GET", path: "/v1/entries", path_fields: [] },
      "ledger.QueryExportEntries": {
        method: "GET",
        path: "/v1/entries/export",
        path_fields: [],
      },
    },
  },
};

test("a relation published as a collection is an EntityCollection of its records", () => {
  const source = domainFileOf(ledger);

  assert.ok(source.includes("  entries?: EntityCollection<Entry>;\n"));
  assert.ok(!source.includes("export type Count"));
});

test("an export answers a Download, is downloaded by the client, and is the entity's export", () => {
  const domain = domainFileOf(ledger);
  const client = clientFileOf(ledger, options);
  const entities = entitiesFileOf(ledger, { domain: "ledger", base: "/v1" });

  assert.ok(domain.includes("export type QueryExportEntriesAnswer = Download;"));
  assert.ok(
    domain.includes(
      'import type { Download, EntityCollection } from "@sincpro/client-framework";',
    ),
  );
  assert.ok(
    client.includes(
      "exportEntries: (criteria?: Criteria<dto.Entry>, format?: ExportFormat) =>\n" +
        '      downloadRoute(transport, exportRoute("/entries/export", criteria, format)),',
    ),
  );
  assert.ok(client.includes("downloadRoute, type ExportFormat, exportRoute"));
  assert.ok(entities.includes('  export: "/entries/export",'));
});

test("an export under a record's keys takes them first: a required parameter never follows an optional one", () => {
  const keyed: Metamodel = {
    ...ledger,
    bindings: {
      rest: {
        ...ledger.bindings!.rest,
        "ledger.QueryExportEntries": {
          method: "GET",
          path: "/v1/tenants/{tenant_id}/entries/export",
          path_fields: ["tenant_id"],
        },
      },
    },
  };

  const client = clientFileOf(keyed, options);

  assert.ok(
    client.includes(
      'exportEntries: (params: Readonly<Record<"tenant_id", string>>, criteria?: Criteria<dto.Entry>, format?: ExportFormat) =>',
    ),
    client,
  );
});
