#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { clientFileOf } from "@sincpro/client-framework/codegen/client";
import { domainFileOf } from "@sincpro/client-framework/codegen/domain";
import { entitiesFileOf } from "@sincpro/client-framework/codegen/entities";
import type { Metamodel } from "@sincpro/client-framework/codegen/metamodel";
import { aliasOf } from "@sincpro/client-framework/codegen/names";
import type { GenerateOptions } from "@sincpro/client-framework/codegen/rest";

/**
 * `sincpro-client generate <contract.json> --out <dir> [--domain <name>] [--base <path>]` — what an
 * application's `make client` runs, once per bounded context, over the client contract
 * sincpro_framework exported (`export-client-contract`):
 *
 * - `domain.ts`: the DTOs, only types;
 * - `client.ts`: every operation as data, and `clientOf(transport)`;
 * - `entities.ts`: an `entity<T, C>()` per model a screen can list;
 * - `contract.json`: the snapshot they were written from, for `metasOf`.
 *
 * A bare metamodel (`export_metamodel`, no bindings) writes `domain.ts` and `contract.json` only.
 *
 * Context: it writes only into `--out`, and the same bytes for the same contract, so `make
 * verify-client` regenerates and fails on any difference. The folder is the generator's: keep
 * it out of the application's prettier and eslint, or a formatter rewrites what was generated.
 */
const USAGE =
  "usage: sincpro-client generate <contract.json> --out <dir> [--domain <name>] [--base <path>]";

/** JSON with every key sorted: the snapshot reads the same however the server ordered it. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
  );
}

/** The command, its source and its flags — or `undefined` when they do not read as usage says. */
function parsed(
  args: readonly string[],
): { source: string; out: string; options: GenerateOptions } | undefined {
  const [command, source, ...rest] = args;
  if (command !== "generate" || source === undefined) return undefined;
  const flags = new Map<string, string>();
  for (let at = 0; at < rest.length; at += 2) {
    const flag = rest[at];
    const value = rest[at + 1];
    if (flag === undefined || value === undefined || !flag.startsWith("--")) return undefined;
    flags.set(flag, value);
  }
  const out = flags.get("--out");
  const known = new Set(["--out", "--domain", "--base"]);
  if (out === undefined || [...flags.keys()].some((one) => !known.has(one))) return undefined;
  const domain = flags.get("--domain");
  const base = flags.get("--base");
  return {
    source,
    out,
    options: {
      ...(domain === undefined ? {} : { domain }),
      ...(base === undefined ? {} : { base }),
    },
  };
}

function main(args: readonly string[]): number {
  const asked = parsed(args);
  if (asked === undefined) {
    console.error(USAGE);
    return 2;
  }
  const metamodel = JSON.parse(readFileSync(asked.source, "utf8")) as Metamodel;
  const files: Record<string, string> = { "domain.ts": domainFileOf(metamodel) };
  if (metamodel.bindings !== undefined) {
    files["client.ts"] = clientFileOf(metamodel, asked.options);
    files["entities.ts"] = entitiesFileOf(metamodel, asked.options);
  }
  files["contract.json"] = `${JSON.stringify(canonical(metamodel), null, 2)}\n`;
  mkdirSync(asked.out, { recursive: true });
  for (const [name, source] of Object.entries(files))
    writeFileSync(join(asked.out, name), source);
  console.log(`✓ ${aliasOf(metamodel)} → ${asked.out} (${Object.keys(files).join(", ")})`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
