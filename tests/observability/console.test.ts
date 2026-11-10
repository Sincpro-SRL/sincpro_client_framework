import assert from "node:assert/strict";

import {
  combineLoggers,
  configureProcess,
  loggerFor,
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
  configureProcess({ logger: consoleLogger({ mode: "development" }) });
  const layers: LogLayer[] = [
    "global",
    "use_cases",
    "feature",
    "application_service",
    "adapter",
    "repositories",
    "transport",
    "event_bus",
    "cron",
  ];
  for (const layer of layers) {
    const logger = loggerFor(layer);
    logger.debug("detail");
    logger.info("information");
    logger.warn("warning");
    logger.error("failure");
  }
  for (const method of Object.values(calls))
    assert.equal(method.mock.calls.length, layers.length);
  assert.match(String(calls.info.mock.calls[0]?.[0]), /\[global\] INFO/);
});

test("production silences all console levels, like mobile", () => {
  const calls = capture();
  configureProcess({ logger: consoleLogger({ mode: "production" }) });
  const logger = loggerFor("feature");
  logger.debug("detail");
  logger.info("information");
  logger.warn("warning");
  logger.error("failure");
  for (const method of Object.values(calls)) assert.equal(method.mock.calls.length, 0);
});

test("layer and level masks hide INFO/DEBUG without hiding WARN/ERROR", () => {
  const calls = capture();
  configureProcess({
    logger: consoleLogger({
      mode: "development",
      level: "info",
      layers: { repositories: false },
    }),
  });
  const repositories = loggerFor("repositories");
  repositories.debug("SQL detail");
  repositories.info("SQL activity");
  repositories.warn("slow query");
  repositories.error("query failed");
  loggerFor("feature").debug("verbose");
  loggerFor("feature").info("completed");
  assert.equal(calls.debug.mock.calls.length, 0);
  assert.equal(calls.info.mock.calls.length, 1);
  assert.equal(calls.warn.mock.calls.length, 1);
  assert.equal(calls.error.mock.calls.length, 1);
});

test("console mode and masks never filter another destination", () => {
  const calls = capture();
  const destination = memoryLogger();
  configureProcess({
    logger: combineLoggers(
      consoleLogger({ mode: "production", layers: { repositories: false } }),
      destination,
    ),
  });
  const logger = loggerFor("repositories");
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
    configureProcess({ logger: consoleLogger({ mode: "development", level }) });
    loggerFor("adapter").warn("warning");
    loggerFor("adapter").error("failure");
  }
  assert.equal(calls.warn.mock.calls.length, 4);
  assert.equal(calls.error.mock.calls.length, 4);
});
