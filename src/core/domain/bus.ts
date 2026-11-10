import type {
  AnyCommand,
  Command,
  ResponseClass,
} from "@sincpro/client-framework/core/domain/dto";

/** What executes a Command: the bounded context, a scope of it, an ApplicationService's features. */
export interface CommandBus {
  execute<R>(command: Command<R>, returnType?: ResponseClass<NoInfer<R>>): Promise<R>;
}

/** @internal — how a bus hands a Command to its generation. */
export type Dispatch = (command: AnyCommand) => Promise<unknown>;

/** @internal — the heterogeneous registry erases the type; registration checks the association. */
export async function executeTyped<R>(dispatch: Dispatch, command: Command<R>): Promise<R> {
  // As with Python's return_type, this does not validate the returned data at runtime.
  return (await dispatch(command)) as R;
}

/**
 * What an ApplicationService composes its context's Features through (`this.featureBus`): the
 * same pipeline, as a child of the running execution, and Features only.
 */
export class FeatureBus implements CommandBus {
  constructor(private readonly dispatch: Dispatch) {}

  execute<R>(command: Command<R>, _returnType?: ResponseClass<NoInfer<R>>): Promise<R> {
    return executeTyped(this.dispatch, command);
  }
}
