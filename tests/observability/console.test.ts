import assert from "node:assert/strict";

import {
  BoundedContext,
  combineLoggers,
  configureProcess,
  type LayerLogger,
  logger as infrastructure,
  loggerAdapter,
  type LogLayer,
  type LogLevel,
} from "@sincpro/client-framework";
import { consoleLogger } from "@sincpro/client-framework/console";
import { memoryLogger } from "@sincpro/client-framework/testing";
import { afterEach, beforeEach, test, vi } from "vitest";

function capture() {
  return {
    debug: vi.spyOn(console, "debug").mockImplementation(() => {}),
    info: vi.spyOn(console, "log").mockImplementation(() => {}),
    warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
    error: vi.spyOn(console, "error").mockImplementation(() => {}),
  };
}

beforeEach(() => configureProcess());
afterEach(() => {
  configureProcess();
  vi.restoreAllMocks();
});

test("development prints every level and layer by default", () => {
  const calls = capture();
  configureProcess({ logger: { engine: consoleLogger({ mode: "development" }) } });
  const loggers: [LogLayer, LayerLogger][] = [
    ["infrastructure", infrastructure],
    ["adapter", loggerAdapter],
    ["bounded_context", new BoundedContext("catalog").logger],
  ];
  for (const [, logger] of loggers) {
    logger.debug("detail");
    logger.info("information");
    logger.warn("warning");
    logger.error("failure");
  }
  for (const method of Object.values(calls))
    assert.equal(method.mock.calls.length, loggers.length);
  assert.match(String(calls.info.mock.calls[0]?.[0]), /\[infrastructure\] INFO/);
  assert.match(String(calls.info.mock.calls[2]?.[0]), /\[bounded_context\] INFO/);
});

test("production silences all console levels, like mobile", () => {
  const calls = capture();
  configureProcess({ logger: { engine: consoleLogger({ mode: "production" }) } });
  const logger = loggerAdapter;
  logger.debug("detail");
  logger.info("information");
  logger.warn("warning");
  logger.error("failure");
  for (const method of Object.values(calls)) assert.equal(method.mock.calls.length, 0);
});

test("layer and level masks hide INFO/DEBUG without hiding WARN/ERROR", () => {
  const calls = capture();
  configureProcess({
    logger: { mode: "development", level: "info", layers: { adapter: false } },
  });
  loggerAdapter.debug("SQL detail");
  loggerAdapter.info("SQL activity");
  loggerAdapter.warn("slow query");
  loggerAdapter.error("query failed");
  infrastructure.debug("verbose");
  infrastructure.info("completed");
  assert.equal(calls.debug.mock.calls.length, 0);
  assert.equal(calls.info.mock.calls.length, 1);
  assert.equal(calls.warn.mock.calls.length, 1);
  assert.equal(calls.error.mock.calls.length, 1);
});

test("console mode and masks never filter another destination", () => {
  const calls = capture();
  const destination = memoryLogger();
  configureProcess({
    logger: {
      engine: combineLoggers(
        consoleLogger({ mode: "production", layers: { adapter: false } }),
        destination,
      ),
    },
  });
  const logger = loggerAdapter;
  logger.debug("detail");
  logger.info("activity");
  logger.warn("warning");
  logger.error("failure");
  assert.deepEqual(
    destination.records.map((record) => record.level),
    ["debug", "info", "warn", "error"],
  );
  for (const method of Object.values(calls)) assert.equal(method.mock.calls.length, 0);
});

test("logger mode is explicit rather than inferred from a platform global", () => {
  assert.throws(
    () =>
      consoleLogger({
        // @ts-expect-error Runtime JavaScript can pass an invalid mode.
        mode: "preview",
      }),
    /mode/,
  );
  assert.throws(
    () =>
      consoleLogger({
        mode: "development",
        // @ts-expect-error Runtime JavaScript can pass an invalid threshold.
        level: "verbose",
      }),
    /level/,
  );
});

test("all level thresholds retain the development WARN/ERROR safety policy", () => {
  const calls = capture();
  for (const level of ["debug", "info", "warn", "error"] satisfies LogLevel[]) {
    configureProcess({ logger: { mode: "development", level } });
    loggerAdapter.warn("warning");
    loggerAdapter.error("failure");
  }
  assert.equal(calls.warn.mock.calls.length, 4);
  assert.equal(calls.error.mock.calls.length, 4);
});
