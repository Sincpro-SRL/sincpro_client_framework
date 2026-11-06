import type * as dto from "../../forge-contract/project/domain";
import { ApplicationService } from "../infrastructure/bounded_context";

/** Cancel an issue and say so. */
export class CancelAndNotify extends ApplicationService {
  async execute(input: dto.CommandCancelIssue) {
    const answer = await this.feature.Issues.cancel(input);
    this.feature.Notices.tell(`${answer.issue_id} ${answer.resolution}`);
    return answer;
  }
}
