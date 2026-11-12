import { Command } from "@sincpro/client-framework/core";

import type {
  CommandCancelIssue as CancelInput,
  CommandSendIssue as SendInput,
  ResponseCancelIssue,
  ResponseSendIssue,
} from "../forge-contract/project/domain/generated";
import type { ProjectContext } from "./infrastructure/dependencies";

export class CancelIssue extends Command<ResponseCancelIssue> implements CancelInput {
  constructor(readonly issue_id: string) {
    super();
  }
}
export class SendIssue extends Command<ResponseSendIssue> implements SendInput {
  constructor(
    readonly issue_id: string,
    readonly message: string,
  ) {
    super();
  }
}
export class CancelAndNotify extends Command<ResponseCancelIssue> {
  constructor(readonly issue_id: string) {
    super();
  }
}
export class TellNotice extends Command<string> {
  constructor(readonly text: string) {
    super();
  }
}
export class RunningWith extends Command<Readonly<Partial<ProjectContext>>> {}
