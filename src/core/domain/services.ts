import type { Execution } from "@sincpro/client-framework/context/domain/execution";
import type { ContextValues } from "@sincpro/client-framework/context/domain/store";
import type { FeatureBus } from "@sincpro/client-framework/core/domain/bus";
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
 * every dependency are that run's (`executeService`). Its name — its use case in spans and
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
} {
  return {
    Feature: Feature as unknown as FeatureWith<D, Context>,
    ApplicationService: ApplicationService as unknown as ApplicationServiceWith<D, Context>,
  };
}

/** @internal — what a run finds on `this` that no dependency may take. */
export const RESERVED_MEMBERS: ReadonlySet<string> = new Set([
  "featureBus",
  "context",
  "span",
  "logger",
  "signal",
  "execution",
]);
