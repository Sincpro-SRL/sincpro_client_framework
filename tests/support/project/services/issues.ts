import type {
  ResponseCancelIssue,
  ResponseSendIssue,
} from "../../forge-contract/project/domain/generated";
import type { CancelIssue, RunningWith, SendIssue } from "../domain";
import { Feature } from "../infrastructure/bounded_context";
import type { ProjectContext } from "../infrastructure/dependencies";

export class Cancel extends Feature<CancelIssue, ResponseCancelIssue> {
  execute(input: CancelIssue) {
    this.session.require();
    return this.client.cancelIssue({ issue_id: input.issue_id });
  }
}
export class Send extends Feature<SendIssue, ResponseSendIssue> {
  execute(input: SendIssue) {
    return this.client.sendIssue({ issue_id: input.issue_id, message: input.message });
  }
}
export class CurrentContext extends Feature<RunningWith, Readonly<Partial<ProjectContext>>> {
  execute() {
    return this.context;
  }
}
