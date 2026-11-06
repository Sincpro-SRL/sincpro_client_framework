import { newEntityId } from "@sincpro/client-framework/common/ids";
import { type Context, contextAt } from "@sincpro/client-framework/context/context";
import type { ContextValues } from "@sincpro/client-framework/context/store";
import type { Attributes, Span } from "@sincpro/client-framework/observability/ports";
import { bindDependency, type Execution } from "@sincpro/client-framework/services/execution";
import {
  composes,
  isApplicationServiceClass,
  isFeatureClass,
  methodsOf,
  type ServiceClasses,
  type Services,
} from "@sincpro/client-framework/services/feature";
import {
  processContext,
  processNow,
  processStore,
} from "@sincpro/client-framework/services/process";
import { firstReport } from "@sincpro/client-framework/services/report";

/**
 * A bounded context: its dependencies, its services, and the one object everything else uses
 * them through — set up the way sincpro_framework sets one up.
 *
 *     // domains/project/infrastructure/dependencies.ts      ← what the services can count on
 *     export interface ProjectDependencies {
 *       client: ProjectClient;
 *       session: Session;
 *     }
 *     export function registerDependencies(bc: UseBoundedContext<ProjectDependencies>) {
 *       bc.addDependency("client", clientOf(transport));
 *       bc.addDependency("session", session);
 *       return bc;
 *     }
 *
 *     // domains/project/infrastructure/bounded_context.ts
 *     export class Feature extends BaseFeature<ProjectDependencies> {}
 *     export class ApplicationService extends BaseApplicationService<ProjectDependencies, ProjectFeatures> {}
 *     export function configProjectBoundedContext(name: string) {
 *       return registerDependencies(new UseBoundedContext<ProjectDependencies>(name));
 *     }
 *
 *     // domains/project/index.ts
 *     export const project = configProjectBoundedContext("project").register({
 *       features,                                  // { Issues, Notices }
 *       applicationServices,                       // { CloseAndNotify }
 *     });
 *
 *     // anywhere — a screen, another bounded context's adapter, a test
 *     await project.Issues.close(input);           // span "project/Issues.close"
 *     await project.CloseAndNotify.execute(input); // span "project/CloseAndNotify", its Features under it
 *
 * Context: sincpro_framework's `UseFramework` (being renamed to bounded context) with
 * `add_dependency`, and `project(Command(...))` written as a property: a service is reached by
 * the name it is registered under, so its span is named by that name — a production build renames
 * classes, never the keys of an object — and the type of `project` is the services it holds.
 *
 * `project` is light and never frozen. It holds references: the classes, the dependencies, and
 * one instance of each service, made the first time it is asked for and shared by everything
 * derived from it. Each call makes a small view of that instance — a few pointers — that carries
 * the call's trace. A screen or a test that needs its own variant derives one, with everything
 * else shared:
 *
 *     project.with({ client: fake })               other dependencies — a test, a demo
 *     project.scoped({ company_id: 2 })            more context for what runs through it — a window
 *
 * A service is a singleton of its bounded context: what a method writes on `this` stays for the
 * next call and for the call running beside it, as in sincpro_framework. What belongs to one
 * request goes in its arguments or its context, never on `this`.
 */
export type BoundedContext<
  D extends object,
  C extends object,
  F extends ServiceClasses,
  A extends ServiceClasses,
> = Services<F, D> &
  Services<A, D> & {
    readonly name: string;
    /** This bounded context's level of the context: under the process's, over a scope's. */
    readonly context: Context<C>;
    /** The same bounded context with other dependencies — the rest, and the services, shared. */
    with(dependencies: Partial<D>): BoundedContext<D, C, F, A>;
    /** The same bounded context with more context for what runs through it. */
    scoped(context: Partial<C>): BoundedContext<D, C, F, A>;
  };

/** Names `project` answers itself: no service is registered under them. */
const RESERVED = new Set(["name", "context", "with", "scoped"]);
/** Names a run answers on `this` itself: no dependency is added under them. */
const ANSWERED = new Set(["context", "feature", "span"]);

export class UseBoundedContext<D extends object, C extends object = ContextValues> {
  readonly name: string;
  /** This bounded context's level of the context, saved in the process's store. */
  readonly context: Context<C>;
  readonly #dependencies: Record<string, unknown> = {};

  constructor(name: string) {
    if (name === "" || name.includes("/"))
      throw new Error(
        `"${name}" is not a bounded context's name — it names its spans: "${name}/Issues.close"`,
      );
    this.name = name;
    this.context = contextAt<C>(`bounded_context:${name}`, processStore);
  }

  /** `value` is what every service of this bounded context finds at `this.<name>`. */
  addDependency<K extends keyof D & string>(name: K, value: D[K]): this {
    if (ANSWERED.has(name))
      throw new Error(
        `${this.name}: a dependency cannot be called "${name}" — every service answers this.${name} itself`,
      );
    this.#dependencies[name] = value;
    return this;
  }

  /**
   * The object the bounded context is used through: each service under its name. A dependency
   * added after this is seen too — the services read them on every call.
   */
  register<
    F extends ServiceClasses,
    A extends ServiceClasses = Record<never, never>,
  >(services: { features: F; applicationServices?: A }): BoundedContext<D, C, F, A> {
    const classes = new Map<string, new () => object>();
    const add = (key: string, service: new () => object) => {
      if (RESERVED.has(key))
        throw new Error(
          `${this.name}: no service can be called "${key}" — it is the bounded context's own`,
        );
      if (classes.has(key)) throw new Error(`${this.name}: two services are called "${key}"`);
      classes.set(key, service);
    };
    for (const [key, service] of Object.entries(services.features)) {
      if (typeof service !== "function" || !isFeatureClass(service))
        throw new Error(
          `${this.name}: "${key}" is not a Feature — an ApplicationService goes in applicationServices`,
        );
      add(key, service);
    }
    for (const [key, service] of Object.entries(services.applicationServices ?? {})) {
      if (typeof service !== "function" || !isApplicationServiceClass(service))
        throw new Error(
          `${this.name}: "${key}" is not an ApplicationService — a Feature goes in features`,
        );
      add(key, service);
    }
    const registry: Registry = {
      name: this.name,
      dependencies: this.#dependencies,
      classes,
      features: new Set(Object.keys(services.features)),
      instances: new Map(),
      context: this.context,
    };
    return assemble({ registry, overrides: {}, scope: {} }) as BoundedContext<D, C, F, A>;
  }
}

/** What a bounded context is made of, shared by everything derived from it. */
type Registry = {
  readonly name: string;
  /** The UseBoundedContext's own: a dependency added later is seen. */
  readonly dependencies: Readonly<Record<string, unknown>>;
  readonly classes: ReadonlyMap<string, new () => object>;
  /** The names that are Features — what an ApplicationService's `this.feature` offers. */
  readonly features: ReadonlySet<string>;
  /** One instance per service, made when first asked for. */
  readonly instances: Map<string, object>;
  readonly context: Context;
};

/** One way of using a bounded context: `project`, `project.with(…)`, `project.scoped(…)`. */
type Binding = {
  readonly registry: Registry;
  readonly overrides: Readonly<Record<string, unknown>>;
  readonly scope: ContextValues;
};

function assemble(binding: Binding): object {
  const { registry } = binding;
  const held: Record<string, unknown> = {};
  Object.defineProperties(held, {
    name: { value: registry.name, enumerable: true },
    context: { value: registry.context, enumerable: true },
    with: {
      value: (dependencies: Readonly<Record<string, unknown>>) =>
        assemble({ ...binding, overrides: { ...binding.overrides, ...dependencies } }),
    },
    scoped: {
      value: (values: ContextValues) =>
        assemble({ ...binding, scope: { ...binding.scope, ...values } }),
    },
  });
  // Each service is made and wrapped the first time it is asked for, then kept on this object.
  for (const key of registry.classes.keys())
    Object.defineProperty(held, key, {
      configurable: true,
      enumerable: true,
      get() {
        const service = intercepted(key, binding, undefined);
        Object.defineProperty(held, key, { value: service, enumerable: true });
        return service;
      },
    });
  return held;
}

function instanceOf(registry: Registry, key: string): object {
  const known = registry.instances.get(key);
  if (known !== undefined) return known;
  const Service = registry.classes.get(key);
  if (Service === undefined)
    throw new Error(`${registry.name}: no service is called "${key}"`);
  const made = new Service();
  registry.instances.set(key, made);
  return made;
}

/**
 * A service as its holder sees it: each public method runs in an execution of its own — a child
 * of `parent` when an ApplicationService runs it. A method is the same function every time it is
 * read, so a screen can keep it (`useService(project.Issues.close)`).
 */
function intercepted(key: string, binding: Binding, parent: Execution | undefined): object {
  const target = instanceOf(binding.registry, key);
  const traced = methodsOf(target);
  const methods = new Map<string, (...args: unknown[]) => unknown>();
  return new Proxy(target, {
    get(held, property) {
      const value: unknown = Reflect.get(held, property, held);
      if (
        typeof property !== "string" ||
        typeof value !== "function" ||
        !traced.has(property)
      )
        return value;
      let method = methods.get(property);
      if (method === undefined) {
        const body = value as (...args: unknown[]) => unknown;
        method = (...args: unknown[]) =>
          run(held, key, property, body, args, binding, parent);
        methods.set(property, method);
      }
      return method;
    },
  });
}

function dependencyOf(binding: Binding, name: string): { found: boolean; value: unknown } {
  if (Object.hasOwn(binding.overrides, name))
    return { found: true, value: binding.overrides[name] };
  if (Object.hasOwn(binding.registry.dependencies, name))
    return { found: true, value: binding.registry.dependencies[name] };
  return { found: false, value: undefined };
}

/**
 * The run's own view of the instance: its context, its dependencies bound to this execution
 * (each bound the first time it is read), and — for an ApplicationService — its Features as
 * children of this run. Anything else is the instance's.
 */
function viewOf(target: object, binding: Binding, execution: Execution): object {
  const bound = new Map<string, unknown>();
  let features: object | undefined;
  const isComposer = composes(target);
  return new Proxy(target, {
    get(held, property, receiver) {
      if (property === "context") return execution.context;
      if (property === "span") return execution.span;
      if (property === "feature" && isComposer)
        return (features ??= featuresOf(binding, execution));
      if (typeof property === "string") {
        if (bound.has(property)) return bound.get(property);
        const dependency = dependencyOf(binding, property);
        if (dependency.found) {
          const value = bindDependency(dependency.value, execution);
          bound.set(property, value);
          return value;
        }
      }
      return Reflect.get(held, property, receiver);
    },
    set(held, property, value) {
      if (ANSWERED.has(String(property))) return false;
      if (typeof property === "string" && dependencyOf(binding, property).found) return false;
      // What a method writes on `this` lands on the instance — it is the bounded context's.
      return Reflect.set(held, property, value);
    },
  });
}

/** An ApplicationService's `this.feature`: each Feature, asked by name, a child of the run. */
function featuresOf(binding: Binding, execution: Execution): object {
  const children = new Map<string, object>();
  return new Proxy(
    {},
    {
      get(_, property) {
        if (typeof property !== "string" || !binding.registry.features.has(property))
          return undefined;
        let child = children.get(property);
        if (child === undefined) {
          child = intercepted(property, binding, execution);
          children.set(property, child);
        }
        return child;
      },
    },
  );
}

const NOTHING: ContextValues = {};

/** What a gesture runs with: the process's context, under it the bounded context's, its scope's. */
function contextOf(binding: Binding): ContextValues {
  return {
    ...processContext.values,
    ...binding.registry.context.values,
    ...binding.scope,
  };
}

/** What watches a use case never changes what it answers: a tracer or reporter that throws is ignored. */
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
  key: string,
  method: string,
  body: (...args: unknown[]) => unknown,
  args: unknown[],
  binding: Binding,
  parent: Execution | undefined,
): unknown {
  const settings = processNow();
  const boundedContext = binding.registry.name;
  // As sincpro_framework names a use case: the span `context/Name`, the identity `context.Name`.
  const identity = method === "execute" ? key : `${key}.${method}`;
  const useCase = `${boundedContext}.${identity}`;
  const context = parent?.context ?? quietly(() => contextOf(binding), NOTHING);
  const id = newEntityId();
  const attributes: Attributes = {
    "sincpro.use_case": useCase,
    "sincpro.layer": composes(target) ? "application_service" : "feature",
    "sincpro.context": boundedContext,
    "sincpro.execution_id": id,
  };
  const span = quietly(
    () =>
      settings.tracer.start(`${boundedContext}/${identity}`, {
        ...(parent === undefined ? {} : { parent: parent.span }),
        attributes,
      }),
    NO_SPAN,
  );
  const execution: Execution = { id, useCase, boundedContext, parent, span, context };

  const finish = (failed: boolean, error?: unknown) => {
    const outcome = failed ? quietly(() => settings.outcomeOf(error), "failed") : "ok";
    quietly(() => span.end(outcome, error), undefined);
    if (outcome === "failed" && firstReport(error))
      quietly(
        () =>
          settings.reporter?.report(error, {
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
    answer = body.apply(viewOf(target, binding, execution), args);
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
