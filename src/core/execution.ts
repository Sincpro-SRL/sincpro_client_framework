import { newEntityId } from "@sincpro/client-framework/common/ids";
import type { ContextValues } from "@sincpro/client-framework/context/store";
import {
  executionLogger,
  type LayerLogger,
  logExecution,
} from "@sincpro/client-framework/core/logger";
import {
  type Attributes,
  NO_TRACER,
  type Outcome,
  type Span,
} from "@sincpro/client-framework/observability/ports";
import { bindDependency, type Execution } from "@sincpro/client-framework/services/execution";
import { processNow } from "@sincpro/client-framework/services/process";
import { firstReport } from "@sincpro/client-framework/services/report";

export interface RuntimeService {
  execute(command: object): unknown;
}

export interface ExecutionOptions {
  readonly boundedContext: string;
  readonly name: string;
  readonly layer: "feature" | "application_service";
  readonly dependencies: ReadonlyMap<string, unknown>;
  readonly context: () => ContextValues;
  readonly parent?: Execution;
  readonly featureBus: (execution: Execution) => object;
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
  logger: LayerLogger,
) {
  const dependencies = new Map<string, unknown>();
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

/** One pipeline for every registered Feature and ApplicationService. */
export async function executeService(
  target: RuntimeService,
  command: object,
  options: ExecutionOptions,
): Promise<unknown> {
  const settings = processNow();
  const startedAt = Date.now();
  const useCase = `${options.boundedContext}.${options.name}`;
  const context = options.parent?.context ?? options.context();
  const id = newEntityId();
  const attributes: Attributes = {
    "sincpro.use_case": useCase,
    "sincpro.layer": options.layer,
    "sincpro.context": options.boundedContext,
    "sincpro.execution_id": id,
  };
  const span: Span = observe(
    () =>
      settings.tracer.start(`${options.boundedContext}/${options.name}`, {
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
  const logger = executionLogger(options.layer, execution, settings.logger);
  logExecution(settings.logger, options.layer, execution);

  const finish = (error?: { value: unknown }) => {
    const outcome: Outcome = error
      ? observe(() => settings.outcomeOf(error.value), "failed")
      : "ok";
    observe(() => span.end(outcome, error?.value), undefined);
    logExecution(settings.logger, options.layer, execution, {
      outcome,
      durationMs: Math.max(0, Date.now() - startedAt),
    });
    if (outcome === "failed" && error && settings.reporter && !reported.has(error.value)) {
      reported.add(error.value);
      // Mark for reportError outside the call; a different root may report the same Error.
      firstReport(error.value);
      observe(
        () =>
          settings.reporter?.report(error.value, {
            useCase,
            traceId: span.traceId,
            executionId: id,
            context,
          }),
        undefined,
      );
    }
  };

  try {
    const answer: unknown = await Reflect.apply(
      target.execute,
      serviceView(target, options, execution, logger),
      [command],
    );
    finish();
    return answer;
  } catch (error) {
    finish({ value: error });
    throw error;
  }
}
