/**
 * «project», set up as an application sets up each of its bounded contexts — the layout
 * sincpro_framework's services have:
 *
 *   infrastructure/dependencies.ts     what the services can count on, and where each comes from
 *   infrastructure/bounded_context.ts  its Feature and ApplicationService, and how it is made
 *   services/                          the services, and the names they are reached by
 *   index.ts                           the bounded context, ready to use
 */
import { configProjectBoundedContext } from "./infrastructure/bounded_context";
import { applicationServices, features } from "./services";

export const project = configProjectBoundedContext("project").register({
  features,
  applicationServices,
});
