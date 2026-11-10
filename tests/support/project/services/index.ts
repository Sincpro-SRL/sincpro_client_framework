import type { BoundedContext } from "@sincpro/client-framework/core";

import * as commands from "../domain";
import type { ProjectContext, ProjectDependencies } from "../infrastructure/dependencies";
import { CancelAndNotify } from "./cancel_and_notify";
import { Cancel, CurrentContext, Send } from "./issues";
import { Tell } from "./notices";

export function registerServices(
  context: BoundedContext<ProjectDependencies, ProjectContext>,
) {
  context.feature(commands.CancelIssue)(Cancel);
  context.feature(commands.SendIssue)(Send);
  context.feature(commands.TellNotice)(Tell);
  context.feature(commands.RunningWith)(CurrentContext);
  context.appService(commands.CancelAndNotify)(CancelAndNotify);
}
