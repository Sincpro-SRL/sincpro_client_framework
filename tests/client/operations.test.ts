import assert from "node:assert/strict";

import {
  BoundedContext,
  Command,
  configureProcess,
  Decimal,
  failureOf,
  Feature,
  JsonRpcError,
  jsonRpcOperations,
  OperationNotPublished,
  type OperationOptions,
  type OperationTransport,
  processContext,
  type RemoteOperation,
  restOperations,
  restTransport,
} from "@sincpro/client-framework";
import { memoryTracer } from "@sincpro/client-framework/testing";
import { beforeEach, test } from "vitest";

import {
  clientOf,
  operations,
} from "../support/forge-contract/project/adapters/generated/client";

type Sent = { url: string; method: string; headers: Headers; body: unknown };

function recording(sent: Sent[], answer: (sent: Sent) => Response): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const one = {
      url: String(url),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    };
    sent.push(one);
    return answer(one);
  }) as typeof fetch;
}

const pay: RemoteOperation = {
  identity: "shop.CommandPayOrder",
  role: "command",
  query: false,
  entities: ["Order"],
  targets: { Order: "order_id" },
  rest: { method: "POST", path: "/orders/{order_id}/payments" },
  rpc: { method: "shop.pay_order" },
};

const list: RemoteOperation = {
  identity: "shop.QueryListOrders",
  role: "search",
  query: true,
  entities: ["Order"],
  targets: {},
  rest: { method: "GET", path: "/customers/{customer_id}/orders" },
};

const exported: RemoteOperation = {
  identity: "shop.QueryExportOrders",
  role: "export",
  query: true,
  entities: ["Order"],
  targets: {},
  streamed: true,
  rest: { method: "GET", path: "/orders/export" },
};

beforeEach(() => configureProcess({ logger: { engine: false } }));

test("REST: a Command's path takes its fields, its body is the input, its key is the gesture's", async () => {
  const sent: Sent[] = [];
  const rest = restOperations(
    restTransport({
      document: null,
      fetch: recording(sent, () => Response.json({ paid: true })),
    }),
  );
  const answer = await rest.call(
    pay,
    { order_id: "o 1", amount: "10.50" },
    {
      idempotencyKey: "k-1",
    },
  );
  assert.deepEqual(answer, { paid: true });
  assert.equal(sent[0]?.method, "POST");
  assert.equal(sent[0]?.url, "/orders/o%201/payments");
  assert.deepEqual(sent[0]?.body, { order_id: "o 1", amount: "10.50" });
  assert.equal(sent[0]?.headers.get("Idempotency-Key"), "k-1");
});

test("REST: a Query sends its other fields as its query — criteria as JSON — and reads the answer as it came", async () => {
  const sent: Sent[] = [];
  const rest = restOperations(
    restTransport({
      document: null,
      fetch: recording(sent, () => Response.json({ orders: [], cursor: null })),
    }),
  );
  const criteria = { where: { state: "paid" } };
  const answer = await rest.call(list, {
    customer_id: "c-1",
    criteria,
    drafts: false,
    above: new Decimal("10.50"),
  });
  assert.deepEqual(answer, { orders: [], cursor: null });
  const url = new URL(sent[0]?.url ?? "", "https://x");
  assert.equal(url.pathname, "/customers/c-1/orders");
  assert.deepEqual(JSON.parse(url.searchParams.get("criteria") ?? ""), criteria);
  assert.equal(url.searchParams.get("drafts"), "false");
  // A value with a wire form of its own goes as that text, never quoted as JSON.
  assert.equal(url.searchParams.get("above"), "10.50");
});

test("REST: what answers bytes is downloaded; what REST does not publish is said, not guessed", async () => {
  const rest = restOperations(
    restTransport({
      document: null,
      fetch: (async () =>
        new Response("a,b\n", {
          headers: {
            "Content-Type": "application/jsonl",
            "Content-Disposition": 'attachment; filename="orders.jsonl"',
          },
        })) as typeof fetch,
    }),
  );
  const download = await rest.call<{ filename: string; mediaType: string }>(exported, {});
  assert.equal(download.filename, "orders.jsonl");
  const { rest: _, ...rpcOnly } = pay;
  const error = await rest.call(rpcOnly, { order_id: "o-1" }).catch((one: unknown) => one);
  assert.ok(error instanceof OperationNotPublished);
  assert.equal(failureOf(error).kind, "not_found");
  await assert.rejects(rest.call(pay, {}), /needs "order_id"/);
});

test("REST: a Command that answers nothing — a DELETE's 204 — resolves `null`, never `undefined`", async () => {
  const remove: RemoteOperation = {
    identity: "shop.CommandRemoveOrder",
    role: "command",
    query: false,
    entities: ["Order"],
    targets: { Order: "id" },
    rest: { method: "DELETE", path: "/orders/{id}" },
  };
  const sent: Sent[] = [];
  const rest = restOperations(
    restTransport({
      document: null,
      fetch: recording(sent, () => new Response(null, { status: 204 })),
    }),
  );
  const answer = await rest.call(remove, { id: "o-1" });
  assert.equal(answer, null);
  assert.equal(sent[0]?.method, "DELETE");
  assert.equal(sent[0]?.url, "/orders/o-1");
});

test("REST: a DELETE is read from its URL — its path takes its key, the rest is its query, and no body", async () => {
  const remove: RemoteOperation = {
    identity: "shop.CommandDeleteOrder",
    role: "delete",
    query: false,
    entities: ["Order"],
    targets: { Order: "id" },
    rest: { method: "DELETE", path: "/orders/{id}" },
  };
  const sent: Sent[] = [];
  const rest = restOperations(
    restTransport({
      document: null,
      fetch: recording(sent, () => new Response(null, { status: 204 })),
    }),
  );
  // A dry run dropped on the way would run the real delete; a stale check dropped, a blind one.
  const answer = await rest.call(remove, { id: "o 1", dry_run: true, origin_version: 3 });
  assert.equal(answer, null);
  assert.equal(sent[0]?.method, "DELETE");
  // The key the path took is not said again in the query.
  assert.equal(sent[0]?.url, "/orders/o%201?dry_run=true&origin_version=3");
  assert.equal(sent[0]?.body, undefined);
});

test("an edit with no key creates under one minted before it leaves; a key the caller names goes as it is", async () => {
  const sent: Sent[] = [];
  const client = clientOf(
    restOperations(
      restTransport({
        document: null,
        fetch: recording(sent, (one) =>
          Response.json({ project: { id: (one.body as { id: string }).id } }),
        ),
      }),
    ),
  );
  // A new record from a custom screen: no key named — the route still needs one in its path.
  await client.editProject({ values: { display_name: "Acme" }, action: "save" });
  const minted = (sent[0]?.body as { id: string }).id;
  assert.match(minted, /^[0-9a-f]{12}7[0-9a-f]{19}$/);
  assert.equal(sent[0]?.method, "PUT");
  assert.equal(sent[0]?.url, `/projects/${minted}/edit`);
  // Each new record gets its own; a stored record, or a form's draft, keeps the key it names.
  await client.editProject();
  assert.notEqual((sent[1]?.body as { id: string }).id, minted);
  await client.editProject({ id: "odoo-acme", values: { display_name: "Acme" } });
  assert.equal(sent[2]?.url, "/projects/odoo-acme/edit");
  assert.deepEqual(sent[2]?.body, { id: "odoo-acme", values: { display_name: "Acme" } });
});

test("JSON-RPC: one POST with the operation's method and its input as named params", async () => {
  const sent: Sent[] = [];
  const rpc = jsonRpcOperations({
    endpoint: "/rpc",
    headers: { Authorization: "Bearer t" },
    fetch: recording(sent, (one) =>
      Response.json({
        jsonrpc: "2.0",
        id: (one.body as { id: number }).id,
        result: { paid: true },
      }),
    ),
  });
  const answer = await rpc.call(pay, { order_id: "o-1" }, { idempotencyKey: "k-2" });
  assert.deepEqual(answer, { paid: true });
  assert.equal(sent[0]?.url, "/rpc");
  assert.deepEqual(
    { ...(sent[0]?.body as object), id: 0 },
    { jsonrpc: "2.0", id: 0, method: "shop.pay_order", params: { order_id: "o-1" } },
  );
  assert.equal(sent[0]?.headers.get("Authorization"), "Bearer t");
  assert.equal(sent[0]?.headers.get("Idempotency-Key"), "k-2");
});

test("JSON-RPC: a failure is read by its Problem, else by its code; no answer may have run", async () => {
  const answering = (error: object): OperationTransport =>
    jsonRpcOperations({
      endpoint: "/rpc",
      fetch: (async () => Response.json({ jsonrpc: "2.0", id: 1, error })) as typeof fetch,
    });
  const conflict = await answering({
    code: -32009,
    message: "the order changed",
    data: {
      kind: "conflict",
      reason: "ORDER_CHANGED",
      next_step: "refresh_and_retry",
      retryable: true,
    },
  })
    .call(pay, { order_id: "o-1" })
    .catch((one: unknown) => one);
  assert.ok(conflict instanceof JsonRpcError);
  assert.deepEqual(
    [failureOf(conflict).kind, failureOf(conflict).reason, failureOf(conflict).nextStep],
    ["conflict", "ORDER_CHANGED", "refresh_and_retry"],
  );
  const bare = await answering({ code: -32004, message: "not found" })
    .call(pay, { order_id: "o-1" })
    .catch((one: unknown) => one);
  assert.equal(failureOf(bare).kind, "not_found");
  const offline = jsonRpcOperations({
    endpoint: "/rpc",
    fetch: (async () => {
      throw new TypeError("Network request failed");
    }) as typeof fetch,
  });
  const unanswered = await offline.call(pay, {}).catch((one: unknown) => one);
  assert.deepEqual(
    [failureOf(unanswered).kind, failureOf(unanswered).fault],
    ["unknown_outcome", true],
  );
  await assert.rejects(offline.call(list, {}), OperationNotPublished);
});

test("the generated client runs over any adapter: it only says which operation, with what input", async () => {
  const called: { operation: string; input: unknown; options?: OperationOptions }[] = [];
  const anyWire: OperationTransport = {
    async call<T>(operation: RemoteOperation, input: unknown, options?: OperationOptions) {
      called.push({ operation: operation.identity, input, ...(options ? { options } : {}) });
      return { issue_id: "acme-3", run_id: "r-1", status: "queued" } as T;
    },
  };
  const client = clientOf(anyWire);
  await client.sendIssue({ issue_id: "acme-3", message: "hola" });
  assert.deepEqual(called[0], {
    operation: operations.CommandSendIssue.identity,
    input: { issue_id: "acme-3", message: "hola" },
  });
});

test("injected in a bounded context, the client carries the run's trace, context and signal on any wire", async () => {
  const tracer = memoryTracer();
  configureProcess({ tracer, logger: { engine: false } });
  processContext.set({ tenant_id: "acme" });
  const seen: OperationOptions[] = [];
  const anyWire: OperationTransport = {
    async call<T>(_operation: RemoteOperation, _input: unknown, options?: OperationOptions) {
      seen.push(options ?? {});
      return {} as T;
    },
  };
  class CommandNotify extends Command<unknown> {}
  class Notify extends Feature<CommandNotify, unknown> {
    declare readonly client: ReturnType<typeof clientOf>;
    execute(): Promise<unknown> {
      return this.client.sendIssue({ issue_id: "acme-3", message: "hola" });
    }
  }
  const project = new BoundedContext<{ client: ReturnType<typeof clientOf> }>("project");
  project.addDependency("client", clientOf(anyWire)).feature(CommandNotify)(Notify);
  const screen = new AbortController();
  await project.execute(new CommandNotify(), { signal: screen.signal });
  const span = tracer.spans[0];
  assert.equal(seen[0]?.headers?.["traceparent"], `00-${span?.traceId}-${span?.spanId}-01`);
  assert.equal(seen[0]?.headers?.["sincpro-context"], '{"tenant_id":"acme"}');
  assert.equal(seen[0]?.signal, screen.signal);
});
