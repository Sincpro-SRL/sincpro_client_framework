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
  type IdentityKeys,
  identityOf,
  type ProcessIdentity,
  RELEASE,
  TENANT,
  tenantOf,
  USER_ID,
  userOf,
} from "@sincpro/client-framework/observability/domain/identity";
export {
  type FailureDescription,
  isLogLevel,
  type LayerLogger,
  type LogFilter,
  type Logger,
  type LogLayer,
  type LogLevel,
  type LogRecord,
  speaks,
} from "@sincpro/client-framework/observability/domain/logging";
export {
  type Attributes,
  NO_TRACER,
  type Outcome,
  type Span,
  type Tracer,
} from "@sincpro/client-framework/observability/domain/tracing";
export { describeFailure } from "@sincpro/client-framework/observability/services/failure";
export {
  combineLoggers,
  filteredLogger,
  logger,
  loggerAdapter,
} from "@sincpro/client-framework/observability/services/logging";
export { outcomeOf } from "@sincpro/client-framework/observability/services/outcome";
export { reportError } from "@sincpro/client-framework/observability/services/reporting";
