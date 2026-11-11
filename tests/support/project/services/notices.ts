import type { TellNotice } from "../domain";
import { Feature } from "../infrastructure/bounded_context";

export class Tell extends Feature<TellNotice, string> {
  execute(command: TellNotice) {
    this.outbox.sent.push(command.text);
    return command.text;
  }
}
