/**
 * Model definitions: written by hand (`defineMeta`), read from a JSON Schema, kept once known.
 *
 *   domain/          `defineMeta`, `field`
 *   services/        `metaFromSchema`, `completeMeta`
 *   infrastructure/  `metaStore`: the definitions already known
 */
export {
  defineMeta,
  field,
  type FieldOptions,
  type MetaSpec,
  type Words,
} from "@sincpro/client-framework/model/domain/meta";
export {
  type MetaStore,
  metaStore,
} from "@sincpro/client-framework/model/infrastructure/metas";
export {
  completeMeta,
  type JsonSchema,
  metaFromSchema,
  type SchemaComponents,
} from "@sincpro/client-framework/model/services/schema";
