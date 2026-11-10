import {
  ApplicationService,
  BoundedContext,
  Command,
  Feature,
  Response,
} from "@sincpro/client-framework/core";

import type {
  CommandCancelIssue as GeneratedCommandCancelIssue,
  CommandSendIssue as GeneratedCommandSendIssue,
  ResponseCancelIssue as GeneratedResponseCancelIssue,
  ResponseSendIssue as GeneratedResponseSendIssue,
} from "./forge-contract/project/domain";

export class ResponseCancelIssue extends Response implements GeneratedResponseCancelIssue {
  constructor(
    public readonly issue_id: string,
    public readonly resolution: string,
  ) {
    super();
  }
}

export class CommandCancelIssue
  extends Command<ResponseCancelIssue>
  implements GeneratedCommandCancelIssue
{
  constructor(public readonly issue_id: string) {
    super();
  }
}

export class CommandRequestCancellation extends Command<ResponseCancelIssue> {
  constructor(public readonly issue_id: string) {
    super();
  }
}

export class ResponseSendIssue extends Response implements GeneratedResponseSendIssue {
  constructor(
    public readonly issue_id: string,
    public readonly run_id: string,
    public readonly status: string,
  ) {
    super();
  }
}

export class CommandSendIssue
  extends Command<ResponseSendIssue>
  implements GeneratedCommandSendIssue
{
  constructor(
    public readonly issue_id: string,
    public readonly message: string,
  ) {
    super();
  }
}

export interface ProjectDependencies {
  client: {
    cancelIssue(input: GeneratedCommandCancelIssue): Promise<GeneratedResponseCancelIssue>;
    sendIssue(input: GeneratedCommandSendIssue): Promise<GeneratedResponseSendIssue>;
  };
  access: { requireCancellation(): void };
}

export abstract class ProjectFeature<
  C extends Command<R>,
  R extends Response,
> extends Feature<C, R> {
  declare readonly client: ProjectDependencies["client"];
  declare readonly access: ProjectDependencies["access"];
}

export abstract class ProjectApplicationService<
  C extends Command<R>,
  R extends Response,
> extends ApplicationService<C, R> {
  declare readonly client: ProjectDependencies["client"];
  declare readonly access: ProjectDependencies["access"];
}

export class CancelIssue extends ProjectFeature<CommandCancelIssue, ResponseCancelIssue> {
  static readonly serviceName = "CancelIssue";
  async execute(command: CommandCancelIssue): Promise<ResponseCancelIssue> {
    const result = await this.client.cancelIssue({ issue_id: command.issue_id });
    return new ResponseCancelIssue(result.issue_id, result.resolution);
  }
}

export class RequestCancellation extends ProjectApplicationService<
  CommandRequestCancellation,
  ResponseCancelIssue
> {
  static readonly serviceName = "RequestCancellation";
  execute(command: CommandRequestCancellation): Promise<ResponseCancelIssue> {
    this.access.requireCancellation();
    return this.featureBus.execute(new CommandCancelIssue(command.issue_id));
  }
}

export class SendIssue extends ProjectFeature<CommandSendIssue, ResponseSendIssue> {
  static readonly serviceName = "SendIssue";
  async execute(command: CommandSendIssue): Promise<ResponseSendIssue> {
    const result = await this.client.sendIssue({
      issue_id: command.issue_id,
      message: command.message,
    });
    return new ResponseSendIssue(result.issue_id, result.run_id, result.status);
  }
}

export function projectOf(
  dependencies: ProjectDependencies,
): BoundedContext<ProjectDependencies> {
  const project = new BoundedContext<ProjectDependencies>("project");
  project.addDependency("client", dependencies.client);
  project.addDependency("access", dependencies.access);
  project.feature(CommandCancelIssue)(CancelIssue);
  project.feature(CommandSendIssue)(SendIssue);
  project.appService(CommandRequestCancellation)(RequestCancellation);
  return project;
}
