/**
 * The DTOs of the application layer, as sincpro_framework's `DataTransferObject`: a Command asks
 * for work and names, by its type, the Response it answers.
 *
 *     class CommandCancelIssue extends Command<ResponseCancelIssue> {
 *       constructor(readonly issue_id: string) { super(); }
 *     }
 *     const answer = await project.execute(new CommandCancelIssue("x"));   // ResponseCancelIssue
 *
 * Context: the backend asks `bus(dto, ResponseType)` for the type; here the Command carries it, so
 * `execute` infers it with no second argument. The association is type-only: absent from a
 * serialized DTO, not a runtime validator. A generated DTO is a remote contract (a type), not one
 * of these: a local Command may implement it.
 */
export abstract class DataTransferObject {
  declare protected readonly dtoBrand: void;
}

export abstract class Response extends DataTransferObject {}

declare const responseType: unique symbol;

export abstract class Command<R> extends DataTransferObject {
  /** Type-only association: absent from serialized DTOs and not a runtime validator. */
  declare readonly [responseType]: R;
}

export type AnyCommand = Command<unknown>;

/** What a Command answers. */
export type Answer<C extends AnyCommand> = C[typeof responseType];

/** A Command's class: what a service is registered for, by exact constructor identity. */
export type CommandClass<C extends AnyCommand> = abstract new (...args: never[]) => C;

/** A Response's class: the backend's `return_type`, accepted for the same reading. */
export type ResponseClass<R> = abstract new (...args: never[]) => R;
