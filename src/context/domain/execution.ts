import type { Span } from "@sincpro/client-framework/observability/domain/tracing";

/**
 * One run of a use case: its span, what it runs with, and who ran it.
 *
 * Context: sincpro_framework keeps the running use case in a context variable; a browser has
 * nothing like it that survives an `await` (AsyncContext is a proposal, Zone.js patches the
 * world), and a global stack mixes the parents of two use cases running at once — which a
 * screen with several windows does all the time. So an execution is a value, handed to what
 * the use case calls: the Features its `featureBus` runs, and its dependencies (`BIND`).
 */
export type Execution = {
  /** UUID v7, as 32 hex: this run. */
  readonly id: string;
  /** `<bounded context>.<Service>` — the use case's identity, as the backend names its own. */
  readonly useCase: string;
  /** The bounded context the use case belongs to. */
  readonly boundedContext: string;
  /** The run that executed this one: an ApplicationService, for its Features. */
  readonly parent: Execution | undefined;
  /**
   * The chain it belongs to: the id of what started it all — the root run, or the first event
   * of a flow it continues. Every run and event of one flow share it.
   */
  readonly correlationId: string;
  /** What directly caused it: its parent run, or the event it executes; none for a root. */
  readonly causationId: string | undefined;
  readonly span: Span;
  /** What it runs with, read once where the gesture started and inherited by every child. */
  readonly context: Readonly<Record<string, unknown>>;
};

/**
 * A dependency that has something to say about the execution it is used in: given that
 * execution, it answers itself bound to it. The transport, every generated client and the
 * predefined loggers are; any other dependency of a bounded context is handed as it is.
 */
export const BIND: unique symbol = Symbol.for("sincpro.client-framework.bind");

export type Bindable<T> = { [BIND]: (execution: Execution) => T };

export function isBindable<T>(value: T): value is T & Bindable<T> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as Partial<Bindable<T>>)[BIND] === "function"
  );
}
