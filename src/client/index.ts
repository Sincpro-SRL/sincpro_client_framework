/**
 * The seam with a server: the `Transport` port and its implementations, entities with typed
 * commands, the service's client contract, and how a run's trace and context reach the wire.
 *
 *   domain/    the port and the server's words: `Transport`, `TransportError`, `entity()`, the
 *              client contract
 *   adapters/  REST, memory, and Parquet (optional entry `./parquet`)
 *   services/  discovery, retry keys, propagation (`traceparent`, `sincpro-context`)
 */
export {
  type MemoryOptions,
  type MemoryTable,
  memoryTransport,
} from "@sincpro/client-framework/client/adapters/memory";
export {
  type RestOptions,
  restTransport,
  urlOf,
  type VersionDrift,
} from "@sincpro/client-framework/client/adapters/rest";
export {
  type ClientContract,
  entityKeyOf,
  kindOf,
  metasOf,
  versionsOf,
} from "@sincpro/client-framework/client/domain/contract";
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
} from "@sincpro/client-framework/client/domain/entity";
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
} from "@sincpro/client-framework/client/domain/transport";
export {
  bindable,
  bindTransport,
  headersOf,
} from "@sincpro/client-framework/client/services/propagation";
export {
  type RetryKeys,
  retryKeys,
  unanswered,
} from "@sincpro/client-framework/client/services/retry";
