import { Feature } from "../infrastructure/bounded_context";

/** What «project» tells people. */
export class Notices extends Feature {
  tell(text: string) {
    this.outbox.sent.push(text);
    return text;
  }

  /** What this run executes with — the same as the run that executed it. */
  runningWith() {
    return this.context;
  }
}
