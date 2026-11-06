import type { ContextValues } from "@sincpro/client-framework/context/store";
import type { Span } from "@sincpro/client-framework/observability/ports";

/**
 * `Feature` and `ApplicationService`: the two kinds of service a bounded context holds, as in
 * sincpro_framework. Each bounded context gives them its dependencies once, in its own base:
 *
 *     // domains/project/infrastructure/bounded_context.ts
 *     export class Feature extends BaseFeature<ProjectDependencies> {}
 *     export class ApplicationService extends BaseApplicationService<ProjectDependencies, ProjectFeatures> {}
 *
 *     // domains/project/services/issues.ts
 *     export class Issues extends Feature {
 *       close(input: dto.CommandCloseIssue) {
 *         this.session.require();                 // each dependency is a property — typed
 *         return this.client.closeIssue(input);
 *       }
 *     }
 *
 *     // domains/project/services/close_and_notify.ts
 *     export class CloseAndNotify extends ApplicationService {
 *       async execute(input: dto.CommandCloseIssue) {
 *         await this.feature.Issues.close(input);   // a child of this run, on the same trace
 *         return this.feature.Notices.tell(input);
 *       }
 *     }
 *
 * Context: a Feature is a facade — the operations of one part of the domain, each a public
 * method; an ApplicationService composes the Features of its own bounded context and never
 * another ApplicationService (sincpro_framework's rule). Neither writes a span nor catches an
 * error to report it: the bounded context runs every public method inside its own execution
 * (`UseBoundedContext`).
 *
 * The dependencies are typed, not declared: `BaseFeature<ProjectDependencies>` types
 * `this.client` and `this.session` from the bounded context's dependency type — sincpro_framework's
 * `DependencyContextType` — and the bounded context hands them in on each run. So a service
 * constructs with nothing, keeps no dependency on `this`, and declares no `#private` field: a run
 * sees the instance through a view of its own (its dependencies bound to its trace), and
 * `#private` refuses views. TypeScript's `private` is the same promise without that.
 */
class FeatureCore {}

class ApplicationServiceCore extends FeatureCore {}

/** What every service sees on `this` inside a method. */
type Within<D extends object, C extends object> = Readonly<D> & {
  /**
   * What this run executes with: the process's context, its bounded context's, its scope's —
   * read once where the gesture started and the same for every Feature it runs.
   */
  readonly context: Readonly<Partial<C>>;
  /** This run's span: a use case says more about what it ran on (`this.span.set({ … })`). */
  readonly span: Span;
};

/** Service classes by the name a bounded context gives them: `{ Issues, Notices }`. */
export type ServiceClasses = Readonly<Record<string, new () => object>>;

/**
 * What a service offers to whoever holds it — `project.Issues`, `this.feature.Issues`: its public
 * methods, without its dependencies, its context or its `_` helpers.
 */
export type ServiceMethods<I, D> = {
  readonly [
    M in keyof I as M extends keyof D | "context" | "feature" | "span" | `_${string}`
      ? never
      : I[M] extends (...args: never[]) => unknown
        ? M
        : never
  ]: I[M];
};

/** The services of a set of classes, by their names. */
export type Services<S extends ServiceClasses, D> = {
  readonly [K in keyof S]: ServiceMethods<InstanceType<S[K]>, D>;
};

type FeatureClass = abstract new <
  D extends object = Record<never, never>,
  C extends object = ContextValues,
>() => FeatureCore & Within<D, C>;

type ApplicationServiceClass = abstract new <
  D extends object = Record<never, never>,
  F extends ServiceClasses = Record<never, never>,
  C extends object = ContextValues,
>() => ApplicationServiceCore &
  Within<D, C> & {
    /** The Features of this bounded context, each run a child of this one. */
    readonly feature: Services<F, D>;
  };

/** The base of a bounded context's Features: `class Feature extends BaseFeature<Deps> {}`. */
export const Feature = FeatureCore as unknown as FeatureClass;

/**
 * The base of a bounded context's ApplicationServices:
 * `class ApplicationService extends BaseApplicationService<Deps, typeof features> {}`.
 */
export const ApplicationService =
  ApplicationServiceCore as unknown as ApplicationServiceClass;

/** Whether a class is a Feature — and not an ApplicationService. */
export function isFeatureClass(service: new () => object): boolean {
  return (
    service.prototype instanceof FeatureCore &&
    !(service.prototype instanceof ApplicationServiceCore)
  );
}

export function isApplicationServiceClass(service: new () => object): boolean {
  return service.prototype instanceof ApplicationServiceCore;
}

/** Whether a service composes Features — an ApplicationService. */
export function composes(service: object): boolean {
  return service instanceof ApplicationServiceCore;
}

/**
 * The methods a class adds over its base — what is traced — read once per class: every public
 * method of the class and its parents up to `Feature`, but `constructor` and a name that starts
 * with `_`.
 */
const METHODS = new WeakMap<object, ReadonlySet<string>>();

export function methodsOf(service: object): ReadonlySet<string> {
  const prototype = Object.getPrototypeOf(service) as object;
  const known = METHODS.get(prototype);
  if (known !== undefined) return known;
  const names = new Set<string>();
  for (
    let level: object | null = prototype;
    level !== null &&
    level !== ApplicationServiceCore.prototype &&
    level !== FeatureCore.prototype &&
    level !== Object.prototype;
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
