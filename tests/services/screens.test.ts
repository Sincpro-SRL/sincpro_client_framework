import assert from "node:assert/strict";

import {
  configureProcess,
  memoryTransport,
  processContext,
  restTransport,
  screensTransport,
  TransportError,
} from "@sincpro/client-framework";
import {
  memoryLogger,
  memoryReporter,
  memoryTracer,
} from "@sincpro/client-framework/testing";
import { beforeEach, test } from "vitest";

type Sent = { url: string; headers: Record<string, string> };

function recording(sent: Sent[]): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    sent.push({ url, headers: { ...(init?.headers as Record<string, string>) } });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
}

beforeEach(() => configureProcess());

test("only direct screen requests use the screen wrapper; plain adapters add no executions", async () => {
  const logger = memoryLogger();
  configureProcess({ logger });
  const raw = memoryTransport({}, { handle: () => ({ ok: true }) });
  await raw.send("POST", "/x", {});
  assert.equal(logger.records.length, 0);
  const screens = screensTransport(raw);
  assert.equal(screensTransport(screens), screens);
  await screens.send("POST", "/x", {});
  assert.equal(logger.records.length, 2);
  assert.ok(logger.records.every((record) => record.useCase === "screens.EntityWrites.send"));
});

test("what a screen reads and writes is a use case of `screens`: traced, its route said, the trace and the context on the request", async () => {
  const sent: Sent[] = [];
  const tracer = memoryTracer();
  configureProcess({ tracer });
  processContext.set({ company_id: 2 });
  const screens = screensTransport(restTransport({ document: null, fetch: recording(sent) }));
  await screens.send("POST", "/issues/acme-3/close", {});
  const [span] = tracer.spans;
  assert.equal(span?.name, "screens/EntityWrites.send");
  assert.equal(span?.attributes["http.route"], "/issues/acme-3/close");
  assert.equal(span?.attributes["http.method"], "POST");
  assert.equal(sent[0]?.headers["traceparent"], `00-${span?.traceId}-${span?.spanId}-01`);
  assert.equal(sent[0]?.headers["sincpro-context"], '{"company_id":2}');
});

test("a screen's read that breaks is reported once, as the use case it was; a refusal is the screen's to show", async () => {
  const reporter = memoryReporter();
  const tracer = memoryTracer();
  configureProcess({ tracer, reporter });
  const broken = new TypeError("the server is down");
  const screens = screensTransport(
    memoryTransport(
      {},
      {
        handle: (_method, route) => {
          if (route === "/refused") throw new TransportError(route, 409, null);
          throw broken;
        },
      },
    ),
  );
  await assert.rejects(screens.send("POST", "/refused", {}));
  await assert.rejects(screens.send("POST", "/issues", {}), broken);
  assert.deepEqual(
    reporter.reports.map(({ about }) => about.useCase),
    ["screens.EntityWrites.send"],
  );
  assert.deepEqual(
    tracer.spans.map(({ outcome }) => outcome),
    ["refused", "failed"],
  );
});

test("a transport without read() gives screens none either, and its name is the platform's", () => {
  const screens = screensTransport(memoryTransport({}), "web");
  assert.equal(typeof screens.list, "function");
  const own = screensTransport({
    list: () => Promise.reject(new Error("no")),
    one: () => Promise.reject(new Error("no")),
    send: () => Promise.reject(new Error("no")),
  });
  assert.equal(own.read, undefined);
});

test("a screens transport given again is answered as it is: never two use cases per request", async () => {
  const tracer = memoryTracer();
  configureProcess({ tracer });
  const once = screensTransport(memoryTransport({}, { handle: () => ({ ok: true }) }));
  const twice = screensTransport(once);
  assert.equal(twice, once);
  await twice.send("POST", "/issues", {});
  assert.equal(tracer.spans.length, 1);
});
