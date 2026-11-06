import {
  ApplicationService as BaseApplicationService,
  Feature as BaseFeature,
  UseBoundedContext,
} from "@sincpro/client-framework";

import type { ProjectFeatures } from "../services";
import {
  type ProjectContext,
  type ProjectDependencies,
  registerDependencies,
} from "./dependencies";

/** A Feature of «project»: `this.client`, `this.session`, `this.outbox`, `this.context` typed. */
export class Feature extends BaseFeature<ProjectDependencies, ProjectContext> {}

/** An ApplicationService of «project»: the same, and `this.feature.<Name>` for each Feature. */
export class ApplicationService extends BaseApplicationService<
  ProjectDependencies,
  ProjectFeatures,
  ProjectContext
> {}

export function configProjectBoundedContext(name: string) {
  return registerDependencies(
    new UseBoundedContext<ProjectDependencies, ProjectContext>(name),
  );
}
