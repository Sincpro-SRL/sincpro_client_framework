import { TransportError } from "@sincpro/client-framework/client/transport";
import {
  type Context,
  contextAt,
  type StoreSource,
} from "@sincpro/client-framework/context/context";
import { type ContextStore, memoryContexts } from "@sincpro/client-framework/context/store";
import {
  consoleLogger,
  type ConsoleLoggerOptions,
} from "@sincpro/client-framework/observability/console";
import {
  type ErrorReporter,
  type Logger,
  NO_TRACER,
  type Outcome,
  type Tracer,
} from "@sincpro/client-framework/observability/ports";

/**
 * What every bounded context of this process runs with — set once, in `main`, the way
 * sincpro_framework's process is: who traces, who reports, where the context lives.
 *
 *     // entrypoints/main.tsx — the platform's pieces, built from the application's settings
 *     configureProcess({
 *       tracer: browserTracer({ endpoint: settings.otlp, service: "forge-web" }),
 *       reporter: glitchtipReporter({ dsn: settings.glitchtip }),
 *       logger: applicationLogger,
 *       context: memoryContexts(),
 *     });
 *
 * Context: everything is optional, and nothing breaks without it. A process that never configures
 * runs untraced and unreported, with memory context and development console logging — so a bounded context is
 * usable the moment it is imported, and `main` adds what it watches with. The bounded contexts
 * read the process on every call, never at import: `project` may be defined before `main` runs.
 *
 * It replaces everything at once: what is not given goes back to its default — a test calls it
 * with its own tracer and starts from a clean context.
 */
export type ProcessOptions = {
  /** The platform's (OpenTelemetry in a browser, a queue on a phone, memory in a test). */
  tracer?: Tracer;
  /** The platform's (GlitchTip, Sentry, memory in a test). Only what nobody expected reaches it. */
  reporter?: ErrorReporter;
  /** Defaults to the console engine. False disables logging; a supplied engine owns its policy. */
  logger?: Logger | false;
  /** Mode for the default console engine; the host selects production explicitly. */
  mode?: ConsoleLoggerOptions["mode"];
  /** Where the context lives (`memoryContexts()` by default). */
  context?: ContextStore;
  /** How an error ended a use case (`outcomeOf` by default). Only `failed` is reported. */
  outcomeOf?: (error: unknown) => Outcome;
};

export type LoggerConfiguration = Omit<ConsoleLoggerOptions, "mode"> & {
  mode?: ConsoleLoggerOptions["mode"];
  engine?: Logger | false;
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
    level: options.level,
    layers: options.layers,
  });
}

/** The process as a use case reads it. Not public: `configureProcess` is the way in. */
export type Process = {
  readonly tracer: Tracer;
  readonly reporter: ErrorReporter | undefined;
  readonly logger: Logger | undefined;
  readonly store: ContextStore;
  readonly outcomeOf: (error: unknown) => Outcome;
};

function settled(options: ProcessOptions): Process {
  return {
    tracer: options.tracer ?? NO_TRACER,
    reporter: options.reporter,
    logger: loggingEngine({ engine: options.logger, mode: options.mode }),
    store: options.context ?? memoryContexts(),
    outcomeOf: options.outcomeOf ?? outcomeOf,
  };
}

let current: Process = settled({});
const replacing = new Set<() => void>();

export function configureProcess(options: ProcessOptions = {}): void {
  const before = current.store;
  current = settled(options);
  if (current.store !== before) for (const listener of [...replacing]) listener();
}

/** Replace logging only; existing tracing, reporting and context remain untouched. */
export function configureLogger(options: LoggerConfiguration = {}): void {
  current = { ...current, logger: loggingEngine(options) };
}

/** The process's store as every level of the context reads it — the process's and each bounded context's. */
export const processStore: StoreSource = {
  current: () => current.store,
  replaced(listener) {
    replacing.add(listener);
    return () => void replacing.delete(listener);
  },
};

/** What the process runs with now. */
export function processNow(): Process {
  return current;
}

/**
 * The process's level of the context: what every use case of every bounded context runs with —
 * the tenant, the company, the language.
 *
 *     processContext.set({ tenant_id: "acme" });
 */
export const processContext: Context = contextAt("process", processStore);

/**
 * How an error ended a use case, by default.
 *
 * Context: the backend reports what nobody expected and only that — a refusal it explained is
 * the business answering, not a fault. Here the same: a `TransportError` the server answered
 * with a 4xx is `refused`; a request the caller stopped waiting for is `aborted`; everything
 * else — a bug, a 5xx, a server nobody could reach — is `failed`, and reported.
 */
export function outcomeOf(error: unknown): Outcome {
  if (error instanceof TransportError && error.status !== null)
    return error.status >= 400 && error.status < 500 ? "refused" : "failed";
  if (
    error !== null &&
    typeof error === "object" &&
    (error as { name?: unknown }).name === "AbortError"
  )
    return "aborted";
  return "failed";
}
