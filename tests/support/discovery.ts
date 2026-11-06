import type { MemoryTable } from "@sincpro/client-framework";
import type { Contract, ContractProperty, Meta } from "@sincpro/criteria";

/**
 * The discovery document a running sincpro_framework service publishes, written from the
 * definitions the simulated service holds: each model as its contract — JSON Schema with
 * `x-sincpro` — and each list and record route saying which model it answers.
 *
 * Context: a service describes a model once, in its document; an answer carries only the
 * version of it. The simulation answers the same way, so a story over `restTransport` reads
 * the definitions the way an app does in production.
 */
export const VERSION = "simulated-v1";

/** A definition as the contract the framework would publish for it. */
export function contractOf(meta: Meta): Contract {
  const properties: Record<string, ContractProperty> = {};
  const required: string[] = [];
  for (const [name, field] of Object.entries(meta.fields)) {
    const { kind: _kind, nullable, required: asked, choices, definition, ...said } = field;
    const shape: ContractProperty =
      field.type === "embedded" && definition
        ? field.many
          ? { type: "array", items: contractOf(definition) }
          : (contractOf(definition) as unknown as ContractProperty)
        : {};
    if (choices !== undefined) shape.enum = choices;
    const property: ContractProperty = nullable
      ? { anyOf: [shape, { type: "null" }] }
      : shape;
    property["x-sincpro"] = said as ContractProperty["x-sincpro"];
    properties[name] = property;
    if (asked) required.push(name);
  }
  return {
    type: "object",
    title: meta.aggregate,
    properties,
    required,
    "x-sincpro": {
      entity: meta.aggregate,
      ...(meta.identity ? { identity: meta.identity } : {}),
      ...(meta.default_order ? { default_order: meta.default_order } : {}),
      ...(meta.get_id ? { get_id: meta.get_id } : {}),
      ...(meta.display ? { display: meta.display } : {}),
      ...(meta.search ? { search: meta.search } : {}),
      ...(meta.detail ? { detail: meta.detail } : {}),
      title: meta.name ?? { default: meta.aggregate },
      version: VERSION,
    },
  };
}

/** Every model `meta` reaches — itself, and what its relations point at — by aggregate name. */
function modelsOf(meta: Meta, into: Record<string, Contract>, seen = new Set<Meta>()): void {
  if (seen.has(meta)) return;
  seen.add(meta);
  into[meta.aggregate] ??= contractOf(meta);
  for (const field of Object.values(meta.fields)) {
    if (field.kind === "relation" && field.definition) modelsOf(field.definition, into, seen);
  }
}

/** The document of the simulated service: its tables' models, and the routes that answer them. */
export function discoveryDocument(
  tables: Readonly<Record<string, MemoryTable>>,
  base: string,
): Record<string, unknown> {
  const schemas: Record<string, Contract> = {};
  const paths: Record<string, unknown> = {};
  // The tables' own definitions first: a relation's is often cut to what a screen shows of it.
  for (const table of Object.values(tables))
    schemas[table.meta.aggregate] ??= contractOf(table.meta);
  for (const [route, table] of Object.entries(tables)) {
    modelsOf(table.meta, schemas);
    const answering = { get: { "x-sincpro-entities": [table.meta.aggregate] } };
    paths[`${base}${route}`] = answering;
    paths[`${base}${route}/{id}`] = answering;
  }
  return { openapi: "3.1.0", paths, components: { schemas } };
}
