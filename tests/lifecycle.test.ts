import assert from "node:assert/strict";

import {
  entity,
  memoryTransport,
  NEW_PARAM,
  PICK_PARAM,
  restTransport,
  retryKeys,
  startingValuesOf,
  TransportError,
  unanswered,
} from "@sincpro/client-framework";
import { test } from "vitest";

import { servidorVentas } from "./support/servidor";
import { facturas } from "./support/ventas";
test("an entity declares where a new record goes, and the references of «new» and «pick»", () => {
  const invoices = entity("billing:invoice", { list: "/invoices", create: "POST /invoices" });
  assert.deepEqual(invoices.create, { method: "POST", path: "/invoices" });
  assert.deepEqual(invoices.newRef(), {
    domain: "billing",
    kind: "invoice",
    params: { [NEW_PARAM]: "1" },
  });
  assert.deepEqual(invoices.chooserRef().params, { [PICK_PARAM]: "1" });
  assert.equal(entity("a:b", { list: "/b" }).create, undefined);
});

test("a new record's reference carries what it starts with, each value keeping its type", () => {
  const invoices = entity("billing:invoice", { list: "/invoices" });
  const ref = invoices.newRef({ customer_id: "C-004", discount: 5, urgent: true });
  assert.equal(ref.params?.[NEW_PARAM], "1");
  assert.deepEqual(startingValuesOf(ref), {
    customer_id: "C-004",
    discount: 5,
    urgent: true,
  });
  // Nothing to start with is the plain «new»: the same reference as before.
  assert.deepEqual(invoices.newRef({}), invoices.newRef());
  assert.deepEqual(startingValuesOf(invoices.newRef()), {});
});

test("a starting value written by hand in a link is read or ignored, never thrown", () => {
  for (const written of ["{", "[1,2]", "null", '"text"', "3"])
    assert.deepEqual(startingValuesOf({ params: { with: written } }), {});
});

test("a gesture keeps its key while nobody knows what happened, and drops it once answered", () => {
  let n = 0;
  const keys = retryKeys(() => `k${++n}`);
  const first = keys.keyFor({ a: 1 });
  keys.settle(new TypeError("Failed to fetch")); // no answer: it may have run
  assert.equal(keys.keyFor({ a: 1 }), first);
  keys.settle(new TransportError("/x", 502, null)); // a proxy, not the server's word
  assert.equal(keys.keyFor({ a: 1 }), first);
  keys.settle(null); // done
  assert.notEqual(keys.keyFor({ a: 1 }), first);
});

test("a refusal or another body is another gesture, with another key", () => {
  let n = 0;
  const keys = retryKeys(() => `k${++n}`);
  const first = keys.keyFor({ a: 1 });
  keys.settle(new TypeError("Failed to fetch"));
  assert.notEqual(keys.keyFor({ a: 2 }), first); // the body changed
  const second = keys.keyFor({ a: 2 });
  keys.settle(new TransportError("/x", 422, null)); // the server said no: retrying changes nothing
  assert.notEqual(keys.keyFor({ a: 2 }), second);
});

test("only an unanswered failure leaves it unknown whether the Command ran", () => {
  assert.equal(unanswered(new TypeError("x")), true);
  assert.equal(unanswered(new TransportError("/x", null, null)), true);
  assert.equal(unanswered(new TransportError("/x", 503, null)), true);
  assert.equal(unanswered(new TransportError("/x", 409, null)), false);
  assert.equal(
    unanswered(
      new TransportError("/x", 409, {
        kind: "in_progress",
        errors: [],
        extensions: {},
        retryable: true,
        next_step: "retry",
      } as never),
    ),
    true,
  );
});

test("the memory server answers a repeated key with the first answer, without running twice", async () => {
  const servidor = servidorVentas();
  const transport = memoryTransport(servidor.tables, { handle: servidor.handle });
  const create = facturas.create!;
  const body = { customer_id: "C-004" };
  const once = await transport.send(create.method, create.path, body, undefined, {
    idempotencyKey: "k-1",
  });
  const again = await transport.send(create.method, create.path, body, undefined, {
    idempotencyKey: "k-1",
  });
  assert.deepEqual(again, once);
  const other = await transport.send<{ number: string }>(
    create.method,
    create.path,
    body,
    undefined,
    { idempotencyKey: "k-2" },
  );
  assert.notEqual(other.number, (once as { number: string }).number);
});

test("the REST wire sends the key as `Idempotency-Key`, and only on a write", async () => {
  const seen: Headers[] = [];
  const transport = restTransport({
    base: "/v1",
    fetch: async (_url, init) => {
      seen.push(new Headers(init?.headers));
      return new Response("{}", { status: 200 });
    },
  });
  await transport.send("POST", "/facturas", {}, undefined, { idempotencyKey: "abc" });
  await transport.send("POST", "/facturas/preview", {});
  assert.equal(seen[0]?.get("Idempotency-Key"), "abc");
  assert.equal(seen[1]?.get("Idempotency-Key"), null);
});
