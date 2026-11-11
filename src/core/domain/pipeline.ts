import type { Execution } from "@sincpro/client-framework/context/domain/execution";
import type { Executable } from "@sincpro/client-framework/core/domain/dto";
import type { LayerLogger } from "@sincpro/client-framework/observability/domain/logging";
import type { Outcome } from "@sincpro/client-framework/observability/domain/tracing";

/**
 * Where the execution pipeline is extended — as sincpro_framework's `bus_pipeline`, in two kinds:
 *
 *     control       interceptors   wrap the service: look, veto, adjust or answer
 *     observation   listeners      a run started, answered, or a failure escaped: heard, never changed
 *
 *     projectBoundedContext.interceptor(CommandPay)(async (command, next, run) => {
 *       if (!credit.allows(command.customer_id)) throw new NoCredit();   // veto
 *       return next(command);                                             // the next, or the service
 *     });
 *     projectBoundedContext.onCompletion((done) => activity.succeeded(done.execution.useCase));
 *
 * Context: the core owns the flow — context, span, log lines, outcome, report, handlers — and
 * these are the places an application changes it from outside, without touching a service. An
 * interceptor runs inside the run: its veto is the use case's failure, observed and answered by
 * the error handlers like any other. A listener that fails is ignored: hearing never changes
 * the answer.
 */

/** Where a run sits: a Feature, an ApplicationService, or an event handler above them. */
export type PipelineLayer = "feature" | "application_service" | "event_handler";

/** What caused a run from outside: an event delivered with its envelope continues its chain. */
export type Cause = {
  /** The id of what caused it — a delivered message's. */
  readonly id: string;
  /** The chain it continues. */
  readonly correlationId: string;
  /** The trace it continues (W3C), when the message carried one: the run's span is its child. */
  readonly traceparent?: string;
  readonly tracestate?: string;
};

/**
 * How a Command or an event is executed: what cancels it, and — for a delivered event — what
 * caused it.
 *
 *     await salesBoundedContext.execute(new CommandQuote(3), { signal: screen.signal });
 *
 * Context: a screen that closes, a navigation that leaves, a user who gives up stop waiting; the
 * run ends `aborted` (not reported), its Features inherit the signal, and the requests its
 * transport sends are cancelled with it.
 */
export type ExecuteOptions = {
  readonly signal?: AbortSignal;
  readonly cause?: Cause;
};

/** The run an interceptor wraps: who runs, inside which execution, writing where. */
export type InterceptedRun = {
  readonly boundedContext: string;
  /** `<bounded context>.<Service>`: the service's name as registered. */
  readonly useCase: string;
  readonly layer: PipelineLayer;
  /** Its id, span, context and chain. */
  readonly execution: Execution;
  /** The run's logger, bound to it. */
  readonly logger: LayerLogger;
};

/** The rest of the chain: the next interceptor, or the service. */
export type CallNext<T extends Executable> = (executable: T) => Promise<unknown>;

/**
 * Runs around the service of a Command or an event. It passes on what it received — or another
 * of the same class: the bus routes by class, so another class would be another use case — and
 * returns what the next answered, or an answer of its own; it throws to veto.
 */
export type Interceptor<T extends Executable = Executable> = (
  executable: T,
  next: CallNext<T>,
  run: InterceptedRun,
) => unknown;

/** A run began. */
export type ExecutionStarted = {
  readonly executable: Executable;
  readonly execution: Execution;
  readonly layer: PipelineLayer;
};

/** A run's service answered. */
export type ExecutionCompleted = ExecutionStarted & {
  readonly answer: unknown;
  readonly durationMs: number;
};

/**
 * A failure escaped a call — after every handler —, said once, where it first failed. No
 * execution when it reached none: nothing is registered for the class.
 */
export type ExecutionFailed = {
  readonly executable: Executable;
  readonly execution: Execution | undefined;
  readonly layer: PipelineLayer | undefined;
  readonly error: unknown;
  readonly outcome: Outcome;
};

/** Who hears a moment of the pipeline. */
export type Listener<E> = (heard: E) => void;

/** A component wired into a bounded context: its interceptors, listeners, services. */
export type Extension<B> = (context: B) => void;
