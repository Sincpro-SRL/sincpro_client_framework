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
 * through `project.logger` and `this.logger`), its adapters (`loggerAdapter`) and the
 * infrastructure around them (`logger`). A line written inside a use case carries that
 * execution's identity; nothing writes a DTO, a response, an error body or the session's
 * context on its own.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

/** The layer a line comes from. */
export type LogLayer =
  "infrastructure" | "adapter" | "bounded_context" | "application_service" | "feature";

/** Structured logging never implicitly includes a DTO, response, error body or session context. */
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
