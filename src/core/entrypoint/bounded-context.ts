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
import { type CommandBus, FeatureBus } from "@sincpro/client-framework/core/domain/bus";
import {
  type Answer,
  type AnyCommand,
  Command,
  type CommandClass,
  DomainEvent,
  type EventClass,
  type Executable,
  type ResponseClass,
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
import type { Attributes } from "@sincpro/client-framework/observability/domain/tracing";
import {
  boundedContextLogger,
  logHandled,
} from "@sincpro/client-framework/observability/services/logging";

type Layer = "feature" | "application_service";

interface Executor<C extends Executable, R> {
  execute(executable: C): R | Promise<R>;
}

type ServiceClass<C extends Executable, R> = {
  new (): Executor<C, R>;
  readonly serviceName: string;
};

/** What a service is registered for: a Command's class or a domain event's. */
type DtoClass = abstract new (...args: never[]) => Executable;

/** The service a registration takes the place of, as the backend's `replaces=`. */
export type RegistrationOptions = { replaces?: abstract new (...args: never[]) => object };

/** What `feature(...)` and `appService(...)` answer: the function that registers the service. */
export type Registrar<T extends Executable> = <
  S extends ServiceClass<NoInfer<T>, Answer<NoInfer<T>>>,
>(
  Service: S,
  decorator?: ClassDecoratorContext<S>,
) => S;

interface Registration {
  readonly name: string;
  readonly layer: Layer;
  readonly Service: ServiceClass<Executable, unknown>;
  /** The service it took the place of: said on its spans. */
  readonly replaces?: string;
}

/** The error handlers of a bounded context, by where they answer. */
type Handlers = Readonly<Record<"global" | Layer, readonly ErrorHandler[]>>;

type GenerationDispatch = (
  executable: Executable,
  parent?: Execution,
  featureOnly?: boolean,
  scope?: Readonly<object>,
) => Promise<unknown>;

/** One generation: the root (through the global handlers) and the dispatch its runs share. */
type Generation = {
  root: (executable: Executable, scope: Readonly<object>) => Promise<unknown>;
};

function isExecutor(value: unknown): value is Executor<Executable, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "execute" in value &&
    typeof value.execute === "function"
  );
}

function isEventClass(dto: DtoClass): dto is EventClass<DomainEvent> {
  return dto.prototype instanceof DomainEvent;
}

function nameOf(Service: unknown): string {
  const named = Service as { serviceName?: unknown; name?: unknown } | undefined;
  return String(named?.serviceName ?? named?.name ?? Service);
}

/**
 * A bounded context: the bus of its Commands and domain events, as sincpro_framework's
 * `UseFramework`.
 *
 *     const project = new BoundedContext<ProjectDependencies>("project");
 *     project.addDependency("client", clientOf(transport));
 *     project.feature(CommandCancelIssue)(CancelIssue);          // or @project.feature(...)
 *     project.feature(IssueClosed)(NotifyWatchers);              // a subscriber of an event
 *     project.feature(CommandCancelIssue, { replaces: CancelIssue })(CancelAndArchive);
 *     project.addFeatureErrorHandler(toEmptyWhenMissing);
 *     project.expectErrors(IssueLocked);                         // refused, never reported
 *     await project.execute(new CommandCancelIssue("x"));        // ResponseCancelIssue
 *     await project.execute(new IssueClosed("x"));               // what its subscriber returns
 *     project.logger.info("Catalog preloaded");
 *
 * Context: registrations, dependencies, handlers and expected errors are snapshotted per
 * generation; a call keeps the generation it started with, and what is added later answers from
 * the next call — as the backend's `build_root_bus`. A domain event is executed as a Command is:
 * one subscriber per bounded context, through the same pipeline; carrying it to every bounded
 * context that hears it (a queue, an outbox) is the platform's.
 */
export class BoundedContext<
  D extends object = Record<never, never>,
  C extends object = ContextValues,
> {
  /** Its level of the context: what every use case of it runs with, under the process's. */
  readonly context: Context<C>;
  /** Its own logger, named after it: for what it does outside a use case. */
  readonly logger: LayerLogger;
  private readonly registrations = new Map<DtoClass, Registration>();
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

  /**
   * Registers the Feature that executes a Command — or that subscribes to a domain event. With
   * `replaces`, it takes the place of the service registered now for it.
   */
  feature<T extends AnyCommand>(
    command: CommandClass<T>,
    options?: RegistrationOptions,
  ): Registrar<T>;
  feature<E extends DomainEvent>(
    event: EventClass<E>,
    options?: RegistrationOptions,
  ): Registrar<E>;
  feature(dto: DtoClass, options?: RegistrationOptions): Registrar<Executable> {
    return this.registrar(dto, "feature", options);
  }

  /** Registers the ApplicationService of a Command or a domain event; `replaces` as `feature`. */
  appService<T extends AnyCommand>(
    command: CommandClass<T>,
    options?: RegistrationOptions,
  ): Registrar<T>;
  appService<E extends DomainEvent>(
    event: EventClass<E>,
    options?: RegistrationOptions,
  ): Registrar<E>;
  appService(dto: DtoClass, options?: RegistrationOptions): Registrar<Executable> {
    return this.registrar(dto, "application_service", options);
  }

  /** The service registered now for a Command or an event class — what a `replaces` names. */
  handlerOf(dto: DtoClass): (abstract new (...args: never[]) => object) | undefined {
    return this.registrations.get(dto)?.Service;
  }

  /**
   * The event class registered here under a wire name, or `undefined` when nothing here hears it
   * — what a platform's queue rebuilds a stored event as, as the backend's `event_type(name)`.
   */
  eventTypeOf(name: string): EventClass<DomainEvent> | undefined {
    for (const dto of this.registrations.keys()) {
      if (isEventClass(dto) && dto.eventName === name) return dto;
    }
    return undefined;
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

  /** Executes a Command — its Response, inferred —, or a domain event — its subscriber's answer. */
  execute<R>(command: Command<R>, returnType?: ResponseClass<NoInfer<R>>): Promise<R>;
  execute(event: DomainEvent): Promise<unknown>;
  execute(executable: Executable): Promise<unknown> {
    // As with Python's return_type, the answer is not validated at runtime.
    return this.generation().root(executable, {});
  }

  scoped(context: Partial<C>): CommandBus {
    const scope = { ...context };
    return new FeatureBus((executable) => this.generation().root(executable, scope));
  }

  buildRootBus(): void {
    this.generation();
  }

  fresh(): BoundedContext<D, C> {
    const fresh = new BoundedContext<D, C>(this.name);
    for (const [dto, registration] of this.registrations) {
      fresh.registrations.set(dto, registration);
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

  private registrar(
    dto: DtoClass,
    layer: Layer,
    options: RegistrationOptions = {},
  ): Registrar<Executable> {
    return (Service, decorator) => {
      const register = () => this.registerService(dto, Service, layer, options.replaces);
      // Standard decorators run before static fields have initialized.
      if (decorator) decorator.addInitializer(register);
      else register();
      return Service;
    };
  }

  /**
   * 1. The service is of the layer it is registered in, for a Command or a domain event class.
   * 2. The class has no service yet — or, with `replaces`, the one it has is that one.
   * 3. Its `serviceName` is given and no other service has it; an event's `eventName` is given
   *    and no other event class here has it — the name means one event.
   * Final: registered, said on its spans when it replaced another; the next call answers with it.
   */
  private registerService(
    dto: DtoClass,
    Service: ServiceClass<Executable, unknown>,
    layer: Layer,
    replaces: RegistrationOptions["replaces"],
  ): void {
    const Base = layer === "feature" ? Feature : ApplicationService;
    if (
      !(Service.prototype instanceof Base) ||
      (layer === "feature" && Service.prototype instanceof ApplicationService)
    ) {
      throw new TypeError(`The service is not an ${layer}`);
    }
    const event = isEventClass(dto);
    if (!event && !(dto.prototype instanceof Command)) {
      throw new TypeError("A service is registered for a Command or a DomainEvent class");
    }
    const current = this.registrations.get(dto);
    if (replaces !== undefined && current?.Service !== replaces) {
      throw new Error(`Replacement does not match the registration: ${nameOf(replaces)}`);
    }
    if (replaces === undefined && current) {
      throw new Error("Command already registered: one executor across both layers");
    }
    const name = Service.serviceName;
    if (typeof name !== "string" || name.trim() === "") {
      throw new Error("A service needs a nonempty registered name");
    }
    for (const [other, registration] of this.registrations) {
      if (registration !== current && registration.name === name) {
        throw new Error(`Service name already registered: ${name}`);
      }
      if (
        event &&
        other !== dto &&
        isEventClass(other) &&
        other.eventName === dto.eventName
      ) {
        throw new Error(`Event name already registered: ${dto.eventName}`);
      }
    }
    if (event && (typeof dto.eventName !== "string" || dto.eventName.trim() === "")) {
      throw new Error("A domain event needs a nonempty eventName");
    }
    this.registrations.set(dto, {
      name,
      layer,
      Service,
      ...(current ? { replaces: current.name } : {}),
    });
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
    const instances = new Map<Registration, Executor<Executable, unknown>>();
    for (const registration of registrations.values()) {
      const instance = new registration.Service();
      if (!isExecutor(instance)) {
        throw new Error(`Registered service is unavailable: ${registration.name}`);
      }
      instances.set(registration, instance);
    }
    const dispatch: GenerationDispatch = async (
      executable,
      parent,
      featureOnly = false,
      scope = {},
    ) => {
      // Exact constructor identity: a subclass of a registered class is another one.
      const target = registrations.get(Object.getPrototypeOf(executable)?.constructor);
      if (!target) throw new Error("No executor registered for this command class");
      if (featureOnly && target.layer !== "feature") {
        throw new Error("An ApplicationService may compose only Features");
      }
      const service = instances.get(target);
      if (!service) {
        throw new Error(`Registered service is unavailable: ${target.name}`);
      }
      const attributes: Attributes = {
        ...(executable instanceof DomainEvent ? { "sincpro.event": executable.name } : {}),
        ...(target.replaces ? { "sincpro.replaces": target.replaces } : {}),
      };
      return executeService(service, executable, {
        boundedContext: this.name,
        name: target.name,
        layer: target.layer,
        attributes,
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
      root: async (executable, scope) => {
        try {
          return await dispatch(executable, undefined, false, scope);
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
