import assert from "node:assert/strict";

import {
  BoundedContext,
  combineLoggers,
  Command,
  configureProcess,
  Feature,
  filteredLogger,
  type LogFilter,
  type LogRecord,
  speaks,
} from "@sincpro/client-framework";
import { consoleLogger } from "@sincpro/client-framework/console";
import { memoryLogger, memoryTracer } from "@sincpro/client-framework/testing";
import { beforeEach, test, vi } from "vitest";

beforeEach(() => configureProcess());

const line = (fields: Partial<LogRecord>): LogRecord => ({
  timestamp: "2026-11-12T00:00:00.000Z",
  level: "info",
  layer: "feature",
  message: "m",
  ...fields,
});

const production: LogFilter = {
  level: "info",
  layers: { adapter: false, infrastructure: false },
  boundedContexts: { common: false },
};

test("a filter keeps INFO and DEBUG quiet by level, layer and bounded context; WARN and ERROR always speak", () => {
  assert.equal(speaks(line({ boundedContext: "tickets" }), production), true);
  assert.equal(
    speaks(line({ level: "debug", boundedContext: "tickets" }), production),
    false,
  );
  assert.equal(speaks(line({ boundedContext: "common" }), production), false);
  assert.equal(speaks(line({ layer: "adapter" }), production), false);
  assert.equal(speaks(line({ layer: "infrastructure" }), production), false);
  for (const level of ["warn", "error"] as const) {
    assert.equal(speaks(line({ level, boundedContext: "common" }), production), true);
    assert.equal(speaks(line({ level, layer: "adapter" }), production), true);
  }
  assert.equal(speaks(line({ level: "debug", layer: "adapter" }), {}), true, "unsaid speaks");
});

test("a filtered engine hears what speaks, and a function filter is read on every line", async () => {
  const lines = memoryLogger();
  let debugging = false;
  const tracer = memoryTracer();
  configureProcess({
    tracer,
    logger: {
      engine: filteredLogger(combineLoggers(lines), () => (debugging ? {} : production)),
    },
  });
  class CommandCheck extends Command<void> {}
  const commonBoundedContext = new BoundedContext("common");
  commonBoundedContext.feature(CommandCheck)(
    class Check extends Feature<CommandCheck, void> {
      execute(): void {
        this.logger.info("network is up");
      }
    },
  );

  await commonBoundedContext.execute(new CommandCheck());
  assert.deepEqual(
    lines.records.filter((one) => one.boundedContext === "common"),
    [],
    "common is quiet in production",
  );
  assert.equal(tracer.spans.length, 1, "its span is never filtered");

  debugging = true;
  await commonBoundedContext.execute(new CommandCheck());
  assert.ok(lines.records.some((one) => one.message === "network is up"));
});

test("the console prints by the same rule", () => {
  const info = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const engine = consoleLogger({ mode: "development", ...production });
    engine.log(line({ boundedContext: "common" }));
    engine.log(line({ boundedContext: "tickets" }));
    assert.equal(info.mock.calls.length, 1);
  } finally {
    info.mockRestore();
  }
});
