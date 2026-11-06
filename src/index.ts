/**
 * The public entry of @sincpro/client-framework: everything a client of a sincpro_framework
 * service needs, on any platform.
 *
 * Context: one entry, not one per area — the package has no side effects at import
 * (`sideEffects: false`), so an application pays only for what it uses, and a use case, the
 * client it calls and the entity it reads come from the same place.
 *
 *   client/   the seam with a server: the transport and its REST and in-memory implementations,
 *             entities with typed commands, the service's client contract, client-side ids
 *   model/    model definitions: written by hand, read from a JSON Schema, kept once known
 *   services/ Feature and ApplicationService, the runtime they run in, what each run carries
 *   observability/  the ports a platform plugs: a tracer and an error reporter
 *
 * The generator is `@sincpro/client-framework/codegen`, and the in-memory tracer and reporter
 * `@sincpro/client-framework/testing`: neither is part of what an application runs.
 */
export {
  type ClientContract,
  entityKeyOf,
  kindOf,
  metasOf,
  versionsOf,
} from "@sincpro/client-framework/client/contract";
export {
  bodyFor,
  type CommandAnswers,
  type CommandBodies,
  type CommandRoute,
  type Entity,
  entity,
  type EntityRef,
  type EntityRoutes,
  listRoute,
  NEW_PARAM,
  pathFor,
  PICK_PARAM,
  QUERY_PARAM,
  SCOPE_PARAM,
  scopeOfRef,
  startingValuesOf,
  type SummaryFields,
  type SummaryPart,
  TRAIL_PARAM,
  WITH_PARAM,
  type WriteRoute,
  writeRoute,
} from "@sincpro/client-framework/client/entity";
export { isEntityId, newEntityId } from "@sincpro/client-framework/client/ids";
export {
  type MemoryOptions,
  type MemoryTable,
  memoryTransport,
} from "@sincpro/client-framework/client/memory";
export {
  type RestOptions,
  restTransport,
  urlOf,
  type VersionDrift,
} from "@sincpro/client-framework/client/rest";
export {
  type RetryKeys,
  retryKeys,
  unanswered,
} from "@sincpro/client-framework/client/retry";
export {
  type CallOptions,
  type Draft,
  type Method,
  type One,
  readRoute,
  type SendOptions,
  type Transport,
  TransportError,
} from "@sincpro/client-framework/client/transport";
export {
  defineMeta,
  field,
  type FieldOptions,
  type MetaSpec,
  type Words,
} from "@sincpro/client-framework/model/meta";
export { type MetaStore, metaStore } from "@sincpro/client-framework/model/metas";
export {
  completeMeta,
  type JsonSchema,
  metaFromSchema,
  type SchemaComponents,
} from "@sincpro/client-framework/model/schema";
export {
  type Attributes,
  type ErrorAbout,
  type ErrorReporter,
  NO_TRACER,
  type Outcome,
  type Span,
  type Tracer,
} from "@sincpro/client-framework/observability/ports";
export {
  BIND,
  type Bindable,
  bindable,
  bindDependency,
  bindTransport,
  type Execution,
  headersOf,
} from "@sincpro/client-framework/services/execution";
export {
  ApplicationService,
  bindServices,
  Feature,
} from "@sincpro/client-framework/services/feature";
export {
  createRuntime,
  DETACHED,
  outcomeOf,
  type Runtime,
  type RuntimeOptions,
} from "@sincpro/client-framework/services/runtime";
