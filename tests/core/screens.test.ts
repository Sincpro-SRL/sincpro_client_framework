import assert from "node:assert/strict";

import {
  configureProcess,
  guardedTransport,
  memoryTransport,
  processContext,
  restTransport,
  screensTransport,
  TransportError,
} from "@sincpro/client-framework";
import { CircuitBreaker } from "@sincpro/client-framework/circuit_breaker/entrypoint/circuit-breaker";
import { markedAs, type Transport } from "@sincpro/client-framework/client/domain/transport";
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
  configureProcess({ logger: { engine: logger } });
  const raw = memoryTransport({}, { handle: () => ({ ok: true }) });
  await raw.send("POST", "/x", {});
  assert.equal(logger.records.length, 0);
  const screens = screensTransport(raw);
  assert.equal(screensTransport(screens), screens);
  await screens.send("POST", "/x", {});
  assert.equal(logger.records.length, 2);
  assert.ok(logger.records.every((record) => record.useCase === "screens.EntitySend"));
});

test("what a screen reads and writes is a use case of `screens`: traced, its route said, the trace and the context on the request", async () => {
  const sent: Sent[] = [];
  const tracer = memoryTracer();
  configureProcess({ tracer });
  processContext.set({ company_id: 2 });
  const screens = screensTransport(restTransport({ document: null, fetch: recording(sent) }));
  await screens.send("POST", "/issues/acme-3/close", {});
  const [span] = tracer.spans;
  assert.equal(span?.name, "screens/EntitySend");
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
    ["screens.EntitySend"],
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

test("a screens transport under a wrapper that keeps its mark is answered as it is: one span per read", async () => {
  const tracer = memoryTracer();
  configureProcess({ tracer });
  const screens = screensTransport(memoryTransport({}, { handle: () => ({ ok: true }) }));
  // A guard over the screens is still a screens transport: no second `screens` context.
  const guarded = guardedTransport(screens, new CircuitBreaker("screens"));
  assert.equal(screensTransport(guarded), guarded);
  await screensTransport(guarded).send("POST", "/issues", {});
  assert.equal(tracer.spans.length, 1);
  assert.equal(tracer.spans[0]?.name, "screens/EntitySend");
});

test("a platform's wrapper that copies the mark keeps the screens context; one that does not is made again", async () => {
  const tracer = memoryTracer();
  configureProcess({ tracer });
  const screens = screensTransport(memoryTransport({}, { handle: () => ({ ok: true }) }));
  const wrap = (inner: Transport): Transport => ({
    list: inner.list.bind(inner),
    one: inner.one.bind(inner),
    send: inner.send.bind(inner),
  });
  // Copies the mark: answered as it is.
  const marked = markedAs(wrap(screens), screens);
  assert.equal(screensTransport(marked), marked);
  // Does not copy it: the screens are made again, a second context over the first.
  const unmarked = wrap(screens);
  assert.notEqual(screensTransport(unmarked), unmarked);
  await screensTransport(unmarked).send("POST", "/issues", {});
  assert.equal(tracer.spans.length, 2);
});
