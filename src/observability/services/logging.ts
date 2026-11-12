import { BIND, type Execution } from "@sincpro/client-framework/context/domain/execution";
import { tenantOf, userOf } from "@sincpro/client-framework/observability/domain/identity";
import type {
  FailureDescription,
  LayerLogger,
  Logger,
  LogLayer,
  LogLevel,
  LogRecord,
} from "@sincpro/client-framework/observability/domain/logging";
import type {
  Attributes,
  Outcome,
} from "@sincpro/client-framework/observability/domain/tracing";
import { observabilityNow } from "@sincpro/client-framework/observability/infrastructure/registry";

/**
 * How code writes a log line: one logger per layer, all writing to the process's sink.
 *
 *     logger.info("Database opened")                   // infrastructure — the global logger
 *     loggerAdapter.debug("Printer answered", { ms })  // an adapter
 *     projectBoundedContext.logger.info("Catalog preloaded")         // a bounded context, outside a use case
 *     this.logger.info("Order checked")                // a Feature or ApplicationService
 *
 * Context: the application layer has no logger to import. A bounded context owns its own
 * (`projectBoundedContext.logger`, named after it, as sincpro_framework's `bus.logger`), and a run hands its
 * Features and ApplicationServices one bound to that execution (`this.logger`), which carries the
 * use case, the execution and its trace on every line. `logger` and `loggerAdapter` are for the
 * code around the use cases; injected as a dependency they are bound to each run too (`BIND`).
 * The sink is read when a line is written, never at import: a module may import its logger
 * before `main` configures the process.
 */

/** What a line says about where it was written: its bounded context, and the run when there is one. */
type Correlation = Pick<
  LogRecord,
  "boundedContext" | "useCase" | "executionId" | "correlationId" | "traceId" | "spanId"
> & {
  /** The run's context, which may name its tenant. */
  readonly runContext?: Readonly<Record<string, unknown>>;
};

const processSink = (): Logger | undefined => observabilityNow().logger;

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

/**
 * A line as it is delivered: where it was written, and who was running — the process's release
 * and the tenant (the run's context's, else the deployment's), when there is one.
 */
function recordOf(
  fields: Omit<LogRecord, "release" | "tenant" | "userId">,
  correlation: Correlation,
): LogRecord {
  const { runContext, ...where } = correlation;
  const identity = observabilityNow().identity;
  const tenant = tenantOf(runContext ?? {}, identity);
  const userId = userOf(runContext ?? {}, identity);
  return {
    ...fields,
    ...where,
    ...(identity ? { release: identity.release } : {}),
    ...(tenant ? { tenant } : {}),
    ...(userId ? { userId } : {}),
  };
}

function correlationOf(execution: Execution): Correlation {
  return {
    runContext: execution.context,
    boundedContext: execution.boundedContext,
    useCase: execution.useCase,
    executionId: execution.id,
    correlationId: execution.correlationId,
    ...(execution.span.traceId ? { traceId: execution.span.traceId } : {}),
    ...(execution.span.spanId ? { spanId: execution.span.spanId } : {}),
  };
}

function layerLogger(
  layer: LogLayer,
  sink: () => Logger | undefined,
  correlation: Correlation = {},
): LayerLogger {
  const write = (level: LogLevel, message: string, attributes?: Attributes) => {
    deliver(
      sink(),
      recordOf(
        {
          timestamp: new Date().toISOString(),
          level,
          layer,
          message,
          ...(attributes ? { attributes: { ...attributes } } : {}),
        },
        correlation,
      ),
    );
  };
  const logger: LayerLogger = {
    debug: (message, attributes) => write("debug", message, attributes),
    info: (message, attributes) => write("info", message, attributes),
    warn: (message, attributes) => write("warn", message, attributes),
    error: (message, attributes) => write("error", message, attributes),
  };
  Object.defineProperty(logger, BIND, {
    value: (run: Execution) => layerLogger(layer, sink, correlationOf(run)),
    enumerable: false,
  });
  return logger;
}

/** The infrastructure's logger — the global one: the code that starts and holds the application. */
export const logger: LayerLogger = layerLogger("infrastructure", processSink);

/** The adapters' logger: what talks to a printer, a database, another system. */
export const loggerAdapter: LayerLogger = layerLogger("adapter", processSink);

/** @internal — a bounded context's own logger (`projectBoundedContext.logger`). */
export function boundedContextLogger(name: string): LayerLogger {
  return layerLogger("bounded_context", processSink, { boundedContext: name });
}

/** A run's layer: a Feature's, an ApplicationService's or an event handler's. */
type RunLogLayer = Extract<LogLayer, "feature" | "application_service" | "event_handler">;

/** @internal — what a Feature or ApplicationService finds as `this.logger` while it runs. */
export function executionLogger(layer: RunLogLayer, execution: Execution): LayerLogger {
  return layerLogger(layer, processSink, correlationOf(execution));
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
  layer: RunLogLayer,
  execution: Execution,
  completed?: { outcome: Outcome; durationMs: number; failure?: FailureDescription },
): void {
  const outcome = completed?.outcome;
  // As sincpro_framework: an unexpected failure is an error; an expected one — a refusal, the
  // caller leaving — is information, without a stack.
  const level: LogLevel = outcome === "failed" ? "error" : completed ? "info" : "debug";
  const failure = completed?.failure;
  deliver(
    processSink(),
    recordOf(
      {
        timestamp: new Date().toISOString(),
        level,
        layer,
        event: completed ? "execution.finished" : "execution.started",
        message: completed
          ? `Execution ${completed.outcome}${failure ? `: ${summaryOf(failure)}` : ""}`
          : "Execution started",
        ...(completed ? completed : {}),
      },
      correlationOf(execution),
    ),
  );
}

/** `TypeError: x is undefined at SaveServer.execute (…)`, or where it failed when it was another run. */
function summaryOf(failure: FailureDescription): string {
  const what = failure.message ? `${failure.type}: ${failure.message}` : failure.type;
  if (failure.failedIn) return `${what} (in ${failure.failedIn})`;
  return failure.at ? `${what} at ${failure.at}` : what;
}

/**
 * @internal — an error a handler of the bounded context answered instead of raising: said once,
 * with where it was handled, never with the error itself.
 */
export function logHandled(
  layer: LogLayer,
  correlation: { execution: Execution } | { boundedContext: string },
): void {
  deliver(
    processSink(),
    recordOf(
      {
        timestamp: new Date().toISOString(),
        // As sincpro_framework: an error a handler answered is a warning.
        level: "warn",
        layer,
        event: "error.handled",
        message: "Error handled",
      },
      "execution" in correlation
        ? correlationOf(correlation.execution)
        : { boundedContext: correlation.boundedContext },
    ),
  );
}
