import type { Execution } from "@sincpro/client-framework/context/domain/execution";
import type { ContextValues } from "@sincpro/client-framework/context/domain/store";
import type { CommandBus, FeatureBus } from "@sincpro/client-framework/core/domain/bus";
import type {
  Command,
  DomainEvent,
  RemoteCommand,
  RemoteEvent,
} from "@sincpro/client-framework/core/domain/dto";
import type { LayerLogger } from "@sincpro/client-framework/observability/domain/logging";
import type { Span } from "@sincpro/client-framework/observability/domain/tracing";

/** What a service executes: a Command, a domain event, or a generated one. */
export type ServiceInput<R> = Command<R> | DomainEvent | RemoteEvent | RemoteCommand;

/**
 * The services of the application layer, as sincpro_framework's: a Feature executes the DTOs it
 * is registered for — Commands, domain events, generated ones —; an ApplicationService composes
 * its context's Features.
 *
 *     @projectBoundedContext.feature(CommandCancelIssue)
 *     class CancelIssue extends Feature<CommandCancelIssue, ResponseCancelIssue> {
 *       async execute(command: CommandCancelIssue) {
 *         this.logger.info("Cancelling");                 // bound to this run
 *         return new ResponseCancelIssue(await this.client.cancelIssue(command));
 *       }
 *     }
 *
 * Context: while a method runs, `this.context`, `this.span`, `this.logger`, `this.featureBus` and
 * every dependency are that run's (`executeService`). An event's use case is one way to handle it;
 * an `EventHandler`, a layer above, is the other. Its name — its use case in spans and
 * logs — is the framework's to take when it is registered: nothing on the class declares it.
 */
export abstract class Feature<
  C extends ServiceInput<R>,
  R,
  Context extends object = ContextValues,
> {
  /** What this run reads: the process's context, its bounded context's, its scope's. */
  declare readonly context: Readonly<Partial<Context>>;
  /** This run's span: `this.span.set({...})` says more about the use case. */
  declare readonly span: Span;
  /** This run's logger: every line carries its use case, execution and trace. */
  declare readonly logger: LayerLogger;
  /** What cancels this run, when it was executed with one: check it in a long loop. */
  declare readonly signal: AbortSignal | undefined;
  /**
   * This run: its id, use case, flow (`correlationId`) and cause. A delivered event or Command
   * finds its message's id as `causationId` — the key that makes executing it twice harmless.
   */
  declare readonly execution: Execution;
  abstract execute(command: C): R | Promise<R>;
}

export abstract class ApplicationService<
  C extends ServiceInput<R>,
  R,
  Context extends object = ContextValues,
> extends Feature<C, R, Context> {
  /** The context's Features, run as children of this execution. */
  declare protected readonly featureBus: FeatureBus;
}

/** What an event handler handles: a domain event, or a generated one's data. */
export type HandledEvent = DomainEvent | RemoteEvent;

/**
 * An event handler: the entrypoint an event reaches — it decides nothing, it executes Commands
 * on the buses it reaches —, registered for one event or N, on a bounded context or on a
 * `Subscriber`:
 *
 *     @salesBoundedContext.handler([SalePaid, SaleCancelled])
 *     export class OnSaleChanged extends EventHandler<SalePaid | SaleCancelled> {
 *       async handle(event: SalePaid | SaleCancelled) {
 *         await this.boundedContext.execute(new CommandCloseSale(event.saleId));
 *       }
 *     }
 *
 * Context: a handler runs in the same pipeline as a Feature — its span
 * (`<owner>/<Handler>`), `this.logger`, `this.execution` (its `causationId` is the message's id)
 * and `this.signal` —, a layer above the use cases (`event_handler`). On a bounded context it
 * finds that context's dependencies and the context itself (`this.boundedContext`), bound to the
 * run; on a `Subscriber`, the dependencies the subscriber was given. Its name is its class's,
 * taken at registration.
 */
export abstract class EventHandler<
  E extends HandledEvent,
  Context extends object = ContextValues,
> {
  /** What this run reads: the process's context, and its bounded context's when it has one. */
  declare readonly context: Readonly<Partial<Context>>;
  /** This run's span. */
  declare readonly span: Span;
  /** This run's logger: every line carries its handler, execution and trace. */
  declare readonly logger: LayerLogger;
  /** What cancels this run, when it has one. */
  declare readonly signal: AbortSignal | undefined;
  /** This run: its `causationId` is the id of the message it handles. */
  declare readonly execution: Execution;
  abstract handle(event: E): void | Promise<void>;
}

/** An event handler base of a `Subscriber`: every dependency of `D` on `this`, typed. */
export type EventHandlerWith<
  D extends object,
  Context extends object = ContextValues,
> = abstract new <E extends HandledEvent>() => EventHandler<E, Context> & Readonly<D>;

/**
 * An event handler base of a bounded context: its dependencies, and the context itself
 * (`this.boundedContext`) — its Features and ApplicationServices, executed as children of the
 * handler's run.
 */
export type BoundedContextHandlerWith<
  D extends object,
  Context extends object = ContextValues,
> = abstract new <E extends HandledEvent>() => EventHandler<E, Context> &
  Readonly<D> & { readonly boundedContext: CommandBus };

/** A Feature base whose instances find every dependency of `D` on `this`, typed. */
export type FeatureWith<
  D extends object,
  Context extends object = ContextValues,
> = abstract new <C extends ServiceInput<R>, R>() => Feature<C, R, Context> & Readonly<D>;

/** An ApplicationService base whose instances find every dependency of `D` on `this`, typed. */
export type ApplicationServiceWith<
  D extends object,
  Context extends object = ContextValues,
> = abstract new <C extends ServiceInput<R>, R>() => ApplicationService<C, R, Context> &
  Readonly<D>;

/**
 * The Feature and ApplicationService of a bounded context, typed with its dependencies — the
 * backend's `class Feature(_Feature, DependencyContextType)`, in its `infrastructure/framework.py`:
 *
 *     // infrastructure/framework.ts
 *     export const { Feature, ApplicationService } = servicesWith<HelpdeskDependencies>();
 *
 *     // services/ticket/update_stage.feature.ts
 *     @helpdeskBoundedContext.feature(CommandUpdateStage)
 *     export class UpdateStage extends Feature<CommandUpdateStage, ResponseUpdateStage> {
 *       async execute(command: CommandUpdateStage) {
 *         return this.odooWrite.stage(command);        // typed, declared nowhere else
 *       }
 *     }
 *
 * Context: a service never declares its dependencies again: they are the bounded context's, and
 * `addDependency` supplies them at runtime (a missing one fails explicitly). This is the same
 * class, typed — no other runtime behaviour.
 */
export function servicesWith<D extends object, Context extends object = ContextValues>(): {
  Feature: FeatureWith<D, Context>;
  ApplicationService: ApplicationServiceWith<D, Context>;
  EventHandler: BoundedContextHandlerWith<D, Context>;
} {
  return {
    Feature: Feature as unknown as FeatureWith<D, Context>,
    ApplicationService: ApplicationService as unknown as ApplicationServiceWith<D, Context>,
    EventHandler: EventHandler as unknown as BoundedContextHandlerWith<D, Context>,
  };
}

/**
 * The event handler base of a `Subscriber`, typed with what it was given (`addDependency`):
 *
 *     // entrypoints/queue/framework.ts
 *     export const { EventHandler } = handlersWith<AppSubscriberDependencies>();
 *
 * The same class, typed — no other runtime behaviour.
 */
export function handlersWith<D extends object, Context extends object = ContextValues>(): {
  EventHandler: EventHandlerWith<D, Context>;
} {
  return { EventHandler: EventHandler as unknown as EventHandlerWith<D, Context> };
}

/** @internal — what a run finds on `this` that no dependency may take. */
export const RESERVED_MEMBERS: ReadonlySet<string> = new Set([
  "featureBus",
  "boundedContext",
  "context",
  "span",
  "logger",
  "signal",
  "execution",
]);
