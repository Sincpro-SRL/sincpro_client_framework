import type { Expression, FieldMeta, FieldType, Meta, Operator } from "@sincpro/criteria";

/**
 * A model definition written by hand, in the shape sincpro_framework publishes.
 *
 * Context: everything in this package reads a `Meta` — the labels, the columns, the controls,
 * the search box. A service built with sincpro_framework sends one with every answer. A domain
 * that has none (another backend, rows a screen already holds, a prototype
 * with no server yet) declares it here, and from then on it is indistinguishable: the same
 * list, the same record, the same criteria. `describeRows` from `@sincpro/criteria` guesses
 * one from rows; this one is written on purpose, with the words a person reads.
 *
 *     const tickets = defineMeta({
 *       aggregate: "Ticket", identity: "id", display: "title", search: ["title"],
 *       name: { es: "Tickets" },
 *       fields: {
 *         id: field.text({ readonly: true }),
 *         title: field.text({ label: { es: "Título" }, required: true }),
 *         stage: field.choice(["new", "done"], { labels: { new: { es: "Nuevo" } } }),
 *         opened_at: field.datetime({ label: { es: "Abierto" } }),
 *       },
 *     });
 */

/** A word in several languages, `{default?, es?, en?, …}`; a bare string is the default. */
export type Words = string | Readonly<Record<string, string>>;

export type FieldOptions = {
  label?: Words;
  help?: Words;
  required?: boolean;
  readonly?: boolean;
  /** Holds no value sometimes. It still orders, as sincpro_framework orders it: NULL first
   *  ascending and last descending, and the keyset walks past it. */
  nullable?: boolean;
  default?: unknown;
  /** Form hints over the record, as sincpro_framework's `Presentation` publishes them. */
  readonlyWhen?: Expression;
  requiredWhen?: Expression;
  visibleWhen?: Expression;
};

function hints(options: FieldOptions): Partial<FieldMeta> {
  return {
    ...(options.readonlyWhen ? { readonly_when: options.readonlyWhen } : {}),
    ...(options.requiredWhen ? { required_when: options.requiredWhen } : {}),
    ...(options.visibleWhen ? { visible_when: options.visibleWhen } : {}),
  };
}

/** The comparisons each type takes — the same table sincpro_framework publishes. */
const OPS: Partial<Record<FieldType, readonly Operator[]>> = {
  text: ["=", "!=", "like", "starts with", "in", "not in"],
  integer: ["=", "!=", ">", ">=", "<", "<=", "between", "in", "not in"],
  number: ["=", "!=", ">", ">=", "<", "<=", "between", "in", "not in"],
  date: ["=", "!=", ">", ">=", "<", "<=", "between"],
  datetime: ["=", "!=", ">", ">=", "<", "<=", "between"],
  boolean: ["="],
  "text[]": ["contains", "not contains", "=", "!="],
};

function words(value: Words | undefined): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  return typeof value === "string" ? { default: value } : { ...value };
}

function scalar(type: FieldType, options: FieldOptions = {}): FieldMeta {
  const nullable = options.nullable ?? false;
  const ops = [...(OPS[type] ?? [])];
  if (nullable && type !== "text[]" && type !== "boolean") ops.push("is null");
  const listed = type === "text[]";
  return {
    type,
    kind: "scalar",
    nullable,
    sortable: !listed,
    groupable: !listed,
    ops,
    ...(options.label === undefined ? {} : { label: words(options.label) }),
    ...(options.help === undefined ? {} : { help: words(options.help) }),
    ...(options.required === undefined ? {} : { required: options.required }),
    ...(options.readonly === undefined ? {} : { readonly: options.readonly }),
    ...(options.default === undefined ? {} : { default: options.default }),
    ...hints(options),
  };
}

function relational(
  type: "many2one" | "one2many" | "many2many",
  relation: string,
  keys: { identifiedBy: string; definition?: Meta },
  options: FieldOptions = {},
): FieldMeta {
  return {
    type,
    kind: "relation",
    nullable: options.nullable ?? type === "many2one",
    sortable: false,
    ops: [],
    many: type !== "many2one",
    relation,
    identified_by: keys.identifiedBy,
    ...(keys.definition === undefined ? {} : { definition: keys.definition }),
    ...(options.label === undefined ? {} : { label: words(options.label) }),
    ...(options.help === undefined ? {} : { help: words(options.help) }),
    ...(options.readonly === undefined ? {} : { readonly: options.readonly }),
  };
}

/** The field builders: one per type the framework publishes. */
export const field = {
  text: (options?: FieldOptions) => scalar("text", options),
  integer: (options?: FieldOptions) => scalar("integer", options),
  /** A decimal travels as text so no digit is lost (`"10.50"`): pass `exact: true`. */
  number: (options?: FieldOptions & { exact?: boolean }) => ({
    ...scalar("number", options),
    ...(options?.exact ? { exact: true } : {}),
  }),
  boolean: (options?: FieldOptions) => scalar("boolean", options),
  date: (options?: FieldOptions) => scalar("date", options),
  datetime: (options?: FieldOptions) => scalar("datetime", options),
  tags: (options?: FieldOptions) => scalar("text[]", options),
  /** An enum: the values in order, and the word each one is read as. */
  choice: (
    values: readonly string[],
    options: FieldOptions & { labels?: Readonly<Record<string, Words>> } = {},
  ): FieldMeta => ({
    ...scalar("text", options),
    ops: ["=", "!=", "in", "not in", ...(options.nullable ? (["is null"] as const) : [])],
    choices: [...values],
    ...(options.labels === undefined
      ? {}
      : {
          choice_labels: Object.fromEntries(
            Object.entries(options.labels).map(([value, said]) => [value, words(said) ?? {}]),
          ),
        }),
  }),
  /** Points at ONE record of another aggregate, by the scalar key this record holds. */
  many2one: (
    relation: string,
    keys: { identifiedBy: string; definition?: Meta },
    options?: FieldOptions,
  ) => relational("many2one", relation, keys, options),
  /** The records of another aggregate that point back here, by THEIR key. */
  one2many: (
    relation: string,
    keys: { identifiedBy: string; definition?: Meta },
    options?: FieldOptions,
  ) => relational("one2many", relation, keys, options),
  many2many: (
    relation: string,
    keys: { identifiedBy: string; definition?: Meta },
    options?: FieldOptions,
  ) => relational("many2many", relation, keys, options),
  /** A value object kept inside the record — an address, a specification. No identity. */
  embedded: (
    definition: Meta,
    options: FieldOptions & { many?: boolean } = {},
  ): FieldMeta => ({
    type: "embedded",
    kind: "embedded",
    nullable: options.nullable ?? false,
    sortable: false,
    ops: [],
    definition,
    ...(options.many ? { many: true } : {}),
    ...(options.label === undefined ? {} : { label: words(options.label) }),
  }),
};

export type MetaSpec = {
  aggregate: string;
  identity: string;
  fields: Record<string, FieldMeta>;
  name?: Words;
  /** The field shown beside the identity: what a select and a many2one show. */
  display?: string;
  /** `"-created_at"`, the way a URL writes it. Without it, the identity ascending. */
  defaultOrder?: string;
  /** The text fields a typed text is looked for in — the entity's search template. */
  search?: readonly string[];
};

/** The template a typed text fills: `like` over each field, any of them matching. */
function searchTemplate(fields: readonly string[]): Record<string, unknown> | null {
  if (fields.length === 0) return null;
  const like = (name: string) => ({
    field: name,
    operator: "like",
    value: { $: "param", name: "text" },
  });
  const [only] = fields;
  return {
    selection:
      fields.length === 1 && only !== undefined ? like(only) : { any: fields.map(like) },
  };
}

/** A whole definition, from its fields. See the file header. */
export function defineMeta(spec: MetaSpec): Meta {
  const missing = [spec.identity, spec.display, ...(spec.search ?? [])].filter(
    (name): name is string => name !== undefined && name !== "" && !(name in spec.fields),
  );
  if (missing.length > 0)
    throw new Error(`${spec.aggregate}: ${missing.join(", ")} named but not declared`);
  return {
    aggregate: spec.aggregate,
    identity: spec.identity,
    default_order: spec.defaultOrder ?? spec.identity,
    fields: spec.fields,
    get_id: spec.identity,
    ...(spec.name === undefined ? {} : { name: words(spec.name) }),
    ...(spec.display === undefined ? {} : { display: spec.display }),
    search: searchTemplate(spec.search ?? []),
  };
}
