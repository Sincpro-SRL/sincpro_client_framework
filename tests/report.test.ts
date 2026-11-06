import assert from "node:assert/strict";

import {
  configureProcess,
  Feature,
  processContext,
  reportError,
  TransportError,
  UseBoundedContext,
} from "@sincpro/client-framework";
import { memoryReporter } from "@sincpro/client-framework/testing";
import { beforeEach, test } from "vitest";

beforeEach(() => configureProcess());

test("what fails outside a use case is reported with where it happened and the process's context", () => {
  const reporter = memoryReporter();
  configureProcess({ reporter });
  processContext.set({ tenant_id: "acme" });
  const broken = new TypeError("Cannot read properties of undefined");
  reportError(broken, "view project:issue/acme-3");
  const [report] = reporter.reports;
  assert.equal(report?.error, broken);
  assert.equal(report?.about.useCase, "view project:issue/acme-3");
  assert.deepEqual(report?.about.context, { tenant_id: "acme" });
  assert.match(report?.about.executionId ?? "", /^[0-9a-f]{32}$/);
});

test("an error a use case already reported is not reported again by the screen it broke", async () => {
  const reporter = memoryReporter();
  configureProcess({ reporter });
  const broken = new TypeError("undefined is not a function");
  class Fails extends Feature {
    async now() {
      throw broken;
    }
  }
  const failing = new UseBoundedContext("project").register({ features: { Fails } });
  await assert.rejects(failing.Fails.now(), broken);
  reportError(broken, "view project:issue/acme-3");
  assert.deepEqual(
    reporter.reports.map(({ about }) => about.useCase),
    ["project.Fails.now"],
  );
});

test("a reporter that throws, or none at all, never breaks what reports", () => {
  reportError(new Error("nobody listens"), "worker");
  configureProcess({
    reporter: {
      report: () => {
        throw new Error("the reporter is down");
      },
    },
  });
  reportError(new Error("boom"), "worker");
});

test("a refusal the server explained, or an abort, is not a fault outside a use case either", () => {
  const reporter = memoryReporter();
  configureProcess({ reporter });
  reportError(new TransportError("/issues/1", 409, null), "view project:issue/1");
  reportError(
    Object.assign(new Error("stopped"), { name: "AbortError" }),
    "view project:issue/1",
  );
  assert.equal(reporter.reports.length, 0);
});
