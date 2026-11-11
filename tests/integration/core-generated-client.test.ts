import assert from "node:assert/strict";

import {
  configureProcess,
  processContext,
  restOperations,
  restTransport,
} from "@sincpro/client-framework";
import { memoryTracer } from "@sincpro/client-framework/testing";
import { beforeEach, test } from "vitest";

import { CommandRequestCancellation, projectOf, ResponseCancelIssue } from "../support/core";
import { clientOf } from "../support/forge-contract/project/client";

beforeEach(() => configureProcess());

test("the generated client is an injected adapter, not the local application service", async () => {
  const requests: Request[] = [];
  const tracer = memoryTracer();
  configureProcess({ tracer });
  processContext.set({ tenant_id: "acme" });
  const client = clientOf(
    restOperations(
      restTransport({
        document: null,
        fetch: async (url, init) => {
          requests.push(new Request(new URL(String(url), "https://example.test"), init));
          return Response.json({ issue_id: "x", resolution: "cancelled" });
        },
      }),
    ),
  );
  const project = projectOf({ client, access: { requireCancellation() {} } });
  project.context.set({ company_id: 2 });

  const result = await project.execute(new CommandRequestCancellation("x"));
  assert.ok(result instanceof ResponseCancelIssue);
  assert.equal(result.resolution, "cancelled");
  assert.equal(requests.length, 1);
  assert.deepEqual(await requests[0]?.json(), { issue_id: "x" });
  assert.deepEqual(
    tracer.spans.map((span) => span.name),
    ["project/RequestCancellation", "project/CancelIssue"],
  );
  const feature = tracer.spans[1];
  assert.equal(
    requests[0]?.headers.get("traceparent"),
    `00-${feature?.traceId}-${feature?.spanId}-01`,
  );
  assert.equal(
    requests[0]?.headers.get("sincpro-context"),
    '{"tenant_id":"acme","company_id":2}',
  );
});
