import type * as dto from "../../forge-contract/project/domain";
import { Feature } from "../infrastructure/bounded_context";

/** What can be done to an issue. */
export class Issues extends Feature {
  cancel(input: dto.CommandCancelIssue) {
    this.session.require();
    return this.client.cancelIssue(input);
  }

  send(input: dto.CommandSendIssue) {
    return this.client.sendIssue(input);
  }

  /** What this run executes with. */
  runningWith() {
    return this.context;
  }
}
