import type {
  Logger,
  LogLayer,
  LogLevel,
} from "@sincpro/client-framework/observability/domain/logging";

export type ConsoleLoggerOptions = {
  mode: "development" | "production";
  /** Development INFO/DEBUG threshold. WARN/ERROR are never hidden by layer/level masks. */
  level?: LogLevel;
  layers?: Partial<Record<LogLayer, boolean>>;
};

const RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/**
 * Built-in console engine: silent in production, configurable
 * development layers, and WARN/ERROR preserved. Other sinks are filtered independently.
 */
/** The failure as an Error to print: its type as its name, its message, its stack. */
function errorOf(stack: string, failure: { type?: string; message?: string }): Error {
  const shown = new Error(failure.message ?? failure.type ?? "");
  shown.name = failure.type ?? "Error";
  shown.stack = stack;
  return shown;
}

export function consoleLogger(options: ConsoleLoggerOptions): Logger {
  const mode = options.mode;
  if (mode !== "development" && mode !== "production") {
    throw new TypeError("Console logger mode must be development or production");
  }
  const level = options.level ?? "debug";
  if (!Object.hasOwn(RANK, level)) {
    throw new TypeError("Console logger level must be debug, info, warn or error");
  }
  const layers = { ...options.layers };
  return {
    log(record) {
      if (mode === "production") return;
      if (record.level !== "warn" && record.level !== "error") {
        if (layers[record.layer] === false || RANK[record.level] < RANK[level]) return;
      }
      const prefix = `${record.timestamp} [${record.layer}] ${record.level.toUpperCase()}`;
      const method =
        record.level === "debug"
          ? console.debug
          : record.level === "warn"
            ? console.warn
            : record.level === "error"
              ? console.error
              : console.log;
      const stack = record.failure?.stack;
      if (!stack) {
        method.call(console, prefix, record.message, record);
        return;
      }
      // An unexpected failure goes as an Error — its name, its message, its stack —: what React
      // Native's LogBox, Expo's terminal and a browser print as a failure, with its code frame.
      // A bare stack string read as one printed `ERROR null null`.
      const { stack: _shownBelow, ...failure } = record.failure ?? {};
      method.call(
        console,
        `${prefix} ${record.message}`,
        { ...record, failure },
        errorOf(stack, failure),
      );
    },
  };
}
