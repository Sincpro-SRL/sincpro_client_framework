/**
 * The values of the wire, as the backend writes them: ids, a day and an instant, `Decimal`,
 * `Money`, a to-many as a page of its records, and how any value is written and read.
 */
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
export {
  type DeclaredFailure,
  type Failure,
  failureOf,
  kindOfGrpcCode,
  kindOfHttpStatus,
  kindOfJsonRpcCode,
  PERMANENT_KINDS,
} from "@sincpro/client-framework/common/failures";
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
  timeZoneOf,
  wallTimeOf,
} from "@sincpro/client-framework/common/time";
