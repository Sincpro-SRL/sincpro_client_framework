import { newEntityId } from "@sincpro/client-framework/common/ids";
import type { Execution } from "@sincpro/client-framework/context/domain/execution";
import type { ContextValues } from "@sincpro/client-framework/context/domain/store";
import type { Executable } from "@sincpro/client-framework/core/domain/dto";
import type { ErrorHandler } from "@sincpro/client-framework/core/domain/errors";
import type {
  Cause,
  ExecutionCompleted,
  ExecutionStarted,
  Interceptor,
  PipelineLayer,
} from "@sincpro/client-framework/core/domain/pipeline";
import { bindDependency } from "@sincpro/client-framework/core/services/binding";
import { handled } from "@sincpro/client-framework/core/services/error-handlers";
import { runAround } from "@sincpro/client-framework/core/services/interceptors";
import { tenantOf } from "@sincpro/client-framework/observability/domain/identity";
import {
  type Attributes,
  NO_TRACER,
  type Outcome,
  type Span,
} from "@sincpro/client-framework/observability/domain/tracing";
import { observabilityNow } from "@sincpro/client-framework/observability/infrastructure/registry";
import {
  executionLogger,
  logExecution,
  logHandled,
} from "@sincpro/client-framework/observability/services/logging";
import { firstReport } from "@sincpro/client-framework/observability/services/reporting";
import { remoteSpan } from "@sincpro/client-framework/observability/services/trace-context";

type Layer = PipelineLayer;

/** Where a failure first happened: the run, its executable, its layer and how it ended. */
export type FailedAt = {
  readonly execution: Execution;
  readonly executable: Executable;
  readonly layer: Layer;
  readonly outcome: Outcome;
};

const FAILED_AT = new WeakMap<object, FailedAt>();

/** Where `error` first failed, when it is an object a run threw; `undefined` otherwise. */
export function failedAt(error: unknown): FailedAt | undefined {
  return error !== null && typeof error === "object" ? FAILED_AT.get(error) : undefined;
}

/** Who hears the moments of a run: read when they happen, so a listener added later hears. */
export interface Announcer {
  started(heard: ExecutionStarted): void;
  completed(heard: ExecutionCompleted): void;
}

export interface ExecutionOptions {
  readonly boundedContext: string;
  readonly name: string;
  readonly layer: Layer;
  /** What else its span says: the event it executes, the service it replaced. */
  readonly attributes?: Attributes;
  readonly dependencies: ReadonlyMap<string, unknown>;
  readonly context: () => ContextValues;
  readonly parent?: Execution;
  /**
   * The run that called this root from outside its bounded context — a Feature of another
   * bounded context — through a bounded context bound to it (`BIND`): its span
   * is the parent, its flow continues, it is the cause and its signal cancels this one; the
   * context, dependencies and handlers stay this bounded context's.
   */
  readonly caller?: Execution;
  /** What caused a root run from outside: a delivered event's envelope continues its chain. */
  readonly cause?: Cause;
  /** What cancels a root run; a child inherits its parent's. */
  readonly signal?: AbortSignal;
  readonly featureBus: (execution: Execution) => object;
  /**
   * The bounded context an event handler of it reaches as `this.boundedContext`, bound to the
   * handler's run; none for a Feature, nor for a `Subscriber`'s handler.
   */
  readonly boundedContextOf?: (execution: Execution) => object;
  /** What runs around the service, outermost first. */
  readonly interceptors: readonly Interceptor[];
  /** Who hears it start and answer. */
  readonly announce: Announcer;
  /** The bounded context's expected errors: they end `refused`, never reported. */
  readonly expected: (error: unknown) => boolean;
  /** The bounded context's handlers for this layer: what answers a failure instead of raising it. */
  readonly handlers: readonly ErrorHandler[];
}

const REPORTED_BY_EXECUTION = new WeakMap<Execution, Set<unknown>>();

/** What a cancelled run fails with: an `AbortError`, whatever the signal was aborted with. */
function abortedBy(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error && reason.name === "AbortError") return reason;
  return Object.assign(new Error("The run was cancelled"), {
    name: "AbortError",
    cause: reason,
  });
}

/**
 * What `running` answers — or the cancellation, the moment `signal` aborts: the caller stops
 * waiting even when the service does not look at its signal.
 */
function untilAborted<T>(running: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortedBy(signal));
    signal.addEventListener("abort", abort, { once: true });
    running.then(
      (answer) => {
        signal.removeEventListener("abort", abort);
        resolve(answer);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

/** Observability adapters are best-effort; their failures must not replace a business result. */
function observe<T>(work: () => T, fallback: T): T {
  try {
    return work();
  } catch {
    return fallback;
  }
}

function serviceView(target: object, options: ExecutionOptions, execution: Execution) {
  const dependencies = new Map<string, unknown>();
  const logger = executionLogger(options.layer, execution);
  let features: object | undefined;
  let own: object | undefined;
  return new Proxy(target, {
    get(held, property, receiver) {
      if (property === "context") return execution.context;
      if (property === "span") return execution.span;
      if (property === "logger") return logger;
      if (property === "signal") return execution.signal;
      if (property === "execution") return execution;
      if (property === "featureBus" && options.layer === "application_service") {
        return (features ??= options.featureBus(execution));
      }
      if (property === "boundedContext" && options.boundedContextOf) {
        return (own ??= options.boundedContextOf(execution));
      }
      if (typeof property === "string" && options.dependencies.has(property)) {
        if (!dependencies.has(property)) {
          dependencies.set(
            property,
            bindDependency(options.dependencies.get(property), execution),
          );
        }
        return dependencies.get(property);
      }
      if (Reflect.has(held, property)) return Reflect.get(held, property, receiver);
      if (typeof property === "string") {
        throw new Error(
          `${options.boundedContext}: dependency or member is not registered: ${property}`,
        );
      }
      return undefined;
    },
    set(held, property, value) {
      if (
        property === "context" ||
        property === "span" ||
        property === "logger" ||
        property === "signal" ||
        property === "execution" ||
        property === "featureBus" ||
        property === "boundedContext" ||
        (typeof property === "string" && options.dependencies.has(property))
      ) {
        throw new Error(
          `Execution dependencies and context are read-only: ${String(property)}`,
        );
      }
      return Reflect.set(held, property, value);
    },
  });
}

/** What a run calls on its service: `handle` for an event handler, `execute` for a use case. */
function entryOf(layer: Layer): "handle" | "execute" {
  return layer === "event_handler" ? "handle" : "execute";
}

/**
 * One pipeline for every registered Feature, ApplicationService and event handler.
 *
 * 1. A span `<bounded context>/<Service>`, a child of the run above it when there is one (its
 *    parent, or the caller from outside), and the execution every dependency, `this.logger` and
 *    child Feature are bound to. Its chain: the run above's correlation (or the cause's, or its
 *    own id for a root), caused by the run above or the delivered event.
 * 2. Its start is announced; the interceptors run around the service, which sees the
 *    execution through its own view of the instance.
 * 3. A failure is observed where it happened: its outcome (expected by the bounded context →
 *    `refused`; else the outcome it already had where it first failed — another bounded
 *    context's rules —; else the process's `outcomeOf`), the span closed with it, its log line,
 *    where it first failed and — when `failed`, and only once per error along the flow — its
 *    report.
 * 4. Then the layer's error handlers answer it, in order; with none, or when the last throws,
 *    the error reaches the caller.
 * Final: the service's answer — announced —, or its handlers'.
 */
export async function executeService(
  target: object,
  command: Executable,
  options: ExecutionOptions,
): Promise<unknown> {
  const ports = observabilityNow();
  const startedAt = Date.now();
  const useCase = `${options.boundedContext}.${options.name}`;
  const context = options.parent?.context ?? options.context();
  const id = newEntityId();
  // The run above this one: its parent in the bounded context, or the caller from outside.
  const above = options.parent ?? options.caller;
  const correlationId = above?.correlationId ?? options.cause?.correlationId ?? id;
  const causationId = above?.id ?? options.cause?.id;
  const layer = options.layer;
  // Who is running, on the span as on its lines and its report.
  const release = ports.identity?.release;
  const tenant = tenantOf(context, ports.identity);
  const attributes: Attributes = {
    ...(release ? { release } : {}),
    ...(tenant ? { tenant } : {}),
    "sincpro.use_case": useCase,
    "sincpro.layer": options.layer,
    "sincpro.context": options.boundedContext,
    "sincpro.execution_id": id,
    "sincpro.correlation_id": correlationId,
    ...(causationId ? { "sincpro.causation_id": causationId } : {}),
    ...options.attributes,
  };
  // A delivered message from another process continues its trace: its span is the parent.
  const parentSpan =
    above?.span ??
    (options.cause?.traceparent
      ? remoteSpan(options.cause.traceparent, options.cause.tracestate)
      : undefined);
  const span: Span = observe(
    () =>
      ports.tracer.start(`${options.boundedContext}/${options.name}`, {
        ...(parentSpan ? { parent: parentSpan } : {}),
        attributes,
      }),
    NO_TRACER.start(useCase, {}),
  );
  const execution: Execution = {
    id,
    useCase,
    boundedContext: options.boundedContext,
    parent: above,
    correlationId,
    causationId,
    signal: options.signal ?? above?.signal,
    span,
    context,
  };
  const reported = above
    ? (REPORTED_BY_EXECUTION.get(above) ?? new Set<unknown>())
    : new Set<unknown>();
  REPORTED_BY_EXECUTION.set(execution, reported);
  logExecution(layer, execution);
  observe(
    () => options.announce.started({ executable: command, execution, layer }),
    undefined,
  );

  const finish = (error?: { value: unknown }): Outcome => {
    const outcome: Outcome = error
      ? observe(
          () =>
            options.expected(error.value)
              ? "refused"
              : (failedAt(error.value)?.outcome ?? ports.outcomeOf(error.value)),
          "failed",
        )
      : "ok";
    observe(() => span.end(outcome, error?.value), undefined);
    logExecution(layer, execution, {
      outcome,
      durationMs: Math.max(0, Date.now() - startedAt),
    });
    if (outcome === "failed" && error && ports.reporter && !reported.has(error.value)) {
      reported.add(error.value);
      // Mark for reportError outside the call; a different root may report the same Error.
      firstReport(error.value);
      observe(
        () =>
          ports.reporter?.report(error.value, {
            useCase,
            traceId: span.traceId,
            executionId: id,
            context,
            ...(release ? { release } : {}),
            ...(tenant ? { tenant } : {}),
          }),
        undefined,
      );
    }
    if (
      error?.value !== null &&
      typeof error?.value === "object" &&
      !FAILED_AT.has(error.value)
    )
      FAILED_AT.set(error.value, {
        execution,
        executable: command,
        layer,
        outcome,
      });
    return outcome;
  };

  const view = serviceView(target, options, execution);
  const execute = Reflect.get(target, entryOf(options.layer)) as (
    executable: Executable,
  ) => unknown;
  const service = (current: Executable) =>
    Promise.resolve(Reflect.apply(execute, view, [current]));
  let answer: unknown;
  try {
    const signal = execution.signal;
    if (signal?.aborted) throw abortedBy(signal);
    const running = runAround(options.interceptors, service, command, {
      boundedContext: options.boundedContext,
      useCase,
      layer,
      execution,
      logger: executionLogger(layer, execution),
    });
    answer = signal === undefined ? await running : await untilAborted(running, signal);
  } catch (error) {
    finish({ value: error });
    if (options.handlers.length === 0) throw error;
    const recovered = await handled(options.handlers, error);
    logHandled(layer, { execution });
    return recovered;
  }
  finish();
  observe(
    () =>
      options.announce.completed({
        executable: command,
        execution,
        layer,
        answer,
        durationMs: Math.max(0, Date.now() - startedAt),
      }),
    undefined,
  );
  return answer;
}
