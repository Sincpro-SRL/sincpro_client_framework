/**
 * The public entry of @sincpro/client-framework: everything a client of a sincpro_framework
 * service needs, on any platform.
 *
 * Context: one entry, not one per area — the package has no side effects at import
 * (`sideEffects: false`), so an application pays only for what it uses, and a use case, the
 * client it calls and the entity it reads come from the same place.
 *
 *   common/   the values of the wire, as the backend writes them: ids, a day and an instant,
 *             `Decimal`, `Money`, a to-many as a page of its records (`EntityCollection`), and
 *             how any value is written and read (`valuesOf`, `rebuilt`)
 *   client/   the seam with a server: the transport and its REST and in-memory implementations,
 *             entities with typed commands, the service's client contract
 *   model/    model definitions: written by hand, read from a JSON Schema, kept once known
 *   services/ the bounded context (`UseBoundedContext`), its `Feature` and `ApplicationService`,
 *             the process they run in (`configureProcess`), what each run carries
 *   context/  the context: one door (`Context`) over the store each platform plugs
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
  type ExportFormat,
  exportRoute,
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
  type Decoder,
  type Download,
  downloadRoute,
  type Draft,
  type Method,
  type One,
  readRoute,
  type SendOptions,
  type Transport,
  TransportError,
} from "@sincpro/client-framework/client/transport";
export {
  collectionOf,
  type EntityCollection,
  type HeldCollection,
  isCollection,
  isPartial,
  relatedCriteria,
  type RelationKeys,
  totalOf,
} from "@sincpro/client-framework/common/collection";
export { Decimal, type DecimalLike } from "@sincpro/client-framework/common/decimal";
export { isEntityId, momentOf, newEntityId } from "@sincpro/client-framework/common/ids";
export { Money } from "@sincpro/client-framework/common/money";
export {
  BYTES,
  type JsonValue,
  pack,
  readValues,
  type Rebuild,
  rebuilt,
  unpack,
  valuesOf,
} from "@sincpro/client-framework/common/serialization";
export {
  dayOf,
  installTimeZone,
  instantOf,
  isDay,
  timeZoneNow,
  wallTimeOf,
} from "@sincpro/client-framework/common/time";
export {
  CONTEXT_HEADER,
  type ContextCodec,
  plainCodec,
  travelling,
  travels,
} from "@sincpro/client-framework/context/codec";
export { type Context } from "@sincpro/client-framework/context/context";
export {
  type ContextStore,
  type ContextValues,
  memoryContexts,
} from "@sincpro/client-framework/context/store";
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
  type BoundedContext,
  UseBoundedContext,
} from "@sincpro/client-framework/services/bounded-context";
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
  Feature,
  type ServiceClasses,
  type ServiceMethods,
  type Services,
} from "@sincpro/client-framework/services/feature";
export {
  configureProcess,
  outcomeOf,
  processContext,
  type ProcessOptions,
} from "@sincpro/client-framework/services/process";
export { reportError } from "@sincpro/client-framework/services/report";
export { screensTransport } from "@sincpro/client-framework/services/screens";
