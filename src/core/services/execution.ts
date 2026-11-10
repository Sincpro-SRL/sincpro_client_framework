import { newEntityId } from "@sincpro/client-framework/common/ids";
import type { Execution } from "@sincpro/client-framework/context/domain/execution";
import type { ContextValues } from "@sincpro/client-framework/context/domain/store";
import type { ErrorHandler } from "@sincpro/client-framework/core/domain/errors";
import { bindDependency } from "@sincpro/client-framework/core/services/binding";
import { handled } from "@sincpro/client-framework/core/services/error-handlers";
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

export interface RuntimeService {
  execute(command: object): unknown;
}

type Layer = "feature" | "application_service";

export interface ExecutionOptions {
  readonly boundedContext: string;
  readonly name: string;
  readonly layer: Layer;
  /** What else its span says: the event it executes, the service it replaced. */
  readonly attributes?: Attributes;
  readonly dependencies: ReadonlyMap<string, unknown>;
  readonly context: () => ContextValues;
  readonly parent?: Execution;
  readonly featureBus: (execution: Execution) => object;
  /** The bounded context's expected errors: they end `refused`, never reported. */
  readonly expected: (error: unknown) => boolean;
  /** The bounded context's handlers for this layer: what answers a failure instead of raising it. */
  readonly handlers: readonly ErrorHandler[];
}

const REPORTED_BY_EXECUTION = new WeakMap<Execution, Set<unknown>>();

/** Observability adapters are best-effort; their failures must not replace a business result. */
function observe<T>(work: () => T, fallback: T): T {
  try {
    return work();
  } catch {
    return fallback;
  }
}

function serviceView(
  target: RuntimeService,
  options: ExecutionOptions,
  execution: Execution,
) {
  const dependencies = new Map<string, unknown>();
  const logger = executionLogger(options.layer, execution);
  let features: object | undefined;
  return new Proxy(target, {
    get(held, property, receiver) {
      if (property === "context") return execution.context;
      if (property === "span") return execution.span;
      if (property === "logger") return logger;
      if (property === "featureBus" && options.layer === "application_service") {
        return (features ??= options.featureBus(execution));
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
        property === "featureBus" ||
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

/**
 * One pipeline for every registered Feature and ApplicationService.
 *
 * 1. A span `<bounded context>/<serviceName>`, a child of the parent run when there is one, and
 *    the execution every dependency, `this.logger` and child Feature are bound to.
 * 2. The service runs, seeing that execution through its own view of the instance.
 * 3. A failure is observed where it happened: its outcome (expected by the bounded context →
 *    `refused`, else the process's `outcomeOf`), the span closed with it, its log line and —
 *    when `failed`, and only once per error along the run — its report.
 * 4. Then the layer's error handlers answer it, in order; with none, or when the last throws,
 *    the error reaches the caller.
 * Final: the service's answer, or its handlers'.
 */
export async function executeService(
  target: RuntimeService,
  command: object,
  options: ExecutionOptions,
): Promise<unknown> {
  const ports = observabilityNow();
  const startedAt = Date.now();
  const useCase = `${options.boundedContext}.${options.name}`;
  const context = options.parent?.context ?? options.context();
  const id = newEntityId();
  const attributes: Attributes = {
    "sincpro.use_case": useCase,
    "sincpro.layer": options.layer,
    "sincpro.context": options.boundedContext,
    "sincpro.execution_id": id,
    ...options.attributes,
  };
  const span: Span = observe(
    () =>
      ports.tracer.start(`${options.boundedContext}/${options.name}`, {
        ...(options.parent ? { parent: options.parent.span } : {}),
        attributes,
      }),
    NO_TRACER.start(useCase, {}),
  );
  const execution: Execution = {
    id,
    useCase,
    boundedContext: options.boundedContext,
    parent: options.parent,
    span,
    context,
  };
  const reported = options.parent
    ? (REPORTED_BY_EXECUTION.get(options.parent) ?? new Set<unknown>())
    : new Set<unknown>();
  REPORTED_BY_EXECUTION.set(execution, reported);
  logExecution(options.layer, execution);

  const finish = (error?: { value: unknown }) => {
    const outcome: Outcome = error
      ? observe(
          () => (options.expected(error.value) ? "refused" : ports.outcomeOf(error.value)),
          "failed",
        )
      : "ok";
    observe(() => span.end(outcome, error?.value), undefined);
    logExecution(options.layer, execution, {
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
          }),
        undefined,
      );
    }
  };

  let answer: unknown;
  try {
    answer = await Reflect.apply(target.execute, serviceView(target, options, execution), [
      command,
    ]);
  } catch (error) {
    finish({ value: error });
    if (options.handlers.length === 0) throw error;
    const recovered = await handled(options.handlers, error);
    logHandled(options.layer, { execution });
    return recovered;
  }
  finish();
  return answer;
}
