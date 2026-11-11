import type { ResponseCancelIssue } from "../../forge-contract/project/domain";
import type { CancelAndNotify as Request } from "../domain";
import { CancelIssue, TellNotice } from "../domain";
import { ApplicationService } from "../infrastructure/bounded_context";

export class CancelAndNotify extends ApplicationService<Request, ResponseCancelIssue> {
  async execute(command: Request) {
    const answer = await this.featureBus.execute(new CancelIssue(command.issue_id));
    await this.featureBus.execute(new TellNotice(`${answer.issue_id} ${answer.resolution}`));
    return answer;
  }
}
