import { field, type FieldOptions } from "@sincpro/client-framework/model/meta";
import type { FieldMeta, Meta } from "@sincpro/criteria";

/**
 * A model definition read from a JSON Schema — what an OpenAPI document holds.
 *
 * Context: a model a READ answers is published by sincpro_framework as its contract — JSON
 * Schema with `x-sincpro` — and read by the transport (`metaFromContract`, `core/discovery`).
 * What has no `x-sincpro` is a plain JSON Schema: a COMMAND's body, a value object it carries.
 *
 * So this reads such a component schema into a `Meta` — the form of a Command, a value object —
 * and `completeMeta` fills, from it, what a definition left `unknown`.
 *
 *     const spec = metaFromSchema("ProjectSpecification", doc.components.schemas);
 *     const fixed = completeMeta(project.fields.specification.definition, spec);
 */
export type JsonSchema = {
  type?: string | string[];
  format?: string;
  enum?: readonly unknown[];
  items?: JsonSchema;
  $ref?: string;
  anyOf?: readonly JsonSchema[];
  oneOf?: readonly JsonSchema[];
  properties?: Readonly<Record<string, JsonSchema>>;
  required?: readonly string[];
  title?: string;
  description?: string;
  default?: unknown;
};

export type SchemaComponents = Readonly<Record<string, JsonSchema>>;

const UNKNOWN: FieldMeta = {
  type: "unknown",
  kind: "scalar",
  nullable: true,
  sortable: false,
  ops: [],
};

function nameOfRef(ref: string): string {
  return ref.slice(ref.lastIndexOf("/") + 1);
}

/** `anyOf: [X, {type: "null"}]` is `X`, nullable — how pydantic writes `X | None`. */
function unwrap(schema: JsonSchema): { schema: JsonSchema; nullable: boolean } {
  const options = schema.anyOf ?? schema.oneOf;
  if (options === undefined) return { schema, nullable: false };
  const real = options.filter((one) => one.type !== "null");
  const [only] = real;
  return real.length === 1 && only !== undefined
    ? { schema: { ...only, ...pick(schema) }, nullable: real.length < options.length }
    : { schema, nullable: real.length < options.length };
}

/** The words of the outer schema win over the ones of what it wraps. */
function pick(schema: JsonSchema): JsonSchema {
  return {
    ...(schema.title === undefined ? {} : { title: schema.title }),
    ...(schema.description === undefined ? {} : { description: schema.description }),
    ...(schema.default === undefined ? {} : { default: schema.default }),
  };
}

function fieldFrom(
  raw: JsonSchema,
  required: boolean,
  components: SchemaComponents,
  seen: ReadonlySet<string>,
): FieldMeta {
  const { schema: unwrapped, nullable } = unwrap(raw);
  const target =
    unwrapped.$ref !== undefined
      ? { ...components[nameOfRef(unwrapped.$ref)], ...pick(unwrapped) }
      : unwrapped;
  const options: FieldOptions = {
    ...(target.title === undefined ? {} : { label: target.title }),
    ...(target.description === undefined ? {} : { help: target.description }),
    ...(target.default === undefined ? {} : { default: target.default }),
    ...(nullable ? { nullable } : {}),
    required: required && target.default === undefined && !nullable,
  };

  if (unwrapped.$ref !== undefined) {
    const name = nameOfRef(unwrapped.$ref);
    if (components[name] === undefined || seen.has(name)) return UNKNOWN;
    if (target.properties === undefined)
      return target.enum ? field.choice(target.enum.map(String), options) : UNKNOWN;
    return field.embedded(
      metaOf(name, target, components, new Set([...seen, name])),
      options,
    );
  }
  if (target.enum) return field.choice(target.enum.map(String), options);

  const type = Array.isArray(target.type)
    ? target.type.find((t) => t !== "null")
    : target.type;
  switch (type) {
    case "string":
      if (target.format === "date") return field.date(options);
      if (target.format === "date-time") return field.datetime(options);
      return field.text(options);
    case "integer":
      return field.integer(options);
    case "number":
      return field.number(options);
    case "boolean":
      return field.boolean(options);
    case "array": {
      const item = target.items === undefined ? undefined : unwrap(target.items).schema;
      if (item?.$ref !== undefined) {
        const inner = fieldFrom(item, false, components, seen);
        return inner.kind === "embedded" && inner.definition
          ? field.embedded(inner.definition, { ...options, many: true })
          : field.tags(options);
      }
      return item?.type === "string" || item?.enum ? field.tags(options) : UNKNOWN;
    }
    default:
      return UNKNOWN;
  }
}

function metaOf(
  name: string,
  schema: JsonSchema,
  components: SchemaComponents,
  seen: ReadonlySet<string>,
): Meta {
  const required = new Set(schema.required ?? []);
  const fields = Object.fromEntries(
    Object.entries(schema.properties ?? {}).map(([key, property]) => [
      key,
      fieldFrom(property, required.has(key), components, seen),
    ]),
  );
  return {
    aggregate: name,
    identity: "",
    default_order: "",
    fields,
    ...(schema.title === undefined ? {} : { name: { default: schema.title } }),
  };
}

/** The definition a component schema describes. `identity` empty: a value object has none. */
export function metaFromSchema(
  name: string,
  components: SchemaComponents,
  options: { identity?: string } = {},
): Meta {
  const schema = components[name];
  if (schema === undefined) throw new Error(`no schema named ${name}`);
  const meta = metaOf(name, schema, components, new Set([name]));
  return options.identity
    ? { ...meta, identity: options.identity, get_id: options.identity }
    : meta;
}

/**
 * The server's definition, with what it left `unknown` taken from the schema — recursively
 * into value objects. What the server DID say always wins: its labels, its operators, its
 * hints. A field the schema does not know is left as the server sent it.
 */
export function completeMeta(meta: Meta, schema: Meta): Meta {
  const fields = Object.fromEntries(
    Object.entries(meta.fields).map(([name, own]) => {
      const known = schema.fields[name];
      if (known === undefined) return [name, own];
      if (own.type === "unknown") return [name, { ...known, ...labelsOf(own) }];
      if (own.kind === "embedded" && own.definition && known.definition)
        return [name, { ...own, definition: completeMeta(own.definition, known.definition) }];
      return [name, own];
    }),
  );
  return { ...meta, fields };
}

/** A label the server declared is kept over the schema's generated title. */
function labelsOf(own: FieldMeta): Partial<FieldMeta> {
  return own.label && Object.keys(own.label).length > 0 ? { label: own.label } : {};
}
