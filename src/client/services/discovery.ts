import { type Contract, type Meta, metaFromContract, versionOf } from "@sincpro/criteria";

/**
 * The discovery document of a bounded context, as far as this reads it: its paths, each
 * operation with the entities it belongs to, and the published contract of every model.
 *
 * Context: sincpro_framework describes a model once — JSON Schema with `x-sincpro`, under the
 * document's `components.schemas` — and every read answers only the version of it
 * (`model_version`). So the definition a list, a form and a select are built from is read here,
 * once, and asked for again only when an answer says another version.
 */
export type DiscoveryDocument = {
  paths?: Readonly<Record<string, Readonly<Record<string, DiscoveryOperation>>>>;
  components?: { schemas?: Readonly<Record<string, DocumentSchema>> };
};

export type DiscoveryOperation = {
  "x-sincpro-entities"?: readonly string[];
  responses?: Readonly<
    Record<string, { content?: Readonly<Record<string, { schema?: DocumentSchema }>> }>
  >;
};

type DocumentSchema = {
  $ref?: string;
  items?: DocumentSchema;
  anyOf?: readonly DocumentSchema[];
  properties?: Readonly<Record<string, DocumentSchema>>;
  "x-sincpro"?: { entity?: string; version?: string };
};

function nameOfRef(ref: string | undefined): string | undefined {
  return ref === undefined ? undefined : ref.slice(ref.lastIndexOf("/") + 1);
}

/** Whether a document path (`/v1/projects/{id}`) answers a request path (`/v1/projects/p1`). */
function answers(template: string, path: string): boolean {
  const pattern = template
    .split("/")
    .map((part) =>
      /^\{[^}]+\}$/.test(part) ? "[^/]+" : part.replace(/[.*+?^$()|[\]\\]/g, "\\$&"),
    )
    .join("/");
  return new RegExp(`^${pattern}$`).test(path);
}

/** The entity a schema describes, or the one its records hold: an answer's records field. */
function entityIn(
  schema: DocumentSchema | undefined,
  schemas: Readonly<Record<string, DocumentSchema>>,
  seen: Set<string> = new Set(),
): string | undefined {
  if (schema === undefined) return undefined;
  const named = nameOfRef(schema.$ref);
  if (named !== undefined) {
    if (seen.has(named)) return undefined;
    seen.add(named);
    const target = schemas[named];
    return target?.["x-sincpro"]?.entity !== undefined
      ? named
      : entityIn(target, schemas, seen);
  }
  for (const one of [schema.items, ...(schema.anyOf ?? [])]) {
    const found = entityIn(one, schemas, seen);
    if (found !== undefined) return found;
  }
  for (const one of Object.values(schema.properties ?? {})) {
    const found = entityIn(one, schemas, seen);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * The model a request to `path` answers, by the name of its contract in the document: the
 * entity the operation says it belongs to, else the one its answer holds.
 *
 *     modelAt(published, "/v1/projects/p1", "get")   // "Project"
 */
export function modelAt(
  published: DiscoveryDocument,
  path: string,
  method: string,
): string | undefined {
  const schemas = published.components?.schemas ?? {};
  for (const [template, item] of Object.entries(published.paths ?? {})) {
    if (!answers(template, path)) continue;
    const operation = item[method.toLowerCase()];
    if (operation === undefined) continue;
    const declared = operation["x-sincpro-entities"]?.[0];
    if (declared !== undefined && schemas[declared] !== undefined) return declared;
    const answered = operation.responses?.["200"]?.content?.["application/json"]?.schema;
    return entityIn(answered, schemas);
  }
  return undefined;
}

/** The definition of the model named `name`, read from its contract, and its version. */
export function definitionOf(
  published: DiscoveryDocument,
  name: string,
): { meta: Meta; version: string | null } | undefined {
  const schemas = (published.components?.schemas ?? {}) as Readonly<Record<string, Contract>>;
  const contract = schemas[name];
  if (contract?.["x-sincpro"] === undefined) return undefined;
  return { meta: metaFromContract(contract, schemas), version: versionOf(contract) };
}
