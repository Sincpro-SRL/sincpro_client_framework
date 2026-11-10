import type { Execution } from "@sincpro/client-framework/context/domain/execution";
import type { ContextValues } from "@sincpro/client-framework/context/domain/store";
import {
  type Context,
  contextAt,
} from "@sincpro/client-framework/context/entrypoint/context";
import {
  processContext,
  processStore,
} from "@sincpro/client-framework/context/infrastructure/process";
import {
  type CommandBus,
  executeTyped,
  FeatureBus,
} from "@sincpro/client-framework/core/domain/bus";
import type {
  Answer,
  AnyCommand,
  Command,
  CommandClass,
  ResponseClass,
} from "@sincpro/client-framework/core/domain/dto";
import type { ErrorClass, ErrorHandler } from "@sincpro/client-framework/core/domain/errors";
import {
  ApplicationService,
  Feature,
  RESERVED_MEMBERS,
} from "@sincpro/client-framework/core/domain/services";
import { handled } from "@sincpro/client-framework/core/services/error-handlers";
import { executeService } from "@sincpro/client-framework/core/services/execution";
import type { LayerLogger } from "@sincpro/client-framework/observability/domain/logging";
import {
  boundedContextLogger,
  logHandled,
} from "@sincpro/client-framework/observability/services/logging";

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

/** The error handlers of a bounded context, by where they answer. */
type Handlers = Readonly<Record<"global" | Layer, readonly ErrorHandler[]>>;

type GenerationDispatch = (
  command: AnyCommand,
  parent?: Execution,
  featureOnly?: boolean,
  scope?: Readonly<object>,
) => Promise<unknown>;

/** One generation: the root (through the global handlers) and the dispatch its runs share. */
type Generation = {
  root: (command: AnyCommand, scope: Readonly<object>) => Promise<unknown>;
};

function isExecutor(value: unknown): value is Executor<AnyCommand, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "execute" in value &&
    typeof value.execute === "function"
  );
}

/**
 * A bounded context: the bus of its Commands, as sincpro_framework's `UseFramework`.
 *
 *     const project = new BoundedContext<ProjectDependencies>("project");
 *     project.addDependency("client", clientOf(transport));
 *     project.feature(CommandCancelIssue)(CancelIssue);          // or @project.feature(...)
 *     project.addFeatureErrorHandler(toEmptyWhenMissing);
 *     project.expectErrors(IssueClosed);                         // refused, never reported
 *     await project.execute(new CommandCancelIssue("x"));        // ResponseCancelIssue
 *     project.logger.info("Catalog preloaded");
 *
 * Context: registrations, dependencies, handlers and expected errors are snapshotted per
 * generation; a call keeps the generation it started with, and what is added later answers from
 * the next call — as the backend's `build_root_bus`.
 */
export class BoundedContext<
  D extends object = Record<never, never>,
  C extends object = ContextValues,
> {
  /** Its level of the context: what every use case of it runs with, under the process's. */
  readonly context: Context<C>;
  /** Its own logger, named after it: for what it does outside a use case. */
  readonly logger: LayerLogger;
  private readonly registrations = new Map<CommandClass<AnyCommand>, Registration>();
  private readonly dependencyValues = new Map<string, unknown>();
  private readonly handlers: Record<"global" | Layer, ErrorHandler[]> = {
    global: [],
    feature: [],
    application_service: [],
  };
  private readonly expected: ErrorClass[] = [];
  private revision = 0;
  private builtRevision = -1;
  private built: Generation | undefined;

  constructor(readonly name: string) {
    if (name.trim() === "" || name.includes("/")) {
      throw new TypeError("A bounded context needs a nonempty name without '/'");
    }
    this.context = contextAt<C>(`bounded_context:${name}`, processStore);
    this.logger = boundedContextLogger(name);
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
    if (RESERVED_MEMBERS.has(name)) {
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

  /** Answers a failure that reaches `execute` (or a scope's): after every layer's handlers. */
  addGlobalErrorHandler(handler: ErrorHandler): this {
    return this.addErrorHandler("global", handler);
  }

  /** Answers a Feature's failure, wherever it was executed from. */
  addFeatureErrorHandler(handler: ErrorHandler): this {
    return this.addErrorHandler("feature", handler);
  }

  /** Answers an ApplicationService's failure. */
  addAppServiceErrorHandler(handler: ErrorHandler): this {
    return this.addErrorHandler("application_service", handler);
  }

  /**
   * Errors of these classes are the business answering, not a fault: the run ends `refused`,
   * its span is no error and nothing is reported. They are still thrown — or handled.
   */
  expectErrors(...types: ErrorClass[]): this {
    for (const type of types) {
      if (typeof type !== "function") throw new TypeError("An expected error is a class");
      if (!this.expected.includes(type)) this.expected.push(type);
    }
    this.revision++;
    return this;
  }

  execute<R>(command: Command<R>, _returnType?: ResponseClass<NoInfer<R>>): Promise<R> {
    return executeTyped((one) => this.generation().root(one, {}), command);
  }

  scoped(context: Partial<C>): CommandBus {
    const scope = { ...context };
    return new FeatureBus((command) => this.generation().root(command, scope));
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
    for (const where of ["global", "feature", "application_service"] as const) {
      fresh.handlers[where].push(...this.handlers[where]);
    }
    fresh.expected.push(...this.expected);
    fresh.revision = this.revision;
    return fresh;
  }

  private addErrorHandler(where: keyof Handlers, handler: ErrorHandler): this {
    if (typeof handler !== "function") throw new TypeError("An error handler is a function");
    this.handlers[where].push(handler);
    this.revision++;
    return this;
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

  private generation(): Generation {
    if (this.built && this.builtRevision === this.revision) return this.built;
    const revision = this.revision;
    const built = this.buildGeneration();
    this.built = built;
    this.builtRevision = revision;
    return built;
  }

  private buildGeneration(): Generation {
    const registrations = new Map(this.registrations);
    const dependencies = new Map(this.dependencyValues);
    const handlers: Handlers = {
      global: [...this.handlers.global],
      feature: [...this.handlers.feature],
      application_service: [...this.handlers.application_service],
    };
    const expectedTypes = [...this.expected];
    const expected = (error: unknown) => expectedTypes.some((type) => error instanceof type);
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
      // Exact constructor identity: a subclass of a registered Command is another Command.
      const target = registrations.get(Object.getPrototypeOf(command)?.constructor);
      if (!target) throw new Error("No executor registered for this command class");
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
        expected,
        handlers: handlers[target.layer],
      });
    };
    return {
      root: async (command, scope) => {
        try {
          return await dispatch(command, undefined, false, scope);
        } catch (error) {
          if (handlers.global.length === 0) throw error;
          const answer = await handled(handlers.global, error);
          logHandled("bounded_context", { boundedContext: this.name });
          return answer;
        }
      },
    };
  }
}
