import type {
  Command,
  DomainEvent,
  Executable,
  ResponseClass,
} from "@sincpro/client-framework/core/domain/dto";

/**
 * What executes a Command or a domain event: the bounded context, a scope of it, an
 * ApplicationService's features. A Command answers its Response; an event, whatever its
 * subscriber returns.
 */
export interface CommandBus {
  execute<R>(command: Command<R>, returnType?: ResponseClass<NoInfer<R>>): Promise<R>;
  execute(event: DomainEvent): Promise<unknown>;
}

/** @internal — how a bus hands what it executes to its generation. */
export type Dispatch = (executable: Executable) => Promise<unknown>;

/**
 * What an ApplicationService composes its context's Features through (`this.featureBus`): the
 * same pipeline, as a child of the running execution, and Features only.
 */
export class FeatureBus implements CommandBus {
  constructor(private readonly dispatch: Dispatch) {}

  execute<R>(command: Command<R>, returnType?: ResponseClass<NoInfer<R>>): Promise<R>;
  execute(event: DomainEvent): Promise<unknown>;
  execute(executable: Executable): Promise<unknown> {
    // As with Python's return_type, the answer is not validated at runtime.
    return this.dispatch(executable);
  }
}
