import type { Metamodel } from "@sincpro/client-framework/codegen/domain/metamodel";
import {
  aliasOf,
  FRAMEWORK,
  GENERATED_ADAPTERS,
  GENERATED_DOMAIN,
} from "@sincpro/client-framework/codegen/domain/names";

/**
 * A bounded context's skeleton, written ONCE beside what is generated — the files that are the
 * application's from then on, laid out as the backend's (`sincpro_mcp_odoo/domains/helpdesk`):
 *
 *     domains/project/
 *       domain/generated/                  `sincpro-client generate` — regenerated, never edited:
 *       adapters/generated/                its types, and its client and entities
 *       infrastructure/dependencies.ts     what its services count on, and who supplies it
 *       infrastructure/framework.ts        its Feature and ApplicationService — every dependency
 *                                          typed on `this` — and `projectBoundedContext`
 *       services/index.ts                  imports each service, which registers itself
 *       index.ts                           `projectBoundedContext`, ready to use
 *
 * Context: `dependencies.py`, `framework.py`, `services/` and `__init__.py` — a bounded context
 * starts the way every other does. The instance lives in `framework.ts`, not `index.ts`: a service
 * imports it to register itself (`@projectBoundedContext.feature(Command)`), and ES modules run
 * their imports first, so `index.ts` importing the services could not also define it. It is the
 * application's to change: the CLI writes a file only when it is not there, and never touches one
 * that is — unlike the `generated/` folders, which are written whole every time.
 */
export type ScaffoldOptions = {
  /**
   * Where the application exports how it reaches its services (`export const operations`, an
   * `OperationTransport`: REST, JSON-RPC, a platform's), from the bounded context's folder.
   * `../common/infrastructure/operations` by default.
   */
  operations?: string;
};

/** `sales-orders` → `SalesOrders`. */
function pascalOf(alias: string): string {
  const joined = alias
    .split(/[^A-Za-z0-9]+/)
    .filter((one) => one !== "")
    .map((one) => `${one.charAt(0).toUpperCase()}${one.slice(1)}`)
    .join("");
  return joined === "" ? "Context" : /^[0-9]/.test(joined) ? `_${joined}` : joined;
}

/** A module the skeleton imports, built in parts — see `FRAMEWORK` (`codegen/names.ts`). */
const at = (...parts: string[]) => parts.join("/");

/** A path given from the bounded context's folder, as `infrastructure/` reaches it. */
function fromInfrastructure(path: string): string {
  return path.startsWith(".") ? at("..", path) : path;
}

const HEADER = (what: string) =>
  `// ${what} — written once by \`sincpro-client scaffold\`; the application's to change.`;

export function scaffoldFilesOf(
  metamodel: Metamodel,
  options: ScaffoldOptions = {},
): Record<string, string> {
  const alias = aliasOf(metamodel);
  const Name = pascalOf(alias);
  // Named for what it is — `projectBoundedContext`, never `project` (an entity?) or `ctx` —:
  // nobody misreads it, and no word of the language or name `index.ts` imports can take it.
  const name = `${Name.charAt(0).toLowerCase()}${Name.slice(1)}BoundedContext`;
  const Dependencies = `${Name}Dependencies`;
  const client = metamodel.bindings !== undefined;
  const operations = options.operations ?? at("..", "common", "infrastructure", "operations");

  const dependencies = [
    HEADER(`What the services of «${alias}» can count on`),
    "",
    `import type { OperationTransport } from "${FRAMEWORK}";`,
    `import type { BoundedContext } from "${at(FRAMEWORK, "core")}";`,
    ...(client
      ? ["", `import { clientOf } from "${at("..", GENERATED_ADAPTERS, "client")}";`]
      : []),
    "",
    `/** What every service of «${alias}» finds on \`this\`${client ? ": `this.client`, the service's operations" : ""}. */`,
    `export interface ${Dependencies} {`,
    ...(client
      ? ["  client: ReturnType<typeof clientOf>;"]
      : [
          "  /** What the services need: a repository, an adapter, another bounded context. */",
        ]),
    "}",
    "",
    "export function registerDependencies(",
    `  boundedContext: BoundedContext<${Dependencies}>,`,
    `  ${client ? "operations" : "_operations"}: OperationTransport,`,
    ") {",
    ...(client ? [`  boundedContext.addDependency("client", clientOf(operations));`] : []),
    "  return boundedContext;",
    "}",
    "",
  ].join("\n");

  const framework = [
    HEADER(`How «${alias}» is made`),
    "",
    `import { type OperationTransport } from "${FRAMEWORK}";`,
    `import { BoundedContext, servicesWith } from "${at(FRAMEWORK, "core")}";`,
    "",
    `import { operations } from "${fromInfrastructure(operations)}";`,
    `import { type ${Dependencies}, registerDependencies } from "${at(".", "dependencies")}";`,
    "",
    `/** The Feature and ApplicationService of «${alias}»: every dependency typed on \`this\`, declared nowhere else. */`,
    `export const { Feature, ApplicationService } = servicesWith<${Dependencies}>();`,
    "",
    `export function config${Name}BoundedContext(name: string, transport: OperationTransport) {`,
    `  return registerDependencies(new BoundedContext<${Dependencies}>(name), transport);`,
    "}",
    "",
    `/** «${alias}»: \`${name}.execute(new Command(...))\`; a service registers itself with \`@${name}.feature(Command)\`. */`,
    `export const ${name} = config${Name}BoundedContext(${JSON.stringify(alias)}, operations);`,
    "",
  ].join("\n");

  const services = [
    HEADER(`What «${alias}» offers`),
    "",
    "// One file per use case, in its aggregate's folder (`services/<aggregate>/`, a related entity",
    "// with use cases of its own in a folder inside it). Each registers itself with",
    `// \`@${name}.feature(CommandX)\` — or a list: \`@${name}.feature([CommandX, EventY])\` — and is`,
    "// imported here, so it is registered before anyone executes. A generated DTO is a remote",
    `// contract (a type): \`import type * as remote from "${at("..", GENERATED_DOMAIN)}"\`.`,
    "export {};",
    "",
  ].join("\n");

  const index = [
    HEADER(`«${alias}», ready to use`),
    "",
    `import "${at(".", "services")}";`,
    "",
    `export { ApplicationService, Feature, ${name} } from "${at(".", "infrastructure", "framework")}";`,
    "",
  ].join("\n");

  return {
    "infrastructure/dependencies.ts": dependencies,
    "infrastructure/framework.ts": framework,
    "services/index.ts": services,
    "index.ts": index,
  };
}
