import type { Metamodel } from "@sincpro/client-framework/codegen/metamodel";
import { aliasOf, FRAMEWORK } from "@sincpro/client-framework/codegen/names";

/**
 * A bounded context's skeleton, written ONCE beside what is generated — the files that are the
 * application's from then on:
 *
 *     domains/project/
 *       generated/                         `sincpro-client generate` — regenerated, never edited
 *       infrastructure/dependencies.ts     what the services can count on: the generated client
 *       infrastructure/bounded_context.ts  its Feature and ApplicationService, and how it is made
 *       services/index.ts                  registers command classes and their services
 *       index.ts                           `export const project` — ready to use
 *
 * Context: the layout sincpro_framework gives a service (`dependencies.py`, `framework.py`,
 * `services/`, `__init__.py`), so a bounded context starts the way every other does and nobody
 * copies it by hand from another. It is the application's to change: the CLI writes a file only
 * when it is not there, and never touches one that is — unlike `generated/`, which is written
 * whole every time.
 */
export type ScaffoldOptions = {
  /** Where the application's transport is exported (`export const transport`), from the
   *  bounded context's folder. `../common/infrastructure/transport` by default. */
  transport?: string;
};

/** Names the skeleton's `index.ts` cannot give its constant. */
const TAKEN = new Set([
  "transport",
  "registerServices",
  ..."break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with yield let static implements interface package private protected public await".split(
    " ",
  ),
]);

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

const HEADER = (what: string) =>
  `// ${what} — written once by \`sincpro-client scaffold\`; the application's to change.`;

export function scaffoldFilesOf(
  metamodel: Metamodel,
  options: ScaffoldOptions = {},
): Record<string, string> {
  const alias = aliasOf(metamodel);
  const Name = pascalOf(alias);
  const bare = `${Name.charAt(0).toLowerCase()}${Name.slice(1)}`;
  // A word the language keeps (`import`, `default`) or a name `index.ts` already imports cannot
  // be the constant's: it takes the bounded context's word instead.
  const name = TAKEN.has(bare) ? `${bare}BoundedContext` : bare;
  const Dependencies = `${Name}Dependencies`;
  const client = metamodel.bindings !== undefined;
  const transport = options.transport ?? at("..", "common", "infrastructure", "transport");

  const dependencies = [
    HEADER(`What the services of «${alias}» can count on`),
    "",
    `import type { Transport } from "${FRAMEWORK}";`,
    `import type { BoundedContext } from "${at(FRAMEWORK, "core")}";`,
    ...(client ? ["", `import { clientOf } from "${at("..", "generated", "client")}";`] : []),
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
    `  bc: BoundedContext<${Dependencies}>,`,
    `  ${client ? "transport" : "_transport"}: Transport,`,
    ") {",
    ...(client ? [`  bc.addDependency("client", clientOf(transport));`] : []),
    "  return bc;",
    "}",
    "",
  ].join("\n");

  const boundedContext = [
    HEADER(`How «${alias}» is made`),
    "",
    "import {",
    "  ApplicationService as BaseApplicationService,",
    "  Feature as BaseFeature,",
    "  BoundedContext,",
    "  type Command,",
    `} from "${at(FRAMEWORK, "core")}";`,
    `import type { Transport } from "${FRAMEWORK}";`,
    "",
    `import { type ${Dependencies}, registerDependencies } from "${at(".", "dependencies")}";`,
    "",
    `/** A Feature of «${alias}»: its dependencies typed on \`this\`, and \`this.context\`. */`,
    "export abstract class Feature<C extends Command<R>, R> extends BaseFeature<C, R> {",
    ...(client ? [`  declare readonly client: ${Dependencies}["client"];`] : []),
    "}",
    "",
    `/** An ApplicationService of «${alias}»: the same, and \`this.featureBus.execute(dto)\`. */`,
    "export abstract class ApplicationService<C extends Command<R>, R> extends BaseApplicationService<C, R> {",
    ...(client ? [`  declare readonly client: ${Dependencies}["client"];`] : []),
    "}",
    "",
    `export function config${Name}BoundedContext(name: string, transport: Transport) {`,
    `  return registerDependencies(new BoundedContext<${Dependencies}>(name), transport);`,
    "}",
    "",
  ].join("\n");

  const services = [
    HEADER(`What «${alias}» offers`),
    "",
    `import type { BoundedContext } from "${at(FRAMEWORK, "core")}";`,
    `import type { ${Dependencies} } from "${at("..", "infrastructure", "dependencies")}";`,
    "",
    "/** Register local Command classes with their Features and ApplicationServices.",
    " * Generated DTO types are remote contracts, not runtime command constructors.",
    " * Register with context.feature(CommandClass)(FeatureClass) or",
    " * context.appService(CommandClass)(ApplicationServiceClass).",
    " */",
    `export function registerServices(_context: BoundedContext<${Dependencies}>): void {}`,
    "",
  ].join("\n");

  const index = [
    HEADER(`«${alias}», ready to use`),
    "",
    `import { transport } from "${transport}";`,
    "",
    `import { config${Name}BoundedContext } from "${at(".", "infrastructure", "bounded_context")}";`,
    `import { registerServices } from "${at(".", "services")}";`,
    "",
    `/** «${alias}»: \`${name}.execute(new Command(...))\`. */`,
    `export const ${name} = config${Name}BoundedContext(${JSON.stringify(alias)}, transport);`,
    `registerServices(${name});`,
    "",
  ].join("\n");

  return {
    "infrastructure/dependencies.ts": dependencies,
    "infrastructure/bounded_context.ts": boundedContext,
    "services/index.ts": services,
    "index.ts": index,
  };
}
