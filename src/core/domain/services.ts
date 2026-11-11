import type { Execution } from "@sincpro/client-framework/context/domain/execution";
import type { ContextValues } from "@sincpro/client-framework/context/domain/store";
import type { FeatureBus } from "@sincpro/client-framework/core/domain/bus";
import type { Command, DomainEvent } from "@sincpro/client-framework/core/domain/dto";
import type { LayerLogger } from "@sincpro/client-framework/observability/domain/logging";
import type { Span } from "@sincpro/client-framework/observability/domain/tracing";

/**
 * The services of the application layer, as sincpro_framework's: a Feature executes one
 * registered Command — or domain event, as its subscriber —; an ApplicationService composes its
 * context's Features.
 *
 *     @project.feature(CommandCancelIssue)
 *     class CancelIssue extends Feature<CommandCancelIssue, ResponseCancelIssue> {
 *       static readonly serviceName = "CancelIssue";
 *       async execute(command: CommandCancelIssue) {
 *         this.logger.info("Cancelling");                 // bound to this run
 *         return new ResponseCancelIssue(await this.client.cancelIssue(command));
 *       }
 *     }
 *
 * Context: while a method runs, `this.context`, `this.span`, `this.logger`, `this.featureBus` and
 * every dependency are that run's (`executeService`). `serviceName` is stable metadata, never
 * `constructor.name`, which a minifier renames.
 */
export abstract class Feature<
  C extends Command<R> | DomainEvent,
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
   * This run: its id, use case, flow (`correlationId`) and cause. A subscriber of a delivered
   * event finds the envelope's id as `causationId` — the key that makes executing it twice
   * harmless.
   */
  declare readonly execution: Execution;
  abstract execute(command: C): R | Promise<R>;
}

export abstract class ApplicationService<
  C extends Command<R> | DomainEvent,
  R,
  Context extends object = ContextValues,
> extends Feature<C, R, Context> {
  /** The context's Features, run as children of this execution. */
  declare protected readonly featureBus: FeatureBus;
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
