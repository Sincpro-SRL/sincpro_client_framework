import assert from "node:assert/strict";

import {
  BoundedContext,
  combineLoggers,
  Command,
  configureProcess,
  Feature,
  type LayerLogger,
  logger as infrastructure,
  loggerAdapter,
  type LogLayer,
  type LogLevel,
  type LogRecord,
} from "@sincpro/client-framework";
import { consoleLogger, prettyLine } from "@sincpro/client-framework/console";
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
  assert.match(
    String(calls.info.mock.calls[0]?.[0]),
    /INFO {2}\[infrastructure\] information$/,
  );
  assert.match(
    String(calls.info.mock.calls[2]?.[0]),
    /INFO {2}\[bounded_context\] information$/,
  );
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

class Refused extends Error {
  static readonly failureKind = "domain";
}

class CommandPay extends Command<string> {
  constructor(readonly how: "pay" | "refuse" | "break") {
    super();
  }
}

function shop(): BoundedContext {
  const shopBoundedContext = new BoundedContext("shop");
  shopBoundedContext.feature(CommandPay)(
    class Pay extends Feature<CommandPay, string> {
      execute(command: CommandPay): string {
        if (command.how === "refuse") throw new Refused("no credit");
        if (command.how === "break") throw new TypeError("card is undefined");
        this.logger.info("Paying", { order: "A-1", note: "two words" });
        return "paid";
      }
    },
  );
  return shopBoundedContext;
}

const colored = (line: unknown) => String(line).includes("\u001b[");

test("a run reads as ▶ when it starts and ✔ with its duration, one argument per line", async () => {
  const calls = capture();
  configureProcess({ logger: { engine: consoleLogger({ mode: "development" }) } });

  await shop().execute(new CommandPay("pay"));

  const [started = []] = calls.debug.mock.calls;
  const [paying = [], finished = []] = calls.info.mock.calls;
  assert.match(
    String(started[0]),
    /^\d\d:\d\d:\d\d\.\d{3} DEBUG \[feature\] ▶ shop\.Pay #[0-9a-f]{6}$/,
  );
  assert.match(
    String(paying[0]),
    /INFO {2}\[feature\] shop\.Pay Paying order=A-1 note="two words" #[0-9a-f]{6}$/,
  );
  assert.match(String(finished[0]), /INFO {2}\[feature\] ✔ shop\.Pay \d+ms #[0-9a-f]{6}$/);
  const run = (line: unknown) => String(line).slice(-6);
  assert.equal(run(started[0]), run(finished[0]), "the pair names the same run");
  for (const call of [started, paying, finished]) assert.equal(call.length, 1);
  assert.ok(!colored(finished[0]), "no colors unless the platform asks");
});

test("a refused run is one info line, with its kind and no stack", async () => {
  const calls = capture();
  configureProcess({ logger: { engine: consoleLogger({ mode: "development" }) } });

  await shop()
    .execute(new CommandPay("refuse"))
    .catch(() => undefined);

  const finished = calls.info.mock.calls.at(-1) ?? [];
  assert.match(
    String(finished[0]),
    /INFO {2}\[feature\] ✖ shop\.Pay refused: domain \d+ms #/,
  );
  assert.equal(finished.length, 1);
  assert.equal(calls.error.mock.calls.length, 0);
});

test("an unexpected failure is the line and the Error with its stack, nothing else", async () => {
  const calls = capture();
  configureProcess({ logger: { engine: consoleLogger({ mode: "development" }) } });

  await shop()
    .execute(new CommandPay("break"))
    .catch(() => undefined);

  const [line, shown, ...rest] = calls.error.mock.calls.at(-1) ?? [];
  assert.match(
    String(line),
    /ERROR \[feature\] ✖ shop\.Pay TypeError: card is undefined \d+ms #/,
  );
  assert.ok(shown instanceof Error);
  assert.equal(shown.name, "TypeError");
  assert.equal(rest.length, 0);
});

test("colors go only to the levels the platform names", () => {
  const calls = capture();
  configureProcess({
    logger: { engine: consoleLogger({ mode: "development", colors: ["debug", "info"] }) },
  });
  loggerAdapter.info("activity");
  loggerAdapter.warn("slow");
  configureProcess({
    logger: { engine: consoleLogger({ mode: "development", colors: true }) },
  });
  loggerAdapter.warn("slower");

  assert.ok(colored(calls.info.mock.calls[0]?.[0]));
  assert.ok(!colored(calls.warn.mock.calls[0]?.[0]), "LogBox shows WARN as text");
  assert.ok(colored(calls.warn.mock.calls[1]?.[0]));
  assert.throws(
    () =>
      consoleLogger({
        mode: "development",
        // @ts-expect-error Runtime JavaScript can pass an unknown level.
        colors: ["verbose"],
      }),
    /colors/,
  );
});

test("a line quotes a value that is not one word and cuts a long one", () => {
  const record: LogRecord = {
    timestamp: "2026-11-12T10:20:30.045Z",
    level: "warn",
    layer: "adapter",
    message: "Slow query",
    attributes: {
      sql: "SELECT 1",
      table: "orders",
      rows: 3,
      cached: false,
      blob: "x".repeat(200),
    },
  };

  const line = prettyLine(record);

  assert.match(
    line,
    /^\d\d:\d\d:\d\d\.045 WARN {2}\[adapter\] Slow query sql="SELECT 1" table=orders rows=3 cached=false blob=x{160}…$/,
  );
});

test("the formatter never fails the line: a record it cannot read still prints", () => {
  const calls = capture();
  const unreadable = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error("unreadable");
      },
    },
  );

  consoleLogger({ mode: "development" }).log({
    timestamp: "not a time",
    level: "info",
    layer: "adapter",
    message: "Odd",
    attributes: unreadable,
  });

  assert.equal(String(calls.info.mock.calls[0]?.[0]), "INFO  [adapter] Odd");
});
