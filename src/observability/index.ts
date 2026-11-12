/**
 * Observability: the ports a platform plugs (`Tracer`, `ErrorReporter`, `Logger`), the console
 * engine logs go to by default, and how code writes and reports.
 *
 *   domain/          the ports: tracing, errors, logging; who is running (`identity`)
 *   adapters/        console (default), memory (`./testing`), OpenTelemetry and Sentry (optional
 *                    entries `./opentelemetry`, `./sentry`)
 *   infrastructure/  the ports this process runs with (`configureProcess` plugs them)
 *   services/        the loggers, `reportError`, the default `outcomeOf`
 */
export type {
  ErrorAbout,
  ErrorReporter,
} from "@sincpro/client-framework/observability/domain/errors";
export {
  identityOf,
  type ProcessIdentity,
  RELEASE,
  TENANT,
  tenantOf,
} from "@sincpro/client-framework/observability/domain/identity";
export type {
  LayerLogger,
  Logger,
  LogLayer,
  LogLevel,
  LogRecord,
} from "@sincpro/client-framework/observability/domain/logging";
export {
  type Attributes,
  NO_TRACER,
  type Outcome,
  type Span,
  type Tracer,
} from "@sincpro/client-framework/observability/domain/tracing";
export {
  combineLoggers,
  logger,
  loggerAdapter,
} from "@sincpro/client-framework/observability/services/logging";
export { outcomeOf } from "@sincpro/client-framework/observability/services/outcome";
export { reportError } from "@sincpro/client-framework/observability/services/reporting";
