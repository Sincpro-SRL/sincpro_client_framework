import {
  isLogLevel,
  type LogFilter,
  type Logger,
  speaks,
} from "@sincpro/client-framework/observability/domain/logging";

/** The console's mode, and which INFO and DEBUG lines it prints (`LogFilter`). */
export type ConsoleLoggerOptions = LogFilter & {
  readonly mode: "development" | "production";
};

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
  if (options.level !== undefined && !isLogLevel(options.level)) {
    throw new TypeError("Console logger level must be debug, info, warn or error");
  }
  const filter: LogFilter = {
    level: options.level ?? "debug",
    layers: { ...options.layers },
    boundedContexts: { ...options.boundedContexts },
  };
  return {
    log(record) {
      if (mode === "production" || !speaks(record, filter)) return;
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
