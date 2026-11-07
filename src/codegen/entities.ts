import { entityKeyOf } from "@sincpro/client-framework/client/contract";
import type { Metamodel, Operation } from "@sincpro/client-framework/codegen/metamodel";
import {
  aliasOf,
  answerOf,
  claimed,
  DOMAIN_MODULE,
  FRAMEWORK,
  headerOf,
  identifierOf,
  isEntity,
  localOf,
  methodOf,
  pluralOf,
  sorted,
} from "@sincpro/client-framework/codegen/names";
import {
  type GenerateOptions,
  ownerOf,
  type Reached,
  restOf,
  WRITES,
} from "@sincpro/client-framework/codegen/rest";

/**
 * The entities of a bounded context as TypeScript: one `entity<T, C>()` per model a client can
 * list, its routes and its Commands read off the contract — what a screen used to declare by
 * hand, and what drifted from the server when it did.
 *
 * Context: each route comes from what the operation IS for its entity (`role`), never from its
 * path. A role with more than one operation for an entity takes the one the server marks
 * `own`; with none marked, the generator chooses nothing and says so — a guess here would send a
 * screen to the wrong list. A Command runs on the entity whose record its body names
 * (`targets`): that field is the route's `target`, filled with the record's id when sent, so the
 * screen writes `run(id, { message })` and never the key twice.
 */

type Chosen<T> = { found: T } | { missing: string };

/** The one operation of `role` for `entity` a transport can call, by `own` when there are many. */
function oneOf(
  candidates: readonly { local: string; operation: Operation; rest: Reached }[],
  role: string,
): Chosen<{ local: string; operation: Operation; rest: Reached }> | undefined {
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return { found: candidates[0]! };
  const own = candidates.filter((one) => one.operation.own === true);
  if (own.length === 1) return { found: own[0]! };
  const names = candidates.map((one) => `\`${one.local}\``).join(", ");
  return { missing: `${candidates.length} of role \`${role}\` (${names}) and none \`own\`` };
}

/** A route for `entity()`: the record's field in the path written `{id}`, as `entity()` fills it. */
function recordPath(rest: Reached, field: string | undefined): string {
  return field === undefined || field === "id"
    ? rest.path
    : rest.path.replace(`{${field}}`, "{id}");
}

/**
 * The field of a Command's body that names the one record of `model` it runs on. A list of keys
 * (`list[EntityID[Issue]]`, `issue_ids`) names many: `run(id, body)` has one id to give, so the
 * screen sends that list in the body itself.
 */
function singleTarget(operation: Operation, model: string): string | undefined {
  const field = operation.targets[model];
  if (field === undefined) return undefined;
  const schema = operation.input.properties?.[field];
  const held = schema?.anyOf?.find((one) => one.type !== "null") ?? schema;
  return held?.type === "array" ? undefined : field;
}

type Declared = { name: string; source: string; missing: string[] };

function entitySourceOf(
  metamodel: Metamodel,
  model: string,
  domain: string,
  options: GenerateOptions,
  claim: (name: string, by: string) => void,
): Declared | { missing: string } {
  const reached = sorted(metamodel.operations).flatMap(([identity, operation]) => {
    const rest = restOf(metamodel, identity, options);
    return rest === undefined
      ? []
      : [
          {
            local: localOf(metamodel, identity),
            answer: answerOf(metamodel, identity),
            operation,
            rest,
          },
        ];
  });
  const reads = (role: string, method: (verb: string) => boolean) =>
    reached.filter(
      (one) =>
        one.operation.role === role &&
        method(one.rest.method) &&
        ownerOf(metamodel, one.operation) === model,
    );
  const isGet = (verb: string) => verb === "GET";
  const isWrite = (verb: string) => WRITES.has(verb);

  const list = oneOf(reads("search", isGet), "search");
  if (list === undefined) return { missing: "no `search` a transport reads" };
  if ("missing" in list) return { missing: list.missing };
  // A list under a record (`/tenants/{tenant_id}/members`) keeps its keys: the screen gives
  // them as the list's parameters (`useListing(entity, { params })`), and `listRoute` fills them.

  const missing: string[] = [];
  const routes: string[] = [`  list: ${JSON.stringify(list.found.rest.path)},`];
  const one = oneOf(reads("get", isGet), "get");
  const edit = oneOf(reads("edit", isWrite), "edit");
  if (one !== undefined && "found" in one) {
    const field = one.found.operation.targets[model];
    // sincpro_framework's `Get` answers the caller's own draft only when asked (`draft`), and an
    // entity edited through `Edit` keeps its drafts there: its record is read with them, or a
    // draft kept on one visit never comes back on the next.
    const drafts =
      edit !== undefined &&
      "found" in edit &&
      one.found.operation.input.properties?.["draft"]?.type === "boolean";
    const path = `${recordPath(one.found.rest, field)}${drafts ? "?draft=true" : ""}`;
    if (field !== undefined && one.found.rest.fields.length === 1)
      routes.push(`  one: ${JSON.stringify(path)},`);
    else missing.push(`one: \`${one.found.local}\` is at ${one.found.rest.path}`);
  } else if (one !== undefined) missing.push(`one: ${one.missing}`);
  for (const role of ["edit", "preview"]) {
    const write = oneOf(reads(role, isWrite), role);
    if (write === undefined) continue;
    if ("missing" in write) {
      missing.push(`${role}: ${write.missing}`);
      continue;
    }
    const field = write.found.operation.targets[model];
    const route = `${write.found.rest.method} ${recordPath(write.found.rest, field)}`;
    routes.push(`  ${role}: ${JSON.stringify(route)},`);
  }

  const exported = oneOf(reads("export", isGet), "export");
  if (exported !== undefined) {
    if ("missing" in exported) missing.push(`export: ${exported.missing}`);
    else routes.push(`  export: ${JSON.stringify(exported.found.rest.path)},`);
  }

  const commands = reached.filter(
    (one) =>
      one.operation.role === "command" &&
      isWrite(one.rest.method) &&
      one.operation.entities.includes(model),
  );
  const bodies: string[] = [];
  const answers: string[] = [];
  const named: string[] = [];
  for (const command of commands) {
    const method = methodOf(command.local);
    const target = singleTarget(command.operation, model);
    const route = `${command.rest.method} ${command.rest.path}`;
    bodies.push(
      target === undefined
        ? `    ${method}: dto.${command.local};`
        : `    ${method}: Omit<dto.${command.local}, ${JSON.stringify(target)}>;`,
    );
    answers.push(`    ${method}: dto.${command.answer};`);
    named.push(
      target === undefined
        ? `    ${method}: ${JSON.stringify(route)},`
        : `    ${method}: { route: ${JSON.stringify(route)}, target: ${JSON.stringify(target)} },`,
    );
  }
  if (named.length > 0) routes.push(`  commands: {\n${named.join("\n")}\n  },`);

  const name = pluralOf(identifierOf(model));
  claim(name, `the entity of ${model}`);
  const types =
    bodies.length === 0
      ? `dto.${identifierOf(model)}`
      : `\n  dto.${identifierOf(model)},\n  {\n${bodies.join("\n")}\n  },\n  {\n${answers.join("\n")}\n  }\n`;
  const doc = [
    "/**",
    ` * \`${model}\`: its list, its record and the Commands that run on it or create it.`,
    ...(missing.length === 0
      ? []
      : [" *", " * Not declared:", ...missing.map((one) => ` * - ${one}.`)]),
    " */",
  ].join("\n");
  const key = JSON.stringify(entityKeyOf(domain, model));
  return {
    name,
    missing,
    source: `${doc}\nexport const ${name} = entity<${types}>(${key}, {\n${routes.join("\n")}\n});`,
  };
}

/**
 * The TypeScript of the entities of `metamodel`, as the text of one file next to its `domain.ts`.
 *
 * 1. Per model, by name: the one `search` a transport reads for it (`own` when there are
 *    several) — none, and the model gets no entity, said in the file's own doc.
 * 2. Its `get`, `edit` and `preview` the same way, the record's field written `{id}`, and its
 *    `export` — every record of a criteria as a file — by its path.
 * 3. Every write of role `command` that concerns it: with `target` when its body names the
 *    record, as it is when it creates one; its body typed without that field.
 * Final: an `entity<T, C>()` per model listed, keyed `<domain>:<kind>`, and `entities`, all of
 *    them, for `FrameworkProvider entities`.
 */
export function entitiesFileOf(metamodel: Metamodel, options: GenerateOptions = {}): string {
  const domain = options.domain ?? aliasOf(metamodel);
  const claim = claimed();
  claim("entities", "the list of every entity");
  const declared: Declared[] = [];
  const left: string[] = [];
  // A value a record holds (no identity) is no entity: it is never listed nor opened alone.
  for (const [model] of sorted(metamodel.models).filter(([name]) =>
    isEntity(metamodel, name),
  )) {
    const one = entitySourceOf(metamodel, model, domain, options, claim);
    if ("source" in one) declared.push(one);
    else left.push(`\`${model}\`: ${one.missing}`);
  }
  const imports = [
    `import { entity } from "${FRAMEWORK}";`,
    "",
    `import type * as dto from "${DOMAIN_MODULE}";`,
  ].join("\n");
  const all = [
    "/**",
    ` * Every entity of «${aliasOf(metamodel)}», for \`FrameworkProvider entities\`.`,
    ...(left.length === 0
      ? []
      : [" *", " * Without an entity here:", ...left.map((one) => ` * - ${one}.`)]),
    " */",
    `export const entities = [${declared.map((one) => one.name).join(", ")}] as const;`,
  ].join("\n");
  return `${[headerOf("The entities", metamodel), imports, ...declared.map((one) => one.source), all].join("\n\n")}\n`;
}
