/**
 * The context: the levels a call sees (the process, its bounded context, a scope), where they
 * live (`ContextStore`, a port each platform implements), what travels with a request, and the
 * execution a run carries.
 *
 *   domain/          the ports and rules: `ContextStore`, `ContextCodec`, what travels, `Execution`
 *   adapters/        the implementations this package gives: memory, the plain codec
 *   entrypoint/      `Context`: one door over a level
 *   infrastructure/  the process's store and its level (`processContext`)
 */
export { memoryContexts } from "@sincpro/client-framework/context/adapters/memory";
export { plainCodec } from "@sincpro/client-framework/context/adapters/plain-codec";
export {
  CONTEXT_HEADER,
  type ContextCodec,
  travelling,
  travels,
} from "@sincpro/client-framework/context/domain/codec";
export {
  BIND,
  type Bindable,
  type Execution,
} from "@sincpro/client-framework/context/domain/execution";
export type {
  ContextStore,
  ContextValues,
} from "@sincpro/client-framework/context/domain/store";
export type { Context } from "@sincpro/client-framework/context/entrypoint/context";
export { processContext } from "@sincpro/client-framework/context/infrastructure/process";
