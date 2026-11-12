/**
 * A write says what it changed: whoever wrote it — a screen over a transport, a use case over its
 * generated client — every reader hears it on one feed.
 */

import assert from "node:assert/strict";

import {
  type Change,
  changeFeed,
  changeOf,
  memoryTransport,
  processChanges,
  restOperations,
  restTransport,
  TransportError,
} from "@sincpro/client-framework";
import { criteria, plain } from "@sincpro/criteria";
import { afterEach, test } from "vitest";

import { VENTAS } from "../support/ventas";

/** Everything `feed` announces from now on, and the way to stop hearing it. */
function heard(feed = processChanges) {
  const changes: Change[] = [];
  const stop = feed.follow((change) => changes.push(change));
  return { changes, stop };
}

const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

test("a write announces how and where it was sent; a read announces nothing", async () => {
  const { changes, stop } = heard();
  stops.push(stop);
  const transport = memoryTransport(VENTAS, { handle: () => ({ ok: true }) });

  await transport.list("/facturas", plain(criteria().limit(1)));
  await transport.send("POST", "/facturas/F-1/confirm", {});

  assert.deepEqual(changes, [{ method: "POST", route: "/facturas/F-1/confirm" }]);
});

test("a preview and a dry run only say what a write WOULD do: nothing is announced", () => {
  assert.equal(changeOf("POST", "/facturas/preview", { lines: [] }), undefined);
  assert.equal(changeOf("POST", "/facturas/preview?draft=true", {}), undefined);
  assert.equal(changeOf("POST", "/facturas/F-1/cancel", { dry_run: true }), undefined);
  assert.deepEqual(changeOf("POST", "/facturas/F-1/cancel", { dry_run: false }), {
    method: "POST",
    route: "/facturas/F-1/cancel",
  });
});

test("a refused write is announced too: someone else may have changed it", async () => {
  const { changes, stop } = heard();
  stops.push(stop);
  const transport = memoryTransport(VENTAS); // no `handle`: every Command is a 404

  await assert.rejects(transport.send("PUT", "/facturas/F-1", {}), TransportError);

  assert.deepEqual(changes, [{ method: "PUT", route: "/facturas/F-1" }]);
});

test("a use case's client over REST announces as a screen's transport does", async () => {
  const { changes, stop } = heard();
  stops.push(stop);
  const fetched = (async () => new Response("{}", { status: 200 })) as typeof fetch;
  const operations = restOperations(restTransport({ base: "/v1", fetch: fetched }));

  await operations.call(
    {
      identity: "shop.CommandPayOrder",
      role: "command",
      query: false,
      entities: ["Order"],
      targets: { Order: "order_id" },
      rest: { method: "POST", path: "/orders/{order_id}/pay" },
    },
    { order_id: "O-7" },
  );

  assert.deepEqual(changes, [{ method: "POST", route: "/orders/O-7/pay" }]);
});

test("a transport given its own feed announces there, not to the process's", async () => {
  const own = changeFeed();
  const mine = heard(own);
  const process = heard();
  stops.push(mine.stop, process.stop);
  const transport = memoryTransport(VENTAS, { handle: () => ({}), changes: own });

  await transport.send("POST", "/facturas", {});

  assert.equal(mine.changes.length, 1);
  assert.equal(process.changes.length, 0);
});

test("a listener that fails is ignored: the others hear it, and the write keeps its answer", async () => {
  const feed = changeFeed();
  const { changes, stop } = heard(feed);
  stops.push(stop);
  stops.push(
    feed.follow(() => {
      throw new Error("a broken reader");
    }),
  );
  const transport = memoryTransport(VENTAS, { handle: () => ({ id: "F-9" }), changes: feed });

  assert.deepEqual(await transport.send("POST", "/facturas", {}), { id: "F-9" });
  assert.equal(changes.length, 1);
});

test("a listener hears only what is announced while it follows", () => {
  const feed = changeFeed();
  feed.announce({ method: "POST", route: "/before" });
  const { changes, stop } = heard(feed);
  feed.announce({ method: "POST", route: "/during" });
  stop();
  feed.announce({ method: "POST", route: "/after" });

  assert.deepEqual(
    changes.map((one) => one.route),
    ["/during"],
  );
});
