/**
 * The application core (`./core`): the backend's application abstractions — class Commands and
 * Responses, Features and ApplicationServices, a bounded context that is their bus, its error
 * handlers — and the process they run in.
 *
 *   domain/          DTOs (classes, and generated ones the bus recognizes), the bus, the service
 *                    bases (`servicesWith`: typed with a context's dependencies), the error handlers
 *   services/        the execution pipeline, dependency binding, the handler chain
 *   entrypoint/      `BoundedContext`, `screensTransport`
 *   infrastructure/  `configureProcess`, `configureLogger`
 */
export { type CommandBus, FeatureBus } from "@sincpro/client-framework/core/domain/bus";
export type {
  EventConsumer,
  EventKey,
} from "@sincpro/client-framework/core/domain/consumers";
export {
  type AnyCommand,
  Command,
  COMMAND_IDENTITY,
  type CommandClass,
  type CommandDescriptor,
  type CommandNamed,
  commandOf,
  DataTransferObject,
  DomainEvent,
  type DtoKey,
  type EventClass,
  type EventDescriptor,
  type Executable,
  type ExecutableOf,
  type RemoteCommand,
  type RemoteEvent,
  Response,
} from "@sincpro/client-framework/core/domain/dto";
export type { ErrorClass, ErrorHandler } from "@sincpro/client-framework/core/domain/errors";
export type {
  CallNext,
  Cause,
  ExecuteOptions,
  ExecutionCompleted,
  ExecutionFailed,
  ExecutionStarted,
  Extension,
  InterceptedRun,
  Interceptor,
  Listener,
  PipelineLayer,
} from "@sincpro/client-framework/core/domain/pipeline";
export {
  ApplicationService,
  type ApplicationServiceWith,
  type BoundedContextHandlerWith,
  EventHandler,
  type EventHandlerWith,
  Feature,
  type FeatureWith,
  type HandledEvent,
  handlersWith,
  type ServiceInput,
  servicesWith,
} from "@sincpro/client-framework/core/domain/services";
export {
  BoundedContext,
  type Registrar,
  type RegistrationOptions,
} from "@sincpro/client-framework/core/entrypoint/bounded-context";
export { screensTransport } from "@sincpro/client-framework/core/entrypoint/screens";
export { processListeners } from "@sincpro/client-framework/core/infrastructure/listeners";
export {
  configureLogger,
  configureProcess,
  type LoggerConfiguration,
  processIdentity,
  type ProcessOptions,
} from "@sincpro/client-framework/core/infrastructure/process";
export type { HandlerRegistrar } from "@sincpro/client-framework/core/services/event-handlers";
