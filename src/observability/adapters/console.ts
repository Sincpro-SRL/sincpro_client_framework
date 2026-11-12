import {
  isLogLevel,
  type LogFilter,
  type Logger,
  type LogLevel,
  type LogRecord,
  speaks,
} from "@sincpro/client-framework/observability/domain/logging";

/**
 * Context: a development console is read by a person, a line at a glance. Each record is ONE
 * line — its time, its level, its layer and use case, its message and the keys worth reading —,
 * never the record object dumped after it, and a run's start and end read as `▶` / `✔` / `✖`.
 * An unexpected failure still goes as an `Error` with its stack, because that is what React
 * Native's LogBox, Expo's terminal and a browser print with a code frame. Production is silent.
 *
 * Colors are ANSI escape codes, and only the platform knows where its console renders them: a
 * terminal and a browser's devtools do; React Native's LogBox, which shows WARN and ERROR in the
 * app, prints them as text. So the platform names the levels to color (`colors`), and the line
 * reads the same without them.
 */

/** The console's mode, which INFO and DEBUG lines it prints (`LogFilter`), and their colors. */
export type ConsoleLoggerOptions = LogFilter & {
  readonly mode: "development" | "production";
  /** The levels whose lines get ANSI colors: `true` every one, none unless said. */
  readonly colors?: boolean | readonly LogLevel[];
};

const LABELS: Readonly<Record<LogLevel, string>> = {
  debug: "DEBUG",
  info: "INFO ",
  warn: "WARN ",
  error: "ERROR",
};

const LEVEL_COLORS: Readonly<Record<LogLevel, string>> = {
  debug: "90",
  info: "36",
  warn: "33",
  error: "31",
};

/** Past this, a value is cut: a line is read, not scrolled. */
const MAX_VALUE = 160;

/** How much of a run's id a line shows: enough to tell two runs apart. */
const SHORT_ID = 6;

type Paint = (code: string, text: string) => string;

const painted: Paint = (code, text) => `\u001b[${code}m${text}\u001b[0m`;
const plain: Paint = (_code, text) => text;

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

/** `HH:mm:ss.SSS` on the device's clock; the record's own text when it is not an instant. */
function timeOf(timestamp: string): string {
  const at = new Date(timestamp);
  if (Number.isNaN(at.getTime())) return timestamp;
  return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}.${pad(at.getMilliseconds(), 3)}`;
}

/** `key=value`, the value quoted when it would not read as one word, and cut when long. */
function keyValue(key: string, value: string | number | boolean): string {
  const text = String(value);
  const cut = text.length > MAX_VALUE ? `${text.slice(0, MAX_VALUE)}…` : text;
  return `${key}=${/^[^\s"=]+$/.test(cut) ? cut : JSON.stringify(cut)}`;
}

/**
 * What the line says after its level and layer:
 *
 *     ▶ common.PrintImage                                   a run starts
 *     ✔ common.PrintImage 12ms                              it answered
 *     ✖ common.PrintImage TypeError: printer is undefined 8ms         it failed
 *     ✖ common.ConnectPrinter refused: unavailable 8ms      it was refused, or the caller left
 *     common.PrintImage Printing page=2                     a line its use case wrote
 */
function saying(record: LogRecord, paint: Paint): string {
  const where = record.useCase ? paint("1", record.useCase) : "";
  const took = record.durationMs === undefined ? "" : ` ${Math.round(record.durationMs)}ms`;
  if (record.event === "execution.started") return `${paint("34", "▶")} ${where}`;
  if (record.event === "execution.finished") {
    if (record.outcome === "ok") return `${paint("32", "✔")} ${where}${took}`;
    const failure = record.failure;
    const why =
      record.outcome === "failed"
        ? failure?.message
          ? `${failure.type}: ${failure.message}`
          : (failure?.type ?? "failed")
        : `${record.outcome}${failure?.kind ? `: ${failure.kind}` : ""}`;
    return `${paint("31", "✖")} ${where} ${why}${took}`;
  }
  return where ? `${where} ${record.message}` : record.message;
}

/** One line for a person: time, level, layer, what happened, its keys, the run. */
export function prettyLine(record: LogRecord, colored = false): string {
  const paint = colored ? painted : plain;
  const keys = Object.entries(record.attributes ?? {}).map(([key, value]) =>
    keyValue(key, value),
  );
  const run = record.executionId
    ? ` ${paint("2", `#${record.executionId.slice(0, SHORT_ID)}`)}`
    : "";
  return [
    paint("2", timeOf(record.timestamp)),
    paint(LEVEL_COLORS[record.level], LABELS[record.level]),
    paint("2", `[${record.layer}]`),
    saying(record, paint),
    ...keys,
  ]
    .filter((part) => part !== "")
    .join(" ")
    .concat(run);
}

/** The failure as an Error to print: its type as its name, its message, its stack. */
function errorOf(stack: string, failure: { type?: string; message?: string }): Error {
  const shown = new Error(failure.message ?? failure.type ?? "");
  shown.name = failure.type ?? "Error";
  shown.stack = stack;
  return shown;
}

function methodOf(level: LogLevel): (...data: unknown[]) => void {
  if (level === "debug") return console.debug;
  if (level === "warn") return console.warn;
  if (level === "error") return console.error;
  return console.log;
}

/**
 * Built-in console engine: one readable line per record in development, silent in production;
 * which INFO and DEBUG lines it prints is its own filter, WARN and ERROR always. Other sinks are
 * filtered independently.
 */
export function consoleLogger(options: ConsoleLoggerOptions): Logger {
  const mode = options.mode;
  if (mode !== "development" && mode !== "production") {
    throw new TypeError("Console logger mode must be development or production");
  }
  if (options.level !== undefined && !isLogLevel(options.level)) {
    throw new TypeError("Console logger level must be debug, info, warn or error");
  }
  const colors = options.colors ?? false;
  if (Array.isArray(colors) && !colors.every(isLogLevel)) {
    throw new TypeError("Console logger colors must be true, false or log levels");
  }
  const colored = (level: LogLevel) =>
    colors === true || (Array.isArray(colors) && colors.includes(level));
  const filter: LogFilter = {
    level: options.level ?? "debug",
    layers: { ...options.layers },
    boundedContexts: { ...options.boundedContexts },
  };
  return {
    log(record) {
      if (mode === "production" || !speaks(record, filter)) return;
      const method = methodOf(record.level);
      let line: string;
      try {
        line = prettyLine(record, colored(record.level));
      } catch {
        line = `${LABELS[record.level]} [${record.layer}] ${record.message}`;
      }
      const stack = record.failure?.stack;
      // An unexpected failure goes as an Error — its name, its message, its stack —: what React
      // Native's LogBox, Expo's terminal and a browser print as a failure, with its code frame.
      if (stack) method.call(console, line, errorOf(stack, record.failure ?? {}));
      else method.call(console, line);
    },
  };
}
