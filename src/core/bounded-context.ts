import { type Context, contextAt } from "@sincpro/client-framework/context/context";
import type { ContextValues } from "@sincpro/client-framework/context/store";
import { executeService } from "@sincpro/client-framework/core/execution";
import type { LayerLogger } from "@sincpro/client-framework/core/logger";
import type { Span } from "@sincpro/client-framework/observability/ports";
import type { Execution } from "@sincpro/client-framework/services/execution";
import { processContext, processStore } from "@sincpro/client-framework/services/process";

export abstract class DataTransferObject {
  declare protected readonly dtoBrand: void;
}

export abstract class Response extends DataTransferObject {}

declare const responseType: unique symbol;

export abstract class Command<R> extends DataTransferObject {
  /** Type-only association: absent from serialized DTOs and not a runtime validator. */
  declare readonly [responseType]: R;
}

type AnyCommand = Command<unknown>;
type CommandClass<C extends AnyCommand> = abstract new (...args: never[]) => C;
type ResponseClass<R> = abstract new (...args: never[]) => R;
type Answer<C extends AnyCommand> = C[typeof responseType];
type Layer = "feature" | "application_service";

interface Executor<C extends AnyCommand, R> {
  execute(command: C): R | Promise<R>;
}

type ServiceClass<C extends AnyCommand, R> = {
  new (): Executor<C, R>;
  readonly serviceName: string;
};

interface Registration {
  readonly name: string;
  readonly layer: Layer;
  readonly Service: ServiceClass<AnyCommand, unknown>;
}

type Dispatch = (command: AnyCommand) => Promise<unknown>;
type GenerationDispatch = (
  command: AnyCommand,
  parent?: Execution,
  featureOnly?: boolean,
  scope?: Readonly<object>,
) => Promise<unknown>;

function isExecutor(value: unknown): value is Executor<AnyCommand, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "execute" in value &&
    typeof value.execute === "function"
  );
}

function registrationOf(
  registrations: ReadonlyMap<CommandClass<AnyCommand>, Registration>,
  command: AnyCommand,
): Registration {
  for (const [commandType, registration] of registrations) {
    if (Object.getPrototypeOf(command) === commandType.prototype) return registration;
  }
  throw new Error("No executor registered for this command class");
}

async function executeTyped<R>(dispatch: Dispatch, command: Command<R>): Promise<R> {
  // The heterogeneous registry erases DTO types; registration checks the association.
  // As with Python's return_type, this does not validate the returned data at runtime.
  return (await dispatch(command)) as R;
}

export interface CommandBus {
  execute<R>(command: Command<R>, returnType?: ResponseClass<NoInfer<R>>): Promise<R>;
}

export class FeatureBus implements CommandBus {
  constructor(private readonly dispatch: Dispatch) {}

  execute<R>(command: Command<R>, _returnType?: ResponseClass<NoInfer<R>>): Promise<R> {
    return executeTyped(this.dispatch, command);
  }
}

export abstract class Feature<
  C extends Command<R>,
  R,
  Context extends object = ContextValues,
> {
  declare readonly context: Readonly<Partial<Context>>;
  declare readonly span: Span;
  declare readonly logger: LayerLogger;
  abstract execute(command: C): R | Promise<R>;
}

export abstract class ApplicationService<
  C extends Command<R>,
  R,
  Context extends object = ContextValues,
> extends Feature<C, R, Context> {
  declare protected readonly featureBus: FeatureBus;
}

const RESERVED_DEPENDENCIES = new Set(["featureBus", "context", "span", "logger"]);

/**
 * A command-oriented application core. Registrations and
 * dependencies are snapshotted per generation; running calls keep their original generation.
 */
export class BoundedContext<
  D extends object = Record<never, never>,
  C extends object = ContextValues,
> {
  readonly context: Context<C>;
  private readonly registrations = new Map<CommandClass<AnyCommand>, Registration>();
  private readonly dependencyValues = new Map<string, unknown>();
  private revision = 0;
  private builtRevision = -1;
  private dispatch: GenerationDispatch | undefined;

  constructor(readonly name: string) {
    if (name.trim() === "" || name.includes("/")) {
      throw new TypeError("A bounded context needs a nonempty name without '/'");
    }
    this.context = contextAt<C>(`bounded_context:${name}`, processStore);
  }

  get deps(): Readonly<D> {
    // The dependency interface is erased; the locator checks real registrations.
    return new Proxy(
      {},
      {
        get: (_target, key) => {
          if (typeof key !== "string" || !this.dependencyValues.has(key)) {
            throw new Error(`Dependency is not registered: ${String(key)}`);
          }
          return this.dependencyValues.get(key);
        },
        set: () => {
          throw new Error("Dependencies are read-only; use addDependency");
        },
        deleteProperty: () => {
          throw new Error("Dependencies cannot be deleted");
        },
        defineProperty: () => {
          throw new Error("Dependencies are read-only");
        },
        setPrototypeOf: () => {
          throw new Error("Dependencies are read-only");
        },
      },
    ) as Readonly<D>;
  }

  addDependency<K extends keyof D & string>(
    name: K,
    dependency: D[K],
    options?: { replaces: D[K] },
  ): this {
    if (RESERVED_DEPENDENCIES.has(name)) {
      throw new Error(`Reserved dependency name: ${name}`);
    }
    const registered = this.dependencyValues.has(name);
    if (registered && options === undefined) {
      throw new Error(`Dependency already registered: ${name}`);
    }
    if (options && (!registered || this.dependencyValues.get(name) !== options.replaces)) {
      throw new Error(`Dependency replacement does not match the registration: ${name}`);
    }
    this.dependencyValues.set(name, dependency);
    this.revision++;
    return this;
  }

  feature<T extends AnyCommand>(command: CommandClass<T>) {
    return this.registrar(command, "feature");
  }

  appService<T extends AnyCommand>(command: CommandClass<T>) {
    return this.registrar(command, "application_service");
  }

  execute<R>(command: Command<R>, _returnType?: ResponseClass<NoInfer<R>>): Promise<R> {
    return executeTyped(this.generation(), command);
  }

  scoped(context: Partial<C>): CommandBus {
    const scope = { ...context };
    return new FeatureBus((command) => this.generation()(command, undefined, false, scope));
  }

  buildRootBus(): void {
    this.generation();
  }

  fresh(): BoundedContext<D, C> {
    const fresh = new BoundedContext<D, C>(this.name);
    for (const [command, registration] of this.registrations) {
      fresh.registrations.set(command, registration);
    }
    for (const [name, dependency] of this.dependencyValues) {
      fresh.dependencyValues.set(name, dependency);
    }
    fresh.revision = this.revision;
    return fresh;
  }

  private registrar<T extends AnyCommand>(command: CommandClass<T>, layer: Layer) {
    return <S extends ServiceClass<NoInfer<T>, Answer<NoInfer<T>>>>(
      Service: S,
      decorator?: ClassDecoratorContext<S>,
    ): S => {
      const register = () => this.registerService(command, Service, layer);
      // Standard decorators run before static fields have initialized.
      if (decorator) decorator.addInitializer(register);
      else register();
      return Service;
    };
  }

  private registerService(
    command: CommandClass<AnyCommand>,
    Service: ServiceClass<AnyCommand, unknown>,
    layer: Layer,
  ): void {
    const Base = layer === "feature" ? Feature : ApplicationService;
    if (
      !(Service.prototype instanceof Base) ||
      (layer === "feature" && Service.prototype instanceof ApplicationService)
    ) {
      throw new TypeError(`The service is not an ${layer}`);
    }
    if (this.registrations.has(command)) {
      throw new Error("Command already registered: one executor across both layers");
    }
    const name = Service.serviceName;
    if (typeof name !== "string" || name.trim() === "") {
      throw new Error("A service needs a nonempty registered name");
    }
    if ([...this.registrations.values()].some((registration) => registration.name === name)) {
      throw new Error(`Service name already registered: ${name}`);
    }
    this.registrations.set(command, { name, layer, Service });
    this.revision++;
  }

  private generation(): GenerationDispatch {
    if (this.dispatch && this.builtRevision === this.revision) return this.dispatch;
    const revision = this.revision;
    const dispatch = this.buildGeneration();
    this.dispatch = dispatch;
    this.builtRevision = revision;
    return dispatch;
  }

  private buildGeneration(): GenerationDispatch {
    const registrations = new Map(this.registrations);
    const dependencies = new Map(this.dependencyValues);
    const instances = new Map<Registration, Executor<AnyCommand, unknown>>();
    for (const registration of registrations.values()) {
      const instance = new registration.Service();
      if (!isExecutor(instance)) {
        throw new Error(`Registered service is unavailable: ${registration.name}`);
      }
      instances.set(registration, instance);
    }
    const dispatch: GenerationDispatch = async (
      command,
      parent,
      featureOnly = false,
      scope = {},
    ) => {
      const target = registrationOf(registrations, command);
      if (featureOnly && target.layer !== "feature") {
        throw new Error("An ApplicationService may compose only Features");
      }
      const service = instances.get(target);
      if (!service) {
        throw new Error(`Registered service is unavailable: ${target.name}`);
      }
      return executeService(service, command, {
        boundedContext: this.name,
        name: target.name,
        layer: target.layer,
        dependencies,
        context: () => ({ ...processContext.values, ...this.context.values, ...scope }),
        ...(parent ? { parent } : {}),
        featureBus: (execution) =>
          new FeatureBus((child) => dispatch(child, execution, true)),
      });
    };
    return dispatch;
  }
}
