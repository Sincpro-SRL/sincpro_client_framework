import assert from "node:assert/strict";

import {
  BoundedContext,
  Command,
  configureProcess,
  Feature,
  identityOf,
  logger,
  processContext,
  processIdentity,
  reportError,
} from "@sincpro/client-framework";
import { sentryReporter } from "@sincpro/client-framework/sentry";
import {
  memoryLogger,
  memoryReporter,
  memoryTracer,
} from "@sincpro/client-framework/testing";
import { beforeEach, test } from "vitest";

beforeEach(() => configureProcess());

test("the release is read with sincpro_framework's rules — the same name and version everywhere", () => {
  const cases: [string, string, string][] = [
    ["sincpro-mobile-tickets:0.3.0", "sincpro-mobile-tickets", "0.3.0"],
    ["registry.digitalocean.com/sincpro/sincpro_odoo_mcp:0.8.0", "sincpro_odoo_mcp", "0.8.0"],
    ["registry.local:5000/team/app", "app", ""],
    ["registry.io/team/app:1.2@sha256:abcdef", "app", "1.2"],
    ["app@1.2.3", "app", "1.2.3"],
  ];
  for (const [release, serviceName, serviceVersion] of cases) {
    assert.deepEqual(
      identityOf(release),
      {
        release,
        serviceName,
        serviceVersion,
        tenantKeys: ["tenant", "tenant_id"],
        userKeys: ["user_id"],
      },
      release,
    );
  }
  assert.equal(identityOf("app:1.0", " acme ").tenant, "acme");
  assert.equal(identityOf("app:1.0", "").tenant, undefined);
});

class CommandProbe extends Command<void> {}

function probeBoundedContext(fails = false) {
  const boundedContext = new BoundedContext("probe");
  boundedContext.feature(CommandProbe)(
    class Probe extends Feature<CommandProbe, void> {
      execute(): void {
        this.logger.info("probing");
        if (fails) throw new TypeError("probe broke");
      }
    },
  );
  return boundedContext;
}

test("a run's span, its lines and its report say the release; no tenant when none is known", async () => {
  const tracer = memoryTracer();
  const lines = memoryLogger();
  const reporter = memoryReporter();
  configureProcess({
    identity: { release: "sincpro-mobile-tickets:0.3.0" },
    tracer,
    reporter,
    logger: { engine: lines },
  });

  await assert.rejects(probeBoundedContext(true).execute(new CommandProbe()), TypeError);

  const [span] = tracer.spans;
  assert.equal(span?.attributes.release, "sincpro-mobile-tickets:0.3.0");
  assert.equal("tenant" in (span?.attributes ?? {}), false, "an open app serves no tenant");
  const probing = lines.records.find((record) => record.message === "probing");
  assert.equal(probing?.release, "sincpro-mobile-tickets:0.3.0");
  assert.equal(probing?.tenant, undefined);
  assert.equal(reporter.reports[0]?.about.release, "sincpro-mobile-tickets:0.3.0");
  assert.equal(processIdentity()?.serviceName, "sincpro-mobile-tickets");
});

test("the tenant is the run's context's, else the deployment's", async () => {
  const tracer = memoryTracer();
  const lines = memoryLogger();
  configureProcess({
    identity: { release: "forge-web:1.4.0", tenant: "sincpro" },
    tracer,
    logger: { engine: lines },
  });

  await probeBoundedContext().execute(new CommandProbe());
  processContext.set({ tenant: "acme" });
  await probeBoundedContext().execute(new CommandProbe());

  assert.deepEqual(
    tracer.spans.map((span) => span.attributes.tenant),
    ["sincpro", "acme"],
  );
  logger.info("outside a run");
  assert.equal(
    lines.records.at(-1)?.tenant,
    "sincpro",
    "a line outside a run: the deployment's",
  );
});

test("GlitchTip tags a report with its release and its tenant", () => {
  const captured: unknown[] = [];
  configureProcess({
    identity: { release: "sincpro-mobile-tickets:0.3.0" },
    reporter: sentryReporter({
      captureException: (_error, hint) => {
        captured.push(hint);
        return "id";
      },
    }),
  });
  processContext.set({ tenant_id: 7 });

  reportError(new TypeError("broke"), "screen printer");

  const tags = (captured[0] as { captureContext: { tags: Record<string, string> } })
    .captureContext.tags;
  assert.equal(tags.release, "sincpro-mobile-tickets:0.3.0");
  assert.equal(tags.tenant, "7");
});
