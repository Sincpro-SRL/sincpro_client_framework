import assert from "node:assert/strict";

import {
  BoundedContext,
  Command,
  configureProcess,
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

import { clientOf, operations } from "../support/forge-contract/project/client";

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
  const answer = await rest.call(list, { customer_id: "c-1", criteria, drafts: false });
  assert.deepEqual(answer, { orders: [], cursor: null });
  const url = new URL(sent[0]?.url ?? "", "https://x");
  assert.equal(url.pathname, "/customers/c-1/orders");
  assert.deepEqual(JSON.parse(url.searchParams.get("criteria") ?? ""), criteria);
  assert.equal(url.searchParams.get("drafts"), "false");
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
