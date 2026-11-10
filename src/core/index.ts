/**
 * The application core (`./core`): the backend's application abstractions — class Commands and
 * Responses, Features and ApplicationServices, a bounded context that is their bus, its error
 * handlers — and the process they run in.
 *
 *   domain/          DTOs, the bus, the service bases, the error-handler contract
 *   services/        the execution pipeline, dependency binding, the handler chain
 *   entrypoint/      `BoundedContext`, `screensTransport`
 *   infrastructure/  `configureProcess`, `configureLogger`
 */
export { type CommandBus, FeatureBus } from "@sincpro/client-framework/core/domain/bus";
export {
  Command,
  DataTransferObject,
  Response,
} from "@sincpro/client-framework/core/domain/dto";
export type { ErrorClass, ErrorHandler } from "@sincpro/client-framework/core/domain/errors";
export { ApplicationService, Feature } from "@sincpro/client-framework/core/domain/services";
export { BoundedContext } from "@sincpro/client-framework/core/entrypoint/bounded-context";
export { screensTransport } from "@sincpro/client-framework/core/entrypoint/screens";
export {
  configureLogger,
  configureProcess,
  type LoggerConfiguration,
  type ProcessOptions,
} from "@sincpro/client-framework/core/infrastructure/process";
