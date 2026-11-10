import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

import type * as TS from "typescript";

/**
 * The import rules of a Sincpro application, checked — what `sincpro-client check` runs in an
 * application's `make doctor`, on the web and on a phone alike.
 *
 *     src/domains/<bounded context>/{generated,domain,adapters,services,infrastructure,components,entrypoints}
 *     src/domains/common/            what bounded contexts share
 *     src/entrypoints/               where the outside comes in
 *
 * | Layer             | Never                                                                  |
 * | ----------------- | ---------------------------------------------------------------------- |
 * | generated, domain | React, the DOM's libraries (web-ui, composer), its own adapters        |
 * | adapters          | React, web-ui, composer                                                |
 * | services          | React, web-ui, composer                                                |
 * | infrastructure    | its own components                                                     |
 * | components        | composer, a router                                                     |
 * | common            | any bounded context                                                    |
 * | any layer         | another bounded context — but its `index.ts`, from `infrastructure/`   |
 * | entrypoints/ root | a bounded context's insides — only its `index.ts` (and `common`)       |
 *
 * Context: the architecture says these rules are enforced, not recommended; a rule only read in a
 * page is the first to go under a deadline. Each import is resolved the way the application's
 * compiler resolves it — its own `tsconfig.json`, its path aliases (`@/domains/…`) — with the
 * application's TypeScript, so a relative path and an alias are the same import. Nothing here is
 * a platform's: a React Native app has the same layers (`react-native` counts as React).
 */

export type Violation = {
  /** The importing file, from the root. */
  file: string;
  /** What it imports, as written. */
  imports: string;
  why: string;
};

const LAYERS = new Set([
  "generated",
  "domain",
  "adapters",
  "services",
  "infrastructure",
  "components",
  "entrypoints",
]);

/** Where a file is in the application's tree. */
export type Place =
  | { kind: "context"; context: string; layer: string | null; index: boolean }
  | { kind: "entrypoint" }
  | { kind: "other" };

/**
 * `domains/sales/services/close.ts` → the bounded context `sales`, the layer `services` — wherever
 * the `domains/` folder is (`src/domains/…`, a workspace's `domains/sales/src/services/…`).
 */
export function placeOf(path: string): Place {
  const parts = path.split(/[\\/]/).filter((one) => one !== "");
  const start = parts[0] === "src" ? 1 : 0;
  if (parts[start] === "entrypoints") return { kind: "entrypoint" };
  const at = parts.indexOf("domains");
  const context = at === -1 ? undefined : parts[at + 1];
  if (context === undefined || parts.length < at + 3) return { kind: "other" };
  // A bounded context that is a package of its own keeps its code under `src/`.
  const rest = parts.slice(at + 2);
  const inside = rest[0] === "src" && rest.length > 1 ? rest.slice(1) : rest;
  const first = inside[0] ?? "";
  const index = inside.length === 1 && /^index\.(ts|tsx|js|jsx|mts)$/.test(first);
  return { kind: "context", context, layer: LAYERS.has(first) ? first : null, index };
}

const REACT = /^(react|react-dom|react-native)(\/|$)/;
const DRAWING = /^@sincpro\/(web-ui|web-composer)(\/|$)/;
const COMPOSER = /^@sincpro\/web-composer(\/|$)/;
const ROUTER =
  /^(react-router|react-router-dom|@tanstack\/react-router|next\/navigation|next\/router|expo-router)(\/|$)/;
/** web-framework draws; only its `core` is plain logic a service may use. */
const SCREENS = /^@sincpro\/web-framework(?!\/core(\/|$))(\/|$)/;

const PLAIN = new Set(["generated", "domain", "adapters", "services"]);

/** Within a bounded context, what each layer never imports of its own. */
const NEVER_OWN: Readonly<Record<string, readonly string[]>> = {
  generated: ["adapters", "services", "infrastructure", "components", "entrypoints"],
  domain: ["adapters", "services", "infrastructure", "components", "entrypoints"],
  adapters: ["services", "components", "entrypoints"],
  services: ["components", "entrypoints"],
  infrastructure: ["components", "entrypoints"],
};

/**
 * Why `from` may not import `specifier`, which resolves to `to` (`null`: a package), or nothing
 * when it may.
 */
export function violationOf(
  from: Place,
  specifier: string,
  to: Place | null,
): string | undefined {
  if (to === null) {
    if (from.kind !== "context" || from.layer === null) return undefined;
    if (
      PLAIN.has(from.layer) &&
      (REACT.test(specifier) || DRAWING.test(specifier) || SCREENS.test(specifier))
    )
      return `${from.layer}/ is plain logic: it never imports a screen's library (React, web-ui, composer, web-framework but its core)`;
    if (from.layer === "components" && (COMPOSER.test(specifier) || ROUTER.test(specifier)))
      return "a component never decides where things open: no composer, no router";
    return undefined;
  }
  // The application's entrypoints compose everything; nothing imports them back.
  if (to.kind === "entrypoint")
    return from.kind === "entrypoint"
      ? undefined
      : "nothing imports the application's entrypoints";
  if (to.kind !== "context") return undefined;
  // Outside the bounded contexts (the entrypoints, `main.tsx`, a `lib/`): only their index.ts.
  if (from.kind !== "context")
    return to.context === "common" || to.index
      ? undefined
      : `outside a bounded context, it is used through its index.ts, never its insides («${to.context}»)`;
  if (from.context === "common")
    return to.context === "common" ? undefined : "common never imports a bounded context";
  if (to.context === "common") return undefined;
  if (to.context === from.context) {
    const never = from.layer === null ? undefined : NEVER_OWN[from.layer];
    return to.layer !== null && never?.includes(to.layer) === true
      ? `${from.layer}/ never imports its own ${to.layer}/`
      : undefined;
  }
  if (to.index && from.layer === "infrastructure") return undefined;
  return to.index
    ? `another bounded context («${to.context}») is a dependency: added in infrastructure/, never imported here`
    : `a bounded context never imports another's insides («${to.context}»): only its index.ts, from infrastructure/`;
}

function sources(root: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) found.push(...sources(path));
    else if (/\.(ts|tsx|mts|cts|js|jsx)$/.test(entry.name) && !entry.name.endsWith(".d.ts"))
      found.push(path);
  }
  return found;
}

/** What stops the check before it starts: no root, no config, a config that does not parse. */
export class CheckError extends Error {}

type Ts = typeof TS;
type Options = TS.CompilerOptions;

/**
 * The compiler options the application resolves with: its config's, and those of every config it
 * references — Vite writes `files: []` in `tsconfig.json` and keeps its aliases in
 * `tsconfig.app.json`.
 */
function optionsOf(ts: Ts, path: string, seen: Set<string>): Options[] {
  if (seen.has(path)) return [];
  seen.add(path);
  const read = ts.readConfigFile(path, ts.sys.readFile);
  if (read.error !== undefined)
    throw new CheckError(
      `${path}: ${ts.flattenDiagnosticMessageText(read.error.messageText, " ")}`,
    );
  const parsed = ts.parseJsonConfigFileContent(
    read.config,
    ts.sys,
    dirname(path),
    undefined,
    path,
  );
  // «No inputs were found» is what a config of references only says: not an error here.
  const broken = parsed.errors.find(
    (one) => one.category === ts.DiagnosticCategory.Error && one.code !== 18003,
  );
  if (broken !== undefined)
    throw new CheckError(
      `${path}: ${ts.flattenDiagnosticMessageText(broken.messageText, " ")}`,
    );
  return [
    parsed.options,
    ...(parsed.projectReferences ?? []).flatMap((one) =>
      optionsOf(ts, ts.resolveProjectReferencePath(one), seen),
    ),
  ];
}

/** A style, an image, a font, data: what a bundler loads and TypeScript does not resolve. */
const ASSET =
  /\.(css|scss|sass|less|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|json|md|mdx)(\?.*)?$/;

/** `@acme/ventas`, `ventas` — a package named whole, never a path inside it. */
const BARE = /^(@[^/]+\/)?[^/.@][^/]*$/;

/**
 * Every import under `root` that breaks a rule, resolved by the application's own TypeScript and
 * `tsconfig` (its path aliases and its references included). An alias that does not resolve is a
 * break too — read as a package it would switch every rule off.
 */
export async function checkImports(
  root: string,
  options: { tsconfig?: string } = {},
): Promise<Violation[]> {
  if (!existsSync(root))
    throw new CheckError(
      `${root} does not exist: say where the application's code is (--root)`,
    );
  const { default: ts } = await import("typescript");
  if (options.tsconfig !== undefined && !ts.sys.fileExists(options.tsconfig))
    throw new CheckError(`${options.tsconfig} does not exist`);
  const configPath = options.tsconfig ?? ts.findConfigFile(root, ts.sys.fileExists);
  const compilers = configPath === undefined ? [{}] : optionsOf(ts, configPath, new Set());
  const aliases = compilers
    .flatMap((one) => Object.keys(one.paths ?? {}))
    .map((pattern) => pattern.replace(/\*.*$/, ""))
    .filter((prefix) => prefix !== "");
  const own = (path: string) => {
    const from = relative(root, path);
    return !from.startsWith("..") && !from.split(sep).includes("node_modules");
  };
  const violations: Violation[] = [];
  for (const file of sources(root)) {
    const name = relative(root, file).split(sep).join("/");
    const from = placeOf(name);
    for (const { fileName: specifier } of ts.preProcessFile(
      readFileSync(file, "utf8"),
      true,
      true,
    ).importedFiles) {
      if (ASSET.test(specifier)) continue;
      // The first config that finds it inside the application, else any that finds it.
      let resolved: TS.ResolvedModuleFull | undefined;
      for (const compiler of compilers) {
        const found = ts.resolveModuleName(specifier, file, compiler, ts.sys).resolvedModule;
        if (found === undefined) continue;
        resolved ??= found;
        if (own(found.resolvedFileName)) {
          resolved = found;
          break;
        }
      }
      if (resolved === undefined && aliases.some((prefix) => specifier.startsWith(prefix))) {
        violations.push({
          file: name,
          imports: specifier,
          why: "it does not resolve: an alias of the application that no tsconfig finds",
        });
        continue;
      }
      const inside = resolved !== undefined && own(resolved.resolvedFileName);
      let to: Place | null = inside
        ? placeOf(relative(root, resolved!.resolvedFileName).split(sep).join("/"))
        : specifier.startsWith(".")
          ? { kind: "other" }
          : null;
      // A bounded context that is a package, named whole (`@acme/ventas`): its index.
      if (to?.kind === "context" && BARE.test(specifier)) to = { ...to, index: true };
      const why = violationOf(from, specifier, to);
      if (why !== undefined) violations.push({ file: name, imports: specifier, why });
    }
  }
  return violations;
}
