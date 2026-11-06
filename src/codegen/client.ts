import type { Metamodel, Operation } from "@sincpro/client-framework/codegen/metamodel";
import {
  aliasOf,
  claimed,
  deprecationOf,
  docOf,
  DOMAIN_MODULE,
  FRAMEWORK,
  headerOf,
  identifierOf,
  localOf,
  methodOf,
  recordLiteral,
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
 * The client of a bounded context as TypeScript: every operation as data, and a method for each
 * one REST reaches the way a `Transport` sends — over `@sincpro/client-framework`, so a script,
 * a test or a hook of its own calls the service typed, with no screen.
 *
 * Context: a method only writes down the route the contract published and hands the call to the
 * transport, which keeps the rules — the `Idempotency-Key`, the `Problem`, the model's version.
 * A GET is a page (`list`), one record (`one`), or — a Query of the context's own, `GET /me` —
 * a read of its answer as it came (`readRoute`, over a transport that has `read`). A GET's
 * keys in its path are required parameters; every other field is an optional one.
 */

/** A search's fields a page asks with, not the screen: the criteria, and its cursor inside it. */
const PAGED = new Set(["criteria", "cursor"]);

/** What a GET is asked with: the keys its path names, and every other field, as text. */
type Asked = { path: readonly string[]; query: readonly string[] };

/** How an operation is called through a transport, or why it is not. */
type Call =
  | ({ kind: "list"; entity: string } & Asked)
  | { kind: "one"; entity: string; field: string }
  | ({ kind: "read" } & Asked)
  | { kind: "send" }
  | { kind: "none"; why: string };

/** A GET's parameters: the path's keys, and the rest of its input but what a page asks with. */
function askedOf(operation: Operation, rest: Reached, paged: boolean): Asked {
  const path = [...rest.fields].sort();
  const query = Object.keys(operation.input.properties ?? {})
    .filter((one) => !path.includes(one) && !(paged && PAGED.has(one)))
    .sort();
  return { path, query };
}

function callOf(metamodel: Metamodel, operation: Operation, rest: Reached | undefined): Call {
  if (rest === undefined) return { kind: "none", why: "REST does not publish it" };
  if (WRITES.has(rest.method)) return { kind: "send" };
  const owner = ownerOf(metamodel, operation);
  if (operation.role === "search" && owner !== undefined && owner in metamodel.models)
    return { kind: "list", entity: owner, ...askedOf(operation, rest, true) };
  const field = owner === undefined ? undefined : operation.targets[owner];
  const record = rest.fields.length === 1 && rest.fields[0] === field;
  if (operation.role === "get" && owner !== undefined && field !== undefined && record)
    return { kind: "one", entity: owner, field };
  // Any other GET — a Query of the context's own, `GET /me` — is read as it answers.
  return { kind: "read", ...askedOf(operation, rest, false) };
}

/** A parameter list's TypeScript: the path's keys required, the rest optional, all as text. */
function paramsOf(asked: Asked): { signature: string; route: (path: string) => string } {
  const union = (names: readonly string[]) =>
    names.map((one) => JSON.stringify(one)).join(" | ");
  if (asked.path.length === 0 && asked.query.length === 0)
    return { signature: "", route: (path) => JSON.stringify(path) };
  const required =
    asked.path.length === 0 ? "" : `Readonly<Record<${union(asked.path)}, string>>`;
  const optional =
    asked.query.length === 0 ? "" : `Partial<Record<${union(asked.query)}, string>>`;
  const type = [required, optional].filter((one) => one !== "").join(" & ");
  return {
    signature: `params${asked.path.length === 0 ? "?" : ""}: ${type}`,
    route: (path) => `listRoute(${JSON.stringify(path)}, params)`,
  };
}

/** The data of one operation: what it is, and how each wire reaches it. */
function dataOf(
  metamodel: Metamodel,
  identity: string,
  operation: Operation,
  rest: Reached | undefined,
): string {
  const lines = [
    `    identity: ${JSON.stringify(identity)},`,
    `    role: ${JSON.stringify(operation.role)},`,
    `    query: ${operation.query},`,
    `    entities: ${JSON.stringify(operation.entities)},`,
    `    targets: ${recordLiteral(operation.targets)},`,
  ];
  if (rest !== undefined)
    lines.push(
      `    rest: { method: ${JSON.stringify(rest.method)}, path: ${JSON.stringify(rest.path)} },`,
    );
  const rpc = metamodel.bindings?.rpc?.[identity];
  if (rpc !== undefined) lines.push(`    rpc: { method: ${JSON.stringify(rpc.method)} },`);
  const grpc = metamodel.bindings?.grpc?.[identity];
  if (grpc !== undefined) lines.push(`    grpc: { method: ${JSON.stringify(grpc.method)} },`);
  const mcp = metamodel.bindings?.mcp?.[identity];
  if (mcp !== undefined) lines.push(`    mcp: { tool: ${JSON.stringify(mcp.tool)} },`);
  return `  ${localOf(metamodel, identity)}: {\n${lines.join("\n")}\n  },`;
}

function methodSourceOf(
  local: string,
  method: string,
  call: Call,
  rest: Reached,
  doc: string,
): string {
  if (call.kind === "list") {
    const entity = `dto.${identifierOf(call.entity)}`;
    const params = paramsOf(call);
    const signature = params.signature === "" ? "" : `, ${params.signature}`;
    return `${doc}    ${method}: (criteria: Criteria<${entity}>${signature}) =>\n      transport.list<${entity}>(${params.route(rest.path)}, criteria),`;
  }
  if (call.kind === "read") {
    const params = paramsOf(call);
    return `${doc}    ${method}: (${params.signature}) =>\n      readRoute<dto.${local}Answer>(transport, ${params.route(rest.path)}),`;
  }
  if (call.kind === "one") {
    const path = rest.path.replace(`{${call.field}}`, "${encodeURIComponent(id)}");
    return `${doc}    ${method}: (id: string) =>\n      transport.one<dto.${identifierOf(call.entity)}>(\`${path}\`),`;
  }
  const id = rest.fields.includes("id")
    ? "body.id === undefined ? undefined : String(body.id)"
    : "undefined";
  return [
    `${doc}    ${method}: (body: dto.${local}, options?: SendOptions) =>`,
    `      transport.send<dto.${local}Answer>(`,
    `        ${JSON.stringify(rest.method)},`,
    `        pathFor(routes.${method}, ${id}, body),`,
    `        body,`,
    `        undefined,`,
    `        options,`,
    `      ),`,
  ].join("\n");
}

/**
 * The TypeScript of the client of `metamodel`, as the text of one file next to its `domain.ts`.
 *
 * 1. Every operation, by its local name, as data: identity, role, `query`, entities, targets
 *    and the binding of each wire that publishes it.
 * 2. Per operation REST reaches, how a transport calls it (`callOf`): a page, a record, a write
 *    — or none, said in the client's own doc.
 * 3. The routes of the writes, read once (`writeRoute`).
 * Final: `clientOf(transport)`, a method per operation reached, named by `methodOf`; two with
 *    one name are refused, naming both.
 */
export function clientFileOf(metamodel: Metamodel, options: GenerateOptions = {}): string {
  const claim = claimed();
  const operations = sorted(metamodel.operations);
  const data: string[] = [];
  const routes: string[] = [];
  const methods: string[] = [];
  const unreached: string[] = [];
  let lists = false;
  let paged = false;
  let reads = false;
  let sends = false;

  for (const [identity, operation] of operations) {
    const local = localOf(metamodel, identity);
    const rest = restOf(metamodel, identity, options);
    data.push(dataOf(metamodel, identity, operation, rest));
    const call = callOf(metamodel, operation, rest);
    if (call.kind === "none" || rest === undefined) {
      unreached.push(`\`${local}\`: ${call.kind === "none" ? call.why : ""}.`);
      continue;
    }
    const method = methodOf(local);
    claim(method, `operation ${identity}`);
    const doc = docOf([operation.description, deprecationOf(metamodel, operation)], "    ");
    methods.push(methodSourceOf(local, method, call, rest, doc));
    if (call.kind === "list" || call.kind === "read") {
      paged ||= call.kind === "list";
      reads ||= call.kind === "read";
      lists ||= call.path.length + call.query.length > 0;
    }
    if (call.kind === "send") {
      sends = true;
      routes.push(
        `  ${method}: writeRoute(${JSON.stringify(`${rest.method} ${rest.path}`)}),`,
      );
    }
  }

  const core = [
    "bindable",
    ...(lists ? ["listRoute"] : []),
    ...(sends ? ["pathFor"] : []),
    ...(reads ? ["readRoute"] : []),
    ...(sends ? ["type SendOptions"] : []),
    "type Transport",
    ...(sends ? ["writeRoute"] : []),
  ];
  const imports = [
    ...(paged ? ['import type { Criteria } from "@sincpro/criteria";'] : []),
    `import { ${core.join(", ")} } from "${FRAMEWORK}";`,
    "",
    `import type * as dto from "${DOMAIN_MODULE}";`,
  ].join("\n");
  const client = [
    "/**",
    ` * «${aliasOf(metamodel)}» over a transport: a method for each operation REST reaches as a`,
    " * page, a record, a read of its own or a write. Used by a Feature, each request carries the",
    " * trace and the context of the use case that sent it (`bindable`).",
    ...(unreached.length === 0
      ? []
      : [" *", " * Without a method here:", ...unreached.map((one) => ` * - ${one}`)]),
    " */",
  ].join("\n");

  return `${[
    headerOf("The client", metamodel),
    imports,
    `/** Every operation of «${aliasOf(metamodel)}», as data: what it is, and how each wire reaches it. */\nexport const operations = {\n${data.join("\n")}\n} as const;`,
    ...(routes.length === 0 ? [] : [`const routes = {\n${routes.join("\n")}\n};`]),
    `${client}\nexport function clientOf(transport: Transport) {\n  return bindable(transport, (transport) => ({\n${methods.join("\n")}\n  }));\n}`,
  ].join("\n\n")}\n`;
}
