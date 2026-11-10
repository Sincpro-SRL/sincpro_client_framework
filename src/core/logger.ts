import type {
  Attributes,
  Logger,
  LogLayer,
  LogLevel,
  LogRecord,
  Outcome,
} from "@sincpro/client-framework/observability/ports";
import { BIND, type Execution } from "@sincpro/client-framework/services/execution";
import { processNow } from "@sincpro/client-framework/services/process";

export interface LayerLogger {
  debug(message: string, attributes?: Attributes): void;
  info(message: string, attributes?: Attributes): void;
  warn(message: string, attributes?: Attributes): void;
  error(message: string, attributes?: Attributes): void;
  forLayer(layer: LogLayer): LayerLogger;
}

/** Sink failures cannot replace a business outcome or cause unhandled async rejections. */
function deliver(logger: Logger | undefined, record: LogRecord): void {
  if (!logger) return;
  try {
    const pending = logger.log(record);
    if (pending) void Promise.resolve(pending).catch(() => {});
  } catch {
    // Logging adapters are best-effort, as are tracing and error-reporting adapters.
  }
}

function correlation(execution?: Execution) {
  if (!execution) return {};
  return {
    boundedContext: execution.boundedContext,
    useCase: execution.useCase,
    executionId: execution.id,
    ...(execution.span.traceId ? { traceId: execution.span.traceId } : {}),
    ...(execution.span.spanId ? { spanId: execution.span.spanId } : {}),
  };
}

function layerLogger(
  layer: LogLayer,
  sink: () => Logger | undefined,
  execution?: Execution,
): LayerLogger {
  const write = (level: LogLevel, message: string, attributes?: Attributes) => {
    const destination = sink();
    if (!destination) return;
    deliver(destination, {
      timestamp: new Date().toISOString(),
      level,
      layer,
      message,
      ...(attributes ? { attributes: { ...attributes } } : {}),
      ...correlation(execution),
    });
  };
  const logger: LayerLogger = {
    debug: (message, attributes) => write("debug", message, attributes),
    info: (message, attributes) => write("info", message, attributes),
    warn: (message, attributes) => write("warn", message, attributes),
    error: (message, attributes) => write("error", message, attributes),
    forLayer: (next) => layerLogger(next, sink, execution),
  };
  Object.defineProperty(logger, BIND, {
    value: (run: Execution) => executionLogger(layer, run, sink()),
    enumerable: false,
  });
  return logger;
}

/** Make once per layer; unbound loggers read the process sink when called, not at import. */
export function loggerFor(layer: LogLayer): LayerLogger {
  return layerLogger(layer, () => processNow().logger);
}

export const logger = loggerFor("global");
export const loggerUseCases = loggerFor("use_cases");
export const loggerFeature = loggerFor("feature");
export const loggerApplicationService = loggerFor("application_service");
export const loggerAdapter = loggerFor("adapter");
export const loggerRepositories = loggerFor("repositories");
export const loggerTransport = loggerFor("transport");
export const loggerQueueProcessor = loggerFor("event_bus");
export const loggerCronJobs = loggerFor("cron");

/** @internal — execution context is explicit, never recovered from a global async stack. */
export function executionLogger(
  layer: LogLayer,
  execution: Execution,
  logger: Logger | undefined,
): LayerLogger {
  return layerLogger(layer, () => logger, execution);
}

/** Each destination keeps its own policy; one failing sink does not hold back the others. */
export function combineLoggers(...loggers: readonly Logger[]): Logger {
  return {
    log: (record) => {
      for (const logger of loggers) deliver(logger, record);
    },
  };
}

/** @internal — lifecycle records contain correlation and outcome, never business payloads. */
export function logExecution(
  logger: Logger | undefined,
  layer: "feature" | "application_service",
  execution: Execution,
  completed?: { outcome: Outcome; durationMs: number },
): void {
  if (!logger) return;
  const outcome = completed?.outcome;
  const level: LogLevel =
    outcome === "failed"
      ? "error"
      : outcome === "refused"
        ? "warn"
        : completed
          ? "info"
          : "debug";
  deliver(logger, {
    timestamp: new Date().toISOString(),
    level,
    layer,
    event: completed ? "execution.finished" : "execution.started",
    message: completed ? `Execution ${completed.outcome}` : "Execution started",
    ...correlation(execution),
    ...(completed ? completed : {}),
  });
}
