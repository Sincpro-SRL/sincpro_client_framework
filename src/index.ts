/**
 * The public entry of @sincpro/client-framework: everything a client of a sincpro_framework
 * service needs, on any platform.
 *
 * Context: one entry, not one per area — the package has no side effects at import
 * (`sideEffects: false`), so an application pays only for what it uses. Each module is laid out
 * as sincpro_framework's are — `domain/` (ports and rules), `adapters/` (their implementations),
 * `services/`, `infrastructure/`, `entrypoint/` — and says what it offers in its own `index.ts`:
 *
 *   common/         the values of the wire, as the backend writes them
 *   context/        the context's levels, where they live, what travels, the execution
 *   observability/  tracing, error reporting and logging: ports, console, loggers
 *   client/         the seam with a server: transports, entities, the client contract
 *   model/          model definitions
 *   core/           Commands, events, Features, ApplicationServices, BoundedContext, the
 *                   pipeline's extension points, the process
 *   event_driven/   publishing and subscribing to domain events: ports, Publisher, Subscriber
 *
 * The generator is `@sincpro/client-framework/codegen`, and the in-memory observability
 * `@sincpro/client-framework/testing`: neither is part of what an application runs.
 */
export * from "@sincpro/client-framework/client";
export * from "@sincpro/client-framework/common";
export * from "@sincpro/client-framework/context";
export * from "@sincpro/client-framework/core";
export * from "@sincpro/client-framework/event_driven";
export * from "@sincpro/client-framework/model";
export * from "@sincpro/client-framework/observability";
