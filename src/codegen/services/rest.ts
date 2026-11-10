import type {
  Metamodel,
  Operation,
} from "@sincpro/client-framework/codegen/domain/metamodel";

/**
 * How REST reaches each operation of a contract, as the generated client and entities write it.
 *
 * Context: the export names each path whole (`/v1/issues/{issue_id}`), version included, while
 * an application's transport already prepends it (`restTransport({ base: "/v1" })`). `base`
 * takes it off every path, and a path outside it is refused — a client written with half its
 * routes under the wrong base would fail one call at a time.
 */
export type GenerateOptions = {
  /** The first part of every entity's key: `project` makes `project:issue`. The contract's
   *  `alias` by default. */
  domain?: string;
  /** What every REST path starts with and the transport prepends: `/v1`. */
  base?: string;
};

export type Reached = {
  method: string;
  /** The path under `base`, `{field}` where a field of the input goes. */
  path: string;
  /** The fields of the input the path carries. */
  fields: readonly string[];
};

/** What a transport can send: GET is read by `list` (a page) or `one` (a record) only. */
export const WRITES = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function restOf(
  metamodel: Metamodel,
  identity: string,
  options: GenerateOptions,
): Reached | undefined {
  const binding = metamodel.bindings?.rest?.[identity];
  if (binding === undefined) return undefined;
  const base = options.base ?? "";
  const under = base === "" || binding.path === base || binding.path.startsWith(`${base}/`);
  if (!under) throw new Error(`${identity} is at ${binding.path}, outside the base ${base}`);
  return {
    method: binding.method.toUpperCase(),
    path: binding.path.slice(base.length) || "/",
    fields: binding.path_fields,
  };
}

/**
 * The one entity a read belongs to: its only entity, or — when it concerns several — the one
 * whose model its answer carries. `undefined` when that still leaves more than one.
 */
export function ownerOf(metamodel: Metamodel, operation: Operation): string | undefined {
  if (operation.entities.length === 1) return operation.entities[0];
  const answer = JSON.stringify(operation.output ?? {});
  const carried = operation.entities.filter(
    (one) => one in metamodel.models && answer.includes(`"#/models/${one}"`),
  );
  return carried.length === 1 ? carried[0] : undefined;
}
