import type {
  Command,
  DomainEvent,
  Executable,
  RemoteCommand,
  RemoteEvent,
  ResponseClass,
} from "@sincpro/client-framework/core/domain/dto";
import type { Cause, ExecuteOptions } from "@sincpro/client-framework/core/domain/pipeline";

/** What the second argument of `execute` is: options, a delivered event's cause, or a type. */
export function optionsOf(second: unknown): ExecuteOptions {
  if (second === null || typeof second !== "object") return {};
  const given = second as ExecuteOptions & Partial<Cause>;
  if (typeof given.id === "string" && typeof given.correlationId === "string")
    return {
      cause: {
        id: given.id,
        correlationId: given.correlationId,
        ...(given.traceparent ? { traceparent: given.traceparent } : {}),
        ...(given.tracestate ? { tracestate: given.tracestate } : {}),
      },
    };
  return {
    ...(given.signal ? { signal: given.signal } : {}),
    ...(given.cause ? { cause: given.cause } : {}),
  };
}

/**
 * What executes a Command or a domain event: the bounded context, a scope of it, an
 * ApplicationService's features. A Command answers its Response; an event, whatever its
 * subscriber returns.
 */
export interface CommandBus {
  execute<R>(command: Command<R>, returnType?: ResponseClass<NoInfer<R>>): Promise<R>;
  execute<R>(command: Command<R>, options: ExecuteOptions): Promise<R>;
  execute<I, R>(command: RemoteCommand<I, R>, options?: ExecuteOptions): Promise<R>;
  execute(
    event: DomainEvent | RemoteEvent,
    options?: ExecuteOptions | Cause,
  ): Promise<unknown>;
}

/** @internal — how a bus hands what it executes to its generation. */
export type Dispatch = (executable: Executable, options: ExecuteOptions) => Promise<unknown>;

/**
 * What an ApplicationService composes its context's Features through (`this.featureBus`): the
 * same pipeline, as a child of the running execution, and Features only.
 */
export class FeatureBus implements CommandBus {
  constructor(private readonly dispatch: Dispatch) {}

  execute<R>(command: Command<R>, returnType?: ResponseClass<NoInfer<R>>): Promise<R>;
  execute<R>(command: Command<R>, options: ExecuteOptions): Promise<R>;
  execute<I, R>(command: RemoteCommand<I, R>, options?: ExecuteOptions): Promise<R>;
  execute(
    event: DomainEvent | RemoteEvent,
    options?: ExecuteOptions | Cause,
  ): Promise<unknown>;
  execute(executable: Executable, second?: unknown): Promise<unknown> {
    // As with Python's return_type, the answer is not validated at runtime.
    return this.dispatch(executable, optionsOf(second));
  }
}
