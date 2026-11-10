import { configProjectBoundedContext } from "./infrastructure/bounded_context";
import { registerServices } from "./services";

export const project = configProjectBoundedContext("project");
registerServices(project);
