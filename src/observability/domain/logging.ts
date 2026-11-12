import type {
  Attributes,
  Outcome,
} from "@sincpro/client-framework/observability/domain/tracing";

/**
 * What a platform plugs to receive structured logs: a sink (`Logger`) that owns filtering and
 * delivery — the console by default, Loki, a phone's queue, memory in a test.
 *
 * Context: a line says which layer wrote it, the way sincpro_framework's architecture names
 * them: the application layer (a bounded context and its ApplicationServices and Features,
 * through `projectBoundedContext.logger` and `this.logger`), its adapters (`loggerAdapter`) and
 * the infrastructure around them (`logger`). A line written inside a use case carries that
 * execution's identity; nothing writes a DTO, a response, an error body or the session's
 * context on its own.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

/** The layer a line comes from. */
export type LogLayer =
  | "infrastructure"
  | "adapter"
  | "bounded_context"
  | "event_handler"
  | "application_service"
  | "feature";

/** Structured logging never implicitly includes a DTO, response, error body or session context. */
/**
 * What a failure says — sincpro_framework's failure line: its type (`error.type`), its kind, its
 * fault and, when nobody expected it, its message, where it was raised and its stack. Told once,
 * by the run where it was raised; a run it crosses says only where it failed (`failedIn`).
 */
export type FailureDescription = {
  /** The class's name: `TypeError`, `TransportError`. */
  readonly type: string;
  /** The backend's failure kind (`invalid` … `internal`), or `aborted`. */
  readonly kind: string;
  /** The system's problem, not an answer to the caller. */
  readonly fault: boolean;
  /** An unexpected failure's message, cut at 500 characters. */
  readonly message?: string;
  /** The first frame outside the framework: the use case's own line. */
  readonly at?: string;
  /** An unexpected failure's stack — on the run where it was raised only. */
  readonly stack?: string;
  /** The use case it was raised in, when that is another run's. */
  readonly failedIn?: string;
};

export type LogRecord = {
  readonly timestamp: string;
  readonly level: LogLevel;
  readonly layer: LogLayer;
  readonly message: string;
  readonly attributes?: Attributes;
  readonly event?: "execution.started" | "execution.finished" | "error.handled";
  readonly boundedContext?: string;
  readonly useCase?: string;
  readonly executionId?: string;
  /** The chain the run belongs to: every run and event of one flow share it. */
  readonly correlationId?: string;
  readonly traceId?: string;
  readonly spanId?: string;
  readonly outcome?: Outcome;
  readonly durationMs?: number;
  /** Who was running (`configureProcess({ identity })`), when the process says. */
  readonly release?: string;
  /** The run's tenant — its context's, else the deployment's —, when there is one. */
  readonly tenant?: string;
  /** The run's user — its context's `user_id` —, when there is one. */
  readonly userId?: string;
  /** How the run failed, on its `execution.finished` line. */
  readonly failure?: FailureDescription;
};

/** A sink owns filtering and delivery. Logging is best-effort and never awaited by business work. */
export interface Logger {
  log(record: LogRecord): void | Promise<void>;
}

/** How code writes a line: the logger of a layer, of a bounded context, or of a run. */
export interface LayerLogger {
  debug(message: string, attributes?: Attributes): void;
  info(message: string, attributes?: Attributes): void;
  warn(message: string, attributes?: Attributes): void;
  error(message: string, attributes?: Attributes): void;
}

/**
 * Which INFO and DEBUG lines speak — by level, by layer and by bounded context. WARN and ERROR
 * always do: a failure is never silenced. What a filter does not name speaks.
 *
 *     { level: "info", layers: { adapter: false }, boundedContexts: { common: false } }
 *
 * Context: only lines are filtered, never spans — a quiet line still has its span, so a trace
 * shows every run. A line outside a run (the infrastructure's `logger`) has no bounded context
 * and is filtered by its layer alone.
 */
export type LogFilter = {
  /** The lowest level of INFO and DEBUG that speaks (`debug`: every one). */
  readonly level?: LogLevel;
  /** By layer: `false` keeps a layer's INFO and DEBUG quiet. */
  readonly layers?: Readonly<Partial<Record<LogLayer, boolean>>>;
  /** By bounded context's name: `false` keeps its INFO and DEBUG quiet. */
  readonly boundedContexts?: Readonly<Record<string, boolean>>;
};

const RANK: Readonly<Record<LogLevel, number>> = { debug: 0, info: 1, warn: 2, error: 3 };

/** Whether `level` is one a line can have. */
export function isLogLevel(level: unknown): level is LogLevel {
  return typeof level === "string" && Object.hasOwn(RANK, level);
}

/**
 * Whether `record` speaks under `filter`:
 * 1. WARN and ERROR, always.
 * 2. INFO and DEBUG at the filter's level or above, from a layer and a bounded context it does
 *    not keep quiet.
 */
export function speaks(record: LogRecord, filter: LogFilter): boolean {
  if (record.level === "warn" || record.level === "error") return true;
  if (RANK[record.level] < RANK[filter.level ?? "debug"]) return false;
  if (filter.layers?.[record.layer] === false) return false;
  const boundedContext = record.boundedContext;
  return !(
    boundedContext !== undefined && filter.boundedContexts?.[boundedContext] === false
  );
}
