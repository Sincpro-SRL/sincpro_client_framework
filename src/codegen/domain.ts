import type {
  Metamodel,
  Operation,
  Schema,
} from "@sincpro/client-framework/codegen/metamodel";
import {
  answerOf,
  claimed,
  contextOf,
  deprecationOf,
  docOf,
  headerOf,
  identifierOf,
  keyOf,
  localOf,
  sorted,
} from "@sincpro/client-framework/codegen/names";

/**
 * The DTOs of a bounded context as TypeScript, out of the contract sincpro_framework exports:
 * a type per model, per shared definition a model or an operation reaches, and per operation's
 * input and answer. Only types — nothing in the file runs.
 *
 * Context: the file is a snapshot for whoever writes code — a person, or an agent reading the
 * repository —, never the truth at runtime: the transport keeps reading the live definition and
 * revalidates it by `model_version`. So it is written the same way for the same contract (every
 * key sorted, byte for byte, which is what `make verify-client` compares) and never edited; an
 * application extends a type by composition (`Wire & {…}`).
 *
 * criteria's grammar comes with every metamodel (`$defs.Criteria`); `@sincpro/criteria` already
 * types it, so it is imported, never written a second time.
 *
 *     domainFileOf(JSON.parse(readFileSync("project.contract.json", "utf8")))
 */

const MODELS = "#/models/";
const DEFINITIONS = "#/$defs/";
/** A shared definition a package of the stack already types: imported, never written again. */
const IMPORTED: Readonly<Record<string, { name: string; from: string }>> = {
  Criteria: { name: "Criteria", from: "@sincpro/criteria" },
  Download: { name: "Download", from: "@sincpro/client-framework" },
  EntityCollection: { name: "EntityCollection", from: "@sincpro/client-framework" },
};
/** A relation that holds several records: a reading answers it as a page of them. */
const TO_MANY = new Set(["one2many", "many2many"]);
/** The field types whose value is the record itself, not a key that names it. */
const RELATIONAL = new Set(["many2one", "one2many", "many2many", "embedded"]);
/** A related record: in an answer only when the read expands it. */
const EXPANDED = new Set(["many2one", "one2many", "many2many"]);
const SIMPLE_TYPE = /^[A-Za-z0-9_$.]+$/;

function union(members: readonly string[]): string {
  const distinct = [...new Set(members)];
  if (distinct.includes("unknown")) return "unknown";
  return distinct.join(" | ");
}

function arrayOf(item: string): string {
  return SIMPLE_TYPE.test(item) ? `${item}[]` : `Array<${item}>`;
}

/** Whose record a key names — `EntityID[Customer]` on the server —, said where it is written. */
function keyNote(schema: Schema): string | undefined {
  const said = schema["x-sincpro"];
  if (said?.relation == null || RELATIONAL.has(said.type ?? "")) return undefined;
  return `The key of a \`${said.relation}\`.`;
}

/** What a reference names, and the definitions and imports a rendering reaches. */
type Scope = {
  refer: (ref: string) => string;
  reached: Set<string>;
  imports: Set<string>;
  /** The models written in an operation's body, each typed as its `<Name>Input`. */
  inputs: Set<string>;
};

/**
 * What each reference of a rendering names. `input`: the rendering is what a caller SENDS — an
 * operation's input —, so a model there is its `<Name>Input`, whose fields follow the contract's
 * `required`, not the record a read answers whole.
 */
function scopeOf(metamodel: Metamodel, shared?: Scope, input = false): Scope {
  const definitions = metamodel.$defs ?? {};
  const scope: Scope = {
    reached: shared?.reached ?? new Set(),
    imports: shared?.imports ?? new Set(),
    inputs: shared?.inputs ?? new Set(),
    refer: (ref) => {
      const model = ref.startsWith(MODELS);
      if (!model && !ref.startsWith(DEFINITIONS))
        throw new Error(`"${ref}" points outside the metamodel of ${contextOf(metamodel)}`);
      const name = ref.slice(model ? MODELS.length : DEFINITIONS.length);
      // A model's own contract names a related model as a definition (`#/$defs/Run`).
      if (model || name in metamodel.models) {
        if (!(name in metamodel.models))
          throw new Error(`"${ref}" names no model of ${contextOf(metamodel)}`);
        if (!input) return identifierOf(name);
        scope.inputs.add(name);
        return `${identifierOf(name)}Input`;
      }
      const imported = IMPORTED[name];
      if (imported !== undefined) {
        scope.imports.add(name);
        return imported.name;
      }
      if (!(name in definitions))
        throw new Error(`"${ref}" names no definition of ${contextOf(metamodel)}`);
      scope.reached.add(name);
      return identifierOf(name);
    },
  };
  return scope;
}

/**
 * Whether a property may be absent. In a record a model describes, every field comes but a
 * related record, which comes only when the read expands it: the server writes the whole record,
 * and its contract lists as required only what has no default (most fields have one). Anywhere
 * else — an operation's input or answer, a shared definition — `required` says it.
 */
function optional(name: string, property: Schema, schema: Schema, record: boolean): boolean {
  if (record) return EXPANDED.has(property["x-sincpro"]?.type ?? "");
  return !(schema.required ?? []).includes(name);
}

/**
 * The records a to-many holds, when `property` is one — however the contract writes it: the
 * collection a reading answers (`{items, count, cursor}`, sincpro_framework 3.33 on) or, before
 * that, a bare array, which said less than the wire sent.
 */
function heldRecords(property: Schema): Schema | undefined {
  if (!TO_MANY.has(property["x-sincpro"]?.type ?? "")) return undefined;
  const held = property.properties?.["items"] ?? property;
  return held.type === "array" ? held.items : undefined;
}

/**
 * A property's TypeScript. A to-many inside a record is an `EntityCollection` of its records —
 * a page with its count and cursor, as the read answers it — never an array, which would say the
 * page is all there is.
 */
function propertyTypeOf(
  property: Schema,
  scope: Scope,
  depth: number,
  record: boolean,
): string {
  const records = record ? heldRecords(property) : undefined;
  if (records === undefined) return typeOf(property, scope, depth, record);
  scope.imports.add("EntityCollection");
  return `EntityCollection<${typeOf(records, scope, depth, record)}>`;
}

function objectOf(schema: Schema, scope: Scope, depth: number, record: boolean): string {
  const properties = sorted(schema.properties ?? {});
  if (properties.length === 0) {
    const extra = schema.additionalProperties;
    if (extra === false) return "Record<string, never>";
    const value =
      extra === undefined || extra === true ? "unknown" : typeOf(extra, scope, depth, record);
    return `Record<string, ${value}>`;
  }
  const pad = "  ".repeat(depth + 1);
  const lines = properties.map(([name, property]) => {
    const doc = docOf([property.description, keyNote(property)], pad);
    const mark = optional(name, property, schema, record) ? "?" : "";
    return `${doc}${pad}${keyOf(name)}${mark}: ${propertyTypeOf(property, scope, depth + 1, record)};`;
  });
  return `{\n${lines.join("\n")}\n${"  ".repeat(depth)}}`;
}

/** The TypeScript of `schema`; `record` when it is (inside) a record a model describes. */
function typeOf(schema: Schema, scope: Scope, depth: number, record: boolean): string {
  if (schema.$ref !== undefined) return scope.refer(schema.$ref);
  const options = schema.anyOf ?? schema.oneOf;
  if (options !== undefined)
    return union(options.map((one) => typeOf(one, scope, depth, record)));
  if ("const" in schema) return JSON.stringify(schema.const);
  if (schema.enum !== undefined) return union(schema.enum.map((one) => JSON.stringify(one)));
  const types = typeof schema.type === "string" ? [schema.type] : (schema.type ?? []);
  if (types.length > 1)
    return union(types.map((one) => typeOf({ ...schema, type: one }, scope, depth, record)));
  switch (types[0]) {
    case "string":
      return "string";
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array":
      return arrayOf(
        schema.items === undefined ? "unknown" : typeOf(schema.items, scope, depth, record),
      );
    case "object":
      return objectOf(schema, scope, depth, record);
    default:
      return schema.properties === undefined
        ? "unknown"
        : objectOf(schema, scope, depth, record);
  }
}

/** What a streamed answer is on the client — an export's bytes (`Download`) —, else nothing. */
function streamed(output: Schema, scope: Scope): string | undefined {
  if ((output as Record<string, unknown>)["x-sincpro-streamed"] === undefined)
    return undefined;
  scope.imports.add("Download");
  return "Download";
}

/** What the server says of an operation: its words, then what it is, for whom, on which field. */
function operationDoc(metamodel: Metamodel, local: string, operation: Operation): string {
  const runsOn = sorted(operation.targets).map(
    ([entity, field]) => `\`${entity}\` in \`${field}\``,
  );
  const whose = operation.entities.map((one) => `\`${one}\``).join(", ");
  const facts = [
    `\`${operation.role}\`${whose === "" ? "" : ` of ${whose}`}`,
    operation.query ? "reads only" : undefined,
    operation.dry_run ? "may run dry" : undefined,
    runsOn.length === 0 ? undefined : `its record: ${runsOn.join(", ")}`,
  ].filter((one): one is string => one !== undefined);
  return (
    docOf(
      [operation.description, `${facts.join(" · ")}.`, deprecationOf(metamodel, operation)],
      "",
    ) || `/** ${local} */\n`
  );
}

/**
 * The TypeScript of every DTO of `metamodel`, as the text of one file.
 *
 * 1. The models, by name: an entity's contract, a related model by its own name.
 * 2. Each operation, by its local name (its identity without `<context>.`): its input as
 *    `<Name>` and its answer by the backend's own name for it (`answerOf`: `ResponseX`) — or as
 *    `<Name>Answer` when it has no name.
 * 3. A model an input carries — and the ones it carries, until none is new — as `<Name>Input`:
 *    what a caller sends follows the contract's `required`; the server fills the rest.
 * 4. The shared definitions those reach — and the ones those reach, until none is new —, but
 *    never one a package of the stack already types (`Criteria`).
 * Final: a header that says where it came from and not to edit it, the imports, then models,
 *    definitions and operations, each sorted by name; two of them with one TypeScript name are
 *    refused, naming both.
 */
export function domainFileOf(metamodel: Metamodel): string {
  const scope = scopeOf(metamodel);
  const sent = scopeOf(metamodel, scope, true);
  const definitions = metamodel.$defs ?? {};
  const claim = claimed();

  const models = sorted(metamodel.models).map(([name, schema]) => {
    claim(identifierOf(name), `model ${name}`);
    return `${docOf([schema.description], "")}export type ${identifierOf(name)} = ${typeOf(schema, scope, 0, true)};`;
  });

  // A Response two Commands share is written once, under the first that answers with it.
  const answered = new Set<string>();
  const operations = sorted(metamodel.operations).flatMap(([identity, operation]) => {
    const local = localOf(metamodel, identity);
    const named = answerOf(metamodel, identity);
    claim(local, `operation ${identity}`);
    const answer =
      operation.output === null
        ? "unknown"
        : (streamed(operation.output, scope) ?? typeOf(operation.output, scope, 0, false));
    const written = [
      `${operationDoc(metamodel, local, operation)}export type ${local} = ${typeOf(operation.input, sent, 0, false)};`,
    ];
    if (!answered.has(named)) {
      answered.add(named);
      claim(named, `the answer of ${identity}`);
      written.push(`/** What \`${local}\` answers. */\nexport type ${named} = ${answer};`);
    }
    return written;
  });

  const inputs = new Map<string, string>();
  for (let pending = [...scope.inputs]; pending.length > 0;) {
    for (const name of pending) {
      const schema = metamodel.models[name]!;
      inputs.set(
        name,
        `${docOf([`What a caller sends of a \`${name}\`: what the contract requires; the server fills the rest.`], "")}export type ${identifierOf(name)}Input = ${typeOf(schema, sent, 0, false)};`,
      );
    }
    pending = [...scope.inputs].filter((name) => !inputs.has(name));
  }
  const sentModels = [...inputs.keys()].sort().map((name) => {
    claim(`${identifierOf(name)}Input`, `what a caller sends of model ${name}`);
    return inputs.get(name)!;
  });

  const written = new Map<string, string>();
  for (let pending = [...scope.reached]; pending.length > 0;) {
    for (const name of pending) {
      const schema = definitions[name]!;
      written.set(
        name,
        `${docOf([schema.description], "")}export type ${identifierOf(name)} = ${typeOf(schema, scope, 0, false)};`,
      );
    }
    pending = [...scope.reached].filter((name) => !written.has(name));
  }
  const shared = [...written.keys()].sort().map((name) => {
    claim(identifierOf(name), `definition ${name}`);
    return written.get(name)!;
  });

  // One line per package, its names sorted.
  const byPackage = new Map<string, string[]>();
  for (const name of [...scope.imports].sort()) {
    const imported = IMPORTED[name]!;
    byPackage.set(imported.from, [...(byPackage.get(imported.from) ?? []), imported.name]);
  }
  const imports = [...byPackage.keys()]
    .sort()
    .map((from) => `import type { ${byPackage.get(from)!.join(", ")} } from "${from}";`);

  return `${[headerOf("The DTOs", metamodel), ...(imports.length === 0 ? [] : [imports.join("\n")]), ...models, ...sentModels, ...shared, ...operations].join("\n\n")}\n`;
}
