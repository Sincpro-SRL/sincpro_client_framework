import { newEntityId } from "@sincpro/client-framework/client/ids";
import type { Attributes, Span } from "@sincpro/client-framework/observability/ports";
import { bindDependency, type Execution } from "@sincpro/client-framework/services/execution";
import { DETACHED, type Runtime } from "@sincpro/client-framework/services/runtime";

/**
 * One use case. What it needs from outside — the generated client of its domain, another
 * adapter — comes in `deps`, typed by the subclass.
 *
 *     export class SendIssue extends Feature<{ project: ProjectClient }> {
 *       execute(input: dto.CommandSendIssue) {
 *         return this.deps.project.sendIssue(input);
 *       }
 *     }
 *
 * Context: all of a client's logic lives in Features and ApplicationServices, as in
 * sincpro_framework and @sincpro/mobile, and none of them writes a span or catches an error to
 * report it: `new` answers the instance behind interceptors, and every public method runs
 * inside its own execution — a span named `<domain>/<name>`, the context it runs with, its
 * report if nobody expected how it failed. `execute` is a use case's entry; another public
 * method is traced as `<name>.<method>`, and a name that starts with `_` is not traced at all.
 *
 * Inside a method, `this.deps` and `this.context` are this run's own: each dependency that can
 * be (the transport, a generated client) is bound to the execution, so its requests carry this
 * run's trace. So a Feature keeps nothing of a request on `this`, and declares no `#private`
 * fields — the run sees the instance through a view of its own, and `#private` refuses views;
 * TypeScript's `private` is the same promise without that.
 */
export class Feature<Deps extends object = Record<string, never>> {
  protected readonly deps: Deps;
  /** What this run executes with (`RuntimeOptions.context`): empty outside a run. */
  protected readonly context: Readonly<Record<string, unknown>> = NO_CONTEXT;

  constructor(deps?: Deps) {
    this.deps = deps ?? ({} as Deps);
    // A class constructor that answers another object hands THAT to `new` and to every subclass
    // constructor after it: their fields land on the instance through the proxy.
    return intercepted(this, { runtime: DETACHED, domain: undefined, name: undefined });
  }
}

/**
 * A use case that composes the Features of its own domain — the only difference with a
 * Feature. Each call to one of them is a child of this run: its span under this span, the same
 * context, the same trace on the wire.
 *
 *     export class CloseIssue extends ApplicationService<{ preview: PreviewClose; send: SendIssue }> {
 *       async execute(input: CloseIssueInput) {
 *         const preview = await this.features.preview.execute(input);
 *         if (preview.warnings.length > 0) return { blocked: preview };
 *         return this.features.send.execute({ ...input, message: "cerrado" });
 *       }
 *     }
 *
 * Context: it never executes another ApplicationService — sincpro_framework's rule, refused here
 * when it is constructed rather than found in a trace later.
 */
export class ApplicationService<
  Features extends Readonly<Record<string, Feature<object>>>,
  Deps extends object = Record<string, never>,
> extends Feature<Deps> {
  protected readonly features: Features;

  constructor(features: Features, deps?: Deps) {
    super(deps);
    for (const [name, feature] of Object.entries(features))
      if (targetOf(feature) instanceof ApplicationService)
        throw new Error(
          `${this.constructor.name}: "${name}" is an ApplicationService — an ApplicationService executes Features, never another ApplicationService`,
        );
    this.features = features;
  }
}

/**
 * The services of a bounded context, each running in this runtime under that domain: traced as
 * `<domain>/<key>`, reported by its reporter, with its context.
 *
 *     const project = bindServices(runtime, "project", { sendIssue, closeIssue });
 *
 * Context: a span is named by the key it is bound with, not by the class — a production build
 * renames classes, never the keys of an object.
 */
export function bindServices<Services extends Readonly<Record<string, Feature<object>>>>(
  runtime: Runtime,
  domain: string,
  services: Services,
): Services {
  return Object.fromEntries(
    Object.entries(services).map(([name, service]) => [
      name,
      intercepted(targetOf(service), { runtime, domain, name }),
    ]),
  ) as unknown as Services;
}

const NO_CONTEXT: Readonly<Record<string, unknown>> = Object.freeze({});

/** Where a use case runs, and as what: what its executions are made of. */
type Binding = {
  runtime: Runtime;
  domain: string | undefined;
  /** The key it was bound or composed under; the class's name when it was neither. */
  name: string | undefined;
  /** The run that executes it: an ApplicationService's, for its Features. */
  parent?: Execution;
};

const TARGETS = new WeakMap<object, object>();

function targetOf<T extends object>(feature: T): T {
  return (TARGETS.get(feature) as T | undefined) ?? feature;
}

/** The methods a class adds over Feature — what is traced — read once per class. */
const METHODS = new WeakMap<object, ReadonlySet<string>>();

function methodsOf(target: object): ReadonlySet<string> {
  const prototype = Object.getPrototypeOf(target) as object;
  const known = METHODS.get(prototype);
  if (known !== undefined) return known;
  const names = new Set<string>();
  for (
    let level: object | null = prototype;
    level !== null && level !== Feature.prototype && level !== Object.prototype;
    level = Object.getPrototypeOf(level) as object | null
  )
    for (const name of Object.getOwnPropertyNames(level)) {
      const descriptor = Object.getOwnPropertyDescriptor(level, name);
      if (
        name !== "constructor" &&
        !name.startsWith("_") &&
        typeof descriptor?.value === "function"
      )
        names.add(name);
    }
  METHODS.set(prototype, names);
  return names;
}

function intercepted<T extends object>(target: T, binding: Binding): T {
  const proxy = new Proxy(target, {
    get(held, property) {
      const value: unknown = Reflect.get(held, property, held);
      if (typeof property !== "string" || typeof value !== "function") return value;
      if (!methodsOf(held).has(property)) return value;
      return (...args: unknown[]) =>
        run(held, property, value as (...args: unknown[]) => unknown, args, binding);
    },
  });
  TARGETS.set(proxy, target);
  return proxy;
}

/**
 * Whether this is the first run to report this error. A Feature that fails inside an
 * ApplicationService throws through it: the error is reported once, by the run where it
 * happened — its span is the one that says where — and every run around it still ends `failed`.
 */
const REPORTED = new WeakSet<object>();

function firstReport(error: unknown): boolean {
  if (error === null || (typeof error !== "object" && typeof error !== "function"))
    return true;
  if (REPORTED.has(error)) return false;
  REPORTED.add(error);
  return true;
}

function quietly<T>(work: () => T, otherwise: T): T {
  try {
    return work();
  } catch {
    return otherwise;
  }
}

const NO_SPAN: Span = {
  traceId: "",
  spanId: "",
  sampled: false,
  set: () => undefined,
  end: () => undefined,
};

function run(
  target: object,
  method: string,
  body: (...args: unknown[]) => unknown,
  args: unknown[],
  binding: Binding,
): unknown {
  const { runtime, domain, parent } = binding;
  const name = binding.name ?? target.constructor.name;
  const useCase = `${domain === undefined ? "" : `${domain}/`}${name}${method === "execute" ? "" : `.${method}`}`;
  const context = parent?.context ?? quietly(() => runtime.context(), NO_CONTEXT);
  const composes = target instanceof ApplicationService;
  const id = newEntityId();
  const attributes: Attributes = {
    "sincpro.use_case": useCase,
    "sincpro.layer": composes ? "application_service" : "feature",
    "sincpro.execution_id": id,
    ...(domain === undefined ? {} : { "sincpro.domain": domain }),
  };
  const span = quietly(
    () =>
      runtime.tracer.start(useCase, {
        ...(parent === undefined ? {} : { parent: parent.span }),
        attributes,
      }),
    NO_SPAN,
  );
  const execution: Execution = { id, useCase, domain, parent, span, context };

  // The run's own view of the instance: its dependencies bound to this execution, its context,
  // and — for an ApplicationService — its Features as children of this run.
  const own = target as { deps?: Record<string, unknown>; features?: Record<string, object> };
  const view: object = Object.create(target, {
    deps: {
      value: Object.fromEntries(
        Object.entries(own.deps ?? {}).map(([key, dependency]) => [
          key,
          bindDependency(dependency, execution),
        ]),
      ),
    },
    context: { value: context },
    ...(composes
      ? {
          features: {
            value: Object.fromEntries(
              Object.entries(own.features ?? {}).map(([key, feature]) => [
                key,
                intercepted(targetOf(feature), {
                  runtime,
                  domain,
                  name: key,
                  parent: execution,
                }),
              ]),
            ),
          },
        }
      : {}),
  });

  const finish = (failed: boolean, error?: unknown) => {
    const outcome = failed ? quietly(() => runtime.outcomeOf(error), "failed") : "ok";
    quietly(() => span.end(outcome, error), undefined);
    if (outcome === "failed" && firstReport(error))
      quietly(
        () =>
          runtime.reporter?.report(error, {
            useCase,
            traceId: span.traceId,
            executionId: id,
            context,
          }),
        undefined,
      );
  };

  let answer: unknown;
  try {
    answer = body.apply(view, args);
  } catch (error) {
    finish(true, error);
    throw error;
  }
  if (answer instanceof Promise)
    return answer.then(
      (value: unknown) => {
        finish(false);
        return value;
      },
      (error: unknown) => {
        finish(true, error);
        throw error;
      },
    );
  finish(false);
  return answer;
}
