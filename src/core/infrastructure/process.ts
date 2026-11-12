import { installTimeZoneKeys } from "@sincpro/client-framework/common/time";
import { memoryContexts } from "@sincpro/client-framework/context/adapters/memory";
import type { ContextStore } from "@sincpro/client-framework/context/domain/store";
import { replaceProcessStore } from "@sincpro/client-framework/context/infrastructure/process";
import {
  consoleLogger,
  type ConsoleLoggerOptions,
} from "@sincpro/client-framework/observability/adapters/console";
import type { ErrorReporter } from "@sincpro/client-framework/observability/domain/errors";
import {
  type IdentityKeys,
  identityOf,
  type ProcessIdentity,
} from "@sincpro/client-framework/observability/domain/identity";
import type { Logger } from "@sincpro/client-framework/observability/domain/logging";
import {
  NO_TRACER,
  type Outcome,
  type Tracer,
} from "@sincpro/client-framework/observability/domain/tracing";
import {
  observabilityNow,
  replaceObservability,
} from "@sincpro/client-framework/observability/infrastructure/registry";
import { outcomeOf } from "@sincpro/client-framework/observability/services/outcome";

/**
 * Where logs go: the console by default, any `Logger` otherwise, or nowhere.
 *
 *     { mode: "development", level: "info", layers: { adapter: false } }   // the console, filtered
 *     { mode: "production" }                                               // the console, silent
 *     { engine: combineLoggers(consoleLogger({ mode }), lokiLogger) }       // the platform's sinks
 *     { engine: false }                                                    // no logs
 *
 * Context: one shape for both doors — `configureProcess({ logger })`, which replaces everything,
 * and `configureLogger(...)`, which replaces only logging (a debug switch on a phone). `mode`,
 * `level` and `layers` configure the console engine; a supplied `engine` owns its own policy.
 */
export type LoggerConfiguration = Partial<ConsoleLoggerOptions> & {
  engine?: Logger | false;
};

/**
 * What every bounded context of this process runs with — set once, in `main`, the way
 * sincpro_framework's process is: who traces, who reports, where logs go, where the context lives.
 *
 *     // entrypoints/main.tsx — the platform's pieces, built from the application's settings
 *     configureProcess({
 *       identity: { release: "forge-web:1.4.0" },           // + tenant, when the deployment serves one
 *       tracer: browserTracer({ endpoint: settings.otlp, service: "forge-web" }),
 *       reporter: glitchtipReporter({ dsn: settings.glitchtip }),
 *       logger: { mode: settings.production ? "production" : "development" },
 *       context: memoryContexts(),
 *     });
 *
 * Context: everything is optional, and nothing breaks without it. A process that never configures
 * runs untraced and unreported, with memory context and development console logging — so a bounded
 * context is usable the moment it is imported, and `main` adds what it watches with. The bounded
 * contexts read the process on every call, never at import: `project` may be defined before `main`
 * runs.
 *
 * It replaces everything at once: what is not given goes back to its default — a test calls it
 * with its own tracer and starts from a clean context.
 */
export type ProcessOptions = {
  /**
   * Who is running — the backend's `APP_RELEASE` (`<name>:<version>`) and `TENANT`. Every span,
   * log line and report says its `release` and, when there is one, its `tenant` (the run's
   * context's, else this one) and its `user_id`; `service.name` and `service.version` are read
   * out of the release. Tenant and user are optional, and so are their keys: `keys` names the
   * context keys they are read from (`tenant`/`tenant_id` and `user_id` by default) — an
   * application whose tenant is its company says `keys: { tenant: "company_id" }`.
   */
  identity?: { release: string; tenant?: string; keys?: IdentityKeys };
  /**
   * The context key a run's time zone is read from (`timezone` by default — the backend's, see
   * `timeZoneOf`). Another key is read only here: the backend reads `timezone` alone.
   * An application that keeps its company's zone under another name says `keys: "company_zone"`
   * — or a list, the first found wins.
   */
  timeZone?: { keys?: string | readonly string[] };
  /** The platform's (OpenTelemetry in a browser, a queue on a phone, memory in a test). */
  tracer?: Tracer;
  /** The platform's (GlitchTip, Sentry, memory in a test). Only what nobody expected reaches it. */
  reporter?: ErrorReporter;
  /** Where logs go (`LoggerConfiguration`); the console in development mode by default. */
  logger?: LoggerConfiguration;
  /** Where the context lives (`memoryContexts()` by default). */
  context?: ContextStore;
  /** How an error ended a use case (`outcomeOf` by default). Only `failed` is reported. */
  outcomeOf?: (error: unknown) => Outcome;
};

function loggingEngine(options: LoggerConfiguration): Logger | undefined {
  if (options.engine === false) return undefined;
  if (options.engine !== undefined) {
    if (!options.engine || typeof options.engine.log !== "function") {
      throw new TypeError("Logger engine must implement log(record)");
    }
    return options.engine;
  }
  return consoleLogger({
    mode: options.mode ?? "development",
    ...(options.level ? { level: options.level } : {}),
    ...(options.layers ? { layers: options.layers } : {}),
  });
}

export function configureProcess(options: ProcessOptions = {}): void {
  const logger = loggingEngine(options.logger ?? {});
  replaceObservability({
    identity: options.identity
      ? identityOf(options.identity.release, options.identity.tenant, options.identity.keys)
      : undefined,
    tracer: options.tracer ?? NO_TRACER,
    reporter: options.reporter,
    logger,
    outcomeOf: options.outcomeOf ?? outcomeOf,
  });
  installTimeZoneKeys(options.timeZone?.keys);
  replaceProcessStore(options.context ?? memoryContexts());
}

/**
 * Who the process is running as (`configureProcess({ identity })`): what a platform's tracer puts
 * on its resource and its log shipping on its labels, so no adapter invents a key of its own.
 */
export function processIdentity(): ProcessIdentity | undefined {
  return observabilityNow().identity;
}

/** Replace logging only; tracing, reporting and the context stay as they are. */
export function configureLogger(options: LoggerConfiguration = {}): void {
  replaceObservability({ logger: loggingEngine(options) });
}
