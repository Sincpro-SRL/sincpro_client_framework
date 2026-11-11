import assert from "node:assert/strict";

import {
  BoundedContext,
  Command,
  configureProcess,
  Feature,
  plainCodec,
  processContext,
  restTransport,
} from "@sincpro/client-framework";
import { memoryTracer } from "@sincpro/client-framework/testing";
import { beforeEach, test } from "vitest";

beforeEach(() => configureProcess());

test("the plain codec writes only what travels, and reading never fails a context whole", () => {
  const socket = { send: () => undefined };
  assert.equal(
    plainCodec.dumps({ tenant_id: "acme", company_id: 2, ok: true, ids: ["a"], socket }),
    '{"tenant_id":"acme","company_id":2,"ok":true,"ids":["a"]}',
  );
  assert.deepEqual(plainCodec.loads('{"tenant_id":"acme"}'), { tenant_id: "acme" });
  assert.deepEqual(plainCodec.loads("[1, 2]"), {});
  assert.deepEqual(plainCodec.loads("not json"), {});
});

test("what is held in the context but does not travel stays in this process: never in the header", async () => {
  const sent: Record<string, string>[] = [];
  const fetch = (async (_url: string, init?: RequestInit) => {
    sent.push({ ...(init?.headers as Record<string, string>) });
    return new Response("{}", { status: 200 });
  }) as typeof globalThis.fetch;
  configureProcess({ tracer: memoryTracer() });
  processContext.set({ tenant_id: "acme", printer: { print: () => undefined } });
  class Ask extends Command<unknown> {}
  class Asks extends Feature<Ask, unknown> {
    declare readonly transport: ReturnType<typeof restTransport>;
    execute() {
      return this.transport.send("POST", "/issues", {});
    }
  }
  const asking = new BoundedContext<{ transport: ReturnType<typeof restTransport> }>(
    "asking",
  ).addDependency("transport", restTransport({ document: null, fetch }));
  asking.feature(Ask)(Asks);
  await asking.execute(new Ask());
  assert.equal(sent[0]?.["sincpro-context"], '{"tenant_id":"acme"}');
});
