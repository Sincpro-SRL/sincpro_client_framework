import { BIND, type Execution } from "@sincpro/client-framework/context/domain/execution";
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
  FeatureBus,
  optionsOf,
} from "@sincpro/client-framework/core/domain/bus";
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
import type {
  Cause,
  ExecuteOptions,
  ExecutionCompleted,
  ExecutionFailed,
  ExecutionStarted,
  Extension,
  Interceptor,
  Listener,
} from "@sincpro/client-framework/core/domain/pipeline";
import {
  ApplicationService,
  Feature,
  RESERVED_MEMBERS,
} from "@sincpro/client-framework/core/domain/services";
import { processHearing } from "@sincpro/client-framework/core/infrastructure/listeners";
import { handled } from "@sincpro/client-framework/core/services/error-handlers";
import { executeService, failedAt } from "@sincpro/client-framework/core/services/execution";
import {
  announceTo,
  concerns,
  type ExecutableClass,
  type Hearing,
  listenIn,
} from "@sincpro/client-framework/core/services/listening";
import type { LayerLogger } from "@sincpro/client-framework/observability/domain/logging";
import type {
  Attributes,
  Outcome,
} from "@sincpro/client-framework/observability/domain/tracing";
import { observabilityNow } from "@sincpro/client-framework/observability/infrastructure/registry";
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
type DtoClass = ExecutableClass;

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

/** How a root run is executed: its options, and — from outside, through `BIND` — who called it. */
type RootOptions = ExecuteOptions & { readonly caller?: Execution };

type GenerationDispatch = (
  executable: Executable,
  parent?: Execution,
  featureOnly?: boolean,
  scope?: Readonly<object>,
  options?: RootOptions,
) => Promise<unknown>;

/** One generation: the root (through the global handlers) and the dispatch its runs share. */
type Generation = {
  root: (
    executable: Executable,
    scope: Readonly<object>,
    options: RootOptions,
  ) => Promise<unknown>;
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
 *     const projectBoundedContext = new BoundedContext<ProjectDependencies>("project");
 *     projectBoundedContext.addDependency("client", clientOf(operations));
 *     projectBoundedContext.feature(CommandCancelIssue)(CancelIssue);   // or a decorator
 *     projectBoundedContext.feature(IssueClosed)(ArchiveIssue);         // a use case of an event
 *     projectBoundedContext.feature(CommandCancelIssue, { replaces: CancelIssue })(CancelAndArchive);
 *     projectBoundedContext.addFeatureErrorHandler(toEmptyWhenMissing);
 *     projectBoundedContext.expectErrors(IssueLocked);                  // refused, never reported
 *     await projectBoundedContext.execute(new CommandCancelIssue("x")); // ResponseCancelIssue
 *     await projectBoundedContext.execute(new IssueClosed("x"));        // what its use case returns
 *     projectBoundedContext.logger.info("Catalog preloaded");
 *
 * Context: registrations, dependencies, handlers and expected errors are snapshotted per
 * generation; a call keeps the generation it started with, and what is added later answers from
 * the next call — as the backend's `build_root_bus`. A domain event may be the input of a use
 * case, executed as a Command is: one per bounded context, through the same pipeline. Carrying
 * it to whoever hears it (a queue, an outbox) is the platform's; an entrypoint that hears it and
 * calls use cases is an `EventSubscriber`. Injected into another run — an `EventSubscriber`, a
 * Feature of another bounded context — it is bound to that run (`BIND`).
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
  private readonly interceptors: Hearing<Interceptor>[] = [];
  private readonly listeners = {
    started: new Set<Hearing<Listener<ExecutionStarted>>>(),
    completed: new Set<Hearing<Listener<ExecutionCompleted>>>(),
    failed: new Set<Hearing<Listener<ExecutionFailed>>>(),
  };
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

  /**
   * Runs `interceptor` around every execution of these classes — of every one when none is
   * named —, outermost first in the order registered. It may look, veto (throw), adjust what it
   * passes on (of the same class) or answer by itself. Registered after a call, it wraps from
   * the next one.
   */
  interceptor<T extends Executable = Executable>(
    ...dtos: (abstract new (...args: never[]) => T)[]
  ): <F extends Interceptor<T>>(interceptor: F) => F {
    return (interceptor) => {
      if (typeof interceptor !== "function")
        throw new TypeError("An interceptor is a function");
      // Registered for these classes only, it is called only with them.
      this.interceptors.push({ what: interceptor as unknown as Interceptor, dtos });
      this.revision++;
      return interceptor;
    };
  }

  /** Stops `interceptor` wherever it was registered; from the next call. */
  withoutInterceptor(interceptor: (...args: never[]) => unknown): this {
    const kept = this.interceptors.filter((one) => one.what !== (interceptor as unknown));
    this.interceptors.splice(0, this.interceptors.length, ...kept);
    this.revision++;
    return this;
  }

  /** Hears every run of these classes (every one when none is named) begin. Answers how to stop. */
  onStart(listener: Listener<ExecutionStarted>, ...dtos: DtoClass[]): () => void {
    return listenIn(this.listeners.started, listener, dtos);
  }

  /** Hears every run of these classes whose service answered — not an answer a handler gave. */
  onCompletion(listener: Listener<ExecutionCompleted>, ...dtos: DtoClass[]): () => void {
    return listenIn(this.listeners.completed, listener, dtos);
  }

  /** Hears every failure that escapes a call — after every handler —, once, where it failed. */
  onFailure(listener: Listener<ExecutionFailed>, ...dtos: DtoClass[]): () => void {
    return listenIn(this.listeners.failed, listener, dtos);
  }

  /**
   * Wires a component into this bounded context — its dependencies, services, interceptors,
   * listeners, handlers — in one place: a module of an application, a plugin. `fresh()` copies
   * all it registered.
   */
  extend(extension: Extension<this>): this {
    extension(this);
    return this;
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

  /**
   * Executes a Command — its Response, inferred —, or a domain event — its subscriber's answer.
   * `{ signal }` cancels the run (it ends `aborted`); a delivered event's envelope continues its
   * flow (`execute(event, envelope)`).
   */
  execute<R>(command: Command<R>, returnType?: ResponseClass<NoInfer<R>>): Promise<R>;
  execute<R>(command: Command<R>, options: ExecuteOptions): Promise<R>;
  execute(event: DomainEvent, options?: ExecuteOptions | Cause): Promise<unknown>;
  execute(executable: Executable, second?: unknown): Promise<unknown> {
    // As with Python's return_type, the answer is not validated at runtime.
    return this.generation().root(executable, {}, optionsOf(second));
  }

  scoped(context: Partial<C>): CommandBus {
    const scope = { ...context };
    return new FeatureBus((executable, options) =>
      this.generation().root(executable, scope, options),
    );
  }

  /**
   * This bounded context as `execution` calls it — what it is as a dependency of another run (an
   * `EventSubscriber`, a Feature of another bounded context): what it executes is a child of
   * that run — its span under the caller's, the same flow (`correlationId`), caused by it,
   * cancelled with it, its errors reported once along it. It still runs with its own
   * dependencies, context, interceptors and handlers.
   */
  [BIND](execution: Execution): this {
    const caller = execution;
    const execute = (executable: Executable, second?: unknown) =>
      this.generation().root(executable, {}, { ...optionsOf(second), caller });
    const scoped = (context: Partial<C>) => {
      const scope = { ...context };
      return new FeatureBus((executable, options) =>
        this.generation().root(executable, scope, { ...options, caller }),
      );
    };
    return new Proxy(this, {
      get(target, property) {
        if (property === "execute") return execute;
        if (property === "scoped") return scoped;
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
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
    fresh.interceptors.push(...this.interceptors);
    for (const moment of ["started", "completed", "failed"] as const) {
      for (const one of this.listeners[moment]) fresh.listeners[moment].add(one as never);
    }
    fresh.revision = this.revision;
    return fresh;
  }

  /** What escaped a call, told once, from where it first failed. */
  private escaped(executable: Executable, error: unknown, expected: (e: unknown) => boolean) {
    const at = failedAt(error);
    let outcome: Outcome = "failed";
    try {
      outcome =
        at?.outcome ?? (expected(error) ? "refused" : observabilityNow().outcomeOf(error));
    } catch {
      // An outcome that cannot be told is a failure.
    }
    const heard: ExecutionFailed = {
      executable: at?.executable ?? executable,
      execution: at?.execution,
      // Listeners hear use cases: a failure an entrypoint's run started says no layer.
      layer: at?.layer === "entrypoint" ? undefined : at?.layer,
      error,
      outcome,
    };
    announceTo(this.listeners.failed, heard);
    announceTo(processHearing().failed, heard);
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
    const interceptors = [...this.interceptors];
    const everyContext = processHearing();
    const announce = {
      started: (heard: ExecutionStarted) => {
        announceTo(this.listeners.started, heard);
        announceTo(everyContext.started, heard);
      },
      completed: (heard: ExecutionCompleted) => {
        announceTo(this.listeners.completed, heard);
        announceTo(everyContext.completed, heard);
      },
    };
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
      options = {},
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
        // A root called from another run continues it; a child continues its parent.
        ...(options.caller && !parent ? { caller: options.caller } : {}),
        // Only an event comes from outside with a cause.
        ...(options.cause && executable instanceof DomainEvent && !parent
          ? { cause: options.cause }
          : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        featureBus: (execution) =>
          new FeatureBus((child, options) => dispatch(child, execution, true, {}, options)),
        expected,
        handlers: handlers[target.layer],
        interceptors: interceptors
          .filter((one) => concerns(one.dtos, executable))
          .map((one) => one.what),
        announce,
      });
    };
    return {
      root: async (executable, scope, options) => {
        try {
          return await dispatch(executable, undefined, false, scope, options);
        } catch (error) {
          let escaping = error;
          if (handlers.global.length > 0) {
            try {
              const answer = await handled(handlers.global, error);
              logHandled("bounded_context", { boundedContext: this.name });
              return answer;
            } catch (thrown) {
              escaping = thrown;
            }
          }
          this.escaped(executable, escaping, expected);
          throw escaping;
        }
      },
    };
  }
}
