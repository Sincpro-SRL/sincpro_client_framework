import { TransportError } from "@sincpro/client-framework/client/transport";
import {
  type ErrorReporter,
  NO_TRACER,
  type Outcome,
  type Tracer,
} from "@sincpro/client-framework/observability/ports";

/**
 * What every use case of an application runs with: who traces, who reports, and the context
 * each one carries to the server.
 *
 *     const runtime = createRuntime({
 *       tracer,                                  // the platform's (OpenTelemetry, …)
 *       reporter,                                // the platform's (GlitchTip, …)
 *       context: () => ({ tenant_id: session.tenant }),
 *     });
 *     const project = bindServices(runtime, "project", { sendIssue, closeIssue });
 *     await project.closeIssue.execute({ issue_id: "acme-3" });
 *
 * Context: sincpro_framework's bus is what gives every use case its span, its error report and
 * its context; here the same comes from the interceptors of `Feature`, and this is what they
 * read. A use case that was never bound runs too — with nothing tracing and nothing reporting —
 * so a Feature is tested by constructing it.
 */
export type RuntimeOptions = {
  tracer?: Tracer;
  reporter?: ErrorReporter;
  /**
   * What a use case runs with, read once where a gesture starts and inherited by every use case
   * it executes. It is what services read (`this.context`) and what travels to the server in
   * `sincpro-context` — never a secret: the token goes in the transport's headers.
   */
  context?: () => Readonly<Record<string, unknown>>;
  /** How an error ended a use case (`outcomeOf` by default). Only `failed` is reported. */
  outcomeOf?: (error: unknown) => Outcome;
};

export type Runtime = {
  readonly tracer: Tracer;
  readonly reporter: ErrorReporter | undefined;
  readonly context: () => Readonly<Record<string, unknown>>;
  readonly outcomeOf: (error: unknown) => Outcome;
};

const NO_CONTEXT: Readonly<Record<string, unknown>> = Object.freeze({});

export function createRuntime(options: RuntimeOptions = {}): Runtime {
  return {
    tracer: options.tracer ?? NO_TRACER,
    reporter: options.reporter,
    context: options.context ?? (() => NO_CONTEXT),
    outcomeOf: options.outcomeOf ?? outcomeOf,
  };
}

/** Where a use case that was never bound runs: nothing traces, nothing reports. */
export const DETACHED: Runtime = createRuntime();

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
