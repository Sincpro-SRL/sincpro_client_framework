import { BoundedContext, type IDomainEvent } from "@sincpro/client-framework/core";

import {
  CancelIssue,
  CommandCancelIssue,
  CommandSendIssue,
  type ProjectDependencies,
  ProjectFeature,
  ResponseCancelIssue,
  ResponseSendIssue,
  SendIssue,
} from "../support/core";

export async function coreTypes(
  context: BoundedContext<ProjectDependencies>,
  dependencies: ProjectDependencies,
  event: IDomainEvent,
) {
  const response = await context.execute(new CommandCancelIssue("issue-1"));
  const exact: ResponseCancelIssue = response;
  // @ts-expect-error The response follows the command, not the caller's choice.
  const wrong: ResponseSendIssue = response;
  void exact;
  void wrong;
  // @ts-expect-error The response association is not a public runtime property on a DTO.
  void new CommandCancelIssue("x").responseType;
  // @ts-expect-error Constructors check their generated DTO fields.
  new CommandCancelIssue(42);
  // @ts-expect-error The send command requires its message.
  new CommandSendIssue("x");
  // @ts-expect-error Class instances replace literal command envelopes.
  await context.execute({ issue_id: "x" });
  // @ts-expect-error A different input/response cannot be registered.
  context.feature(CommandCancelIssue)(SendIssue);
  // @ts-expect-error Only the context's dependency names are allowed.
  context.addDependency("unknown", {});
  // @ts-expect-error Registered dependencies must satisfy the complete interface.
  context.addDependency("client", { cancelIssue: async () => 42 });
  // @ts-expect-error Explicit response types cannot change the inferred association.
  await context.execute(new CommandCancelIssue("x"), ResponseSendIssue);
  // @ts-expect-error Responses are not Commands.
  await context.execute(new ResponseCancelIssue("x", "cancelled"));
  // @ts-expect-error A domain event contract does not silently become an executable command.
  await context.execute(event);
  context.addDependency("client", dependencies.client);
  context.feature(CommandCancelIssue)(CancelIssue);
}

export class TypedDependencies extends ProjectFeature<
  CommandCancelIssue,
  ResponseCancelIssue
> {
  static readonly serviceName = "TypedDependencies";
  async execute(command: CommandCancelIssue): Promise<ResponseCancelIssue> {
    // @ts-expect-error Dependencies are declared once on the bounded context's base.
    void this.unknownAdapter;
    // @ts-expect-error The injected generated client checks its input.
    await this.client.cancelIssue({ issue_id: 42 });
    const result = await this.client.cancelIssue(command);
    return new ResponseCancelIssue(result.issue_id, result.resolution);
  }
}

const decorated = new BoundedContext<ProjectDependencies>("decorated-types");
// @ts-expect-error Decorator syntax must reject a mismatched input/response too.
@decorated.feature(CommandCancelIssue)
export class WrongDecoratedFeature extends ProjectFeature<
  CommandSendIssue,
  ResponseSendIssue
> {
  static readonly serviceName = "WrongDecoratedFeature";
  execute(command: CommandSendIssue): ResponseSendIssue {
    return new ResponseSendIssue(command.issue_id, "run-1", command.message);
  }
}
