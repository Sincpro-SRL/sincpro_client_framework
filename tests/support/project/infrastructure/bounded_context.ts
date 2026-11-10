import {
  ApplicationService as BaseApplicationService,
  BoundedContext,
  type Command,
  Feature as BaseFeature,
} from "@sincpro/client-framework/core";

import {
  type ProjectContext,
  type ProjectDependencies,
  registerDependencies,
} from "./dependencies";

export abstract class Feature<C extends Command<R>, R> extends BaseFeature<
  C,
  R,
  ProjectContext
> {
  declare readonly client: ProjectDependencies["client"];
  declare readonly session: ProjectDependencies["session"];
  declare readonly outbox: ProjectDependencies["outbox"];
}

export abstract class ApplicationService<
  C extends Command<R>,
  R,
> extends BaseApplicationService<C, R, ProjectContext> {
  declare readonly client: ProjectDependencies["client"];
  declare readonly session: ProjectDependencies["session"];
  declare readonly outbox: ProjectDependencies["outbox"];
}

export function configProjectBoundedContext(name: string) {
  return registerDependencies(new BoundedContext<ProjectDependencies, ProjectContext>(name));
}
