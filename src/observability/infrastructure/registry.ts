import { consoleLogger } from "@sincpro/client-framework/observability/adapters/console";
import type { ErrorReporter } from "@sincpro/client-framework/observability/domain/errors";
import type { ProcessIdentity } from "@sincpro/client-framework/observability/domain/identity";
import type { Logger } from "@sincpro/client-framework/observability/domain/logging";
import {
  NO_TRACER,
  type Outcome,
  type Tracer,
} from "@sincpro/client-framework/observability/domain/tracing";
import { outcomeOf } from "@sincpro/client-framework/observability/services/outcome";

/**
 * The observability this process runs with: who traces, who reports, where logs go and how an
 * error ended a use case — the ports `configureProcess` plugged, read on every call.
 *
 * Context: sincpro_framework keeps the same state in its `observability_registry`, outside the
 * buses, so a test resets everything with one call. Until a process configures, nothing traces,
 * nothing reports, and logs go to the console in development mode.
 */
export type ObservabilityPorts = {
  /** Who is running: its release and the deployment's tenant, on every signal. */
  readonly identity: ProcessIdentity | undefined;
  readonly tracer: Tracer;
  readonly reporter: ErrorReporter | undefined;
  readonly logger: Logger | undefined;
  readonly outcomeOf: (error: unknown) => Outcome;
};

const DEFAULTS: ObservabilityPorts = {
  identity: undefined,
  tracer: NO_TRACER,
  reporter: undefined,
  logger: consoleLogger({ mode: "development" }),
  outcomeOf,
};

let current: ObservabilityPorts = DEFAULTS;

/** What the process observes with now. */
export function observabilityNow(): ObservabilityPorts {
  return current;
}

/** @internal — `configureProcess` and `configureLogger` are the way in. */
export function replaceObservability(ports: Partial<ObservabilityPorts>): void {
  current = { ...current, ...ports };
}
