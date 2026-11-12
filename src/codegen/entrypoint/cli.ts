#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { Metamodel } from "@sincpro/client-framework/codegen/domain/metamodel";
import {
  aliasOf,
  GENERATED_ADAPTERS,
  GENERATED_DOMAIN,
} from "@sincpro/client-framework/codegen/domain/names";
import { CheckError, checkImports } from "@sincpro/client-framework/codegen/services/check";
import { generatedFilesOf } from "@sincpro/client-framework/codegen/services/generated";
import type { GenerateOptions } from "@sincpro/client-framework/codegen/services/rest";
import { scaffoldFilesOf } from "@sincpro/client-framework/codegen/services/scaffold";

/**
 * `sincpro-client generate <contract.json> --out <dir> [--domain <name>] [--base <path>]` — what an
 * application's `make client` runs, once per bounded context, over the client contract
 * sincpro_framework exported (`export-client-contract`). `--out` is the bounded context's folder
 * (`src/domains/project`); each file goes in its layer (`generatedFilesOf`):
 *
 * - `domain/generated/models.ts`: the entities and value objects, only types;
 * - `domain/generated/commands.ts`: every operation's Command and Response;
 * - `domain/generated/events.ts`: the domain events and `DomainEvent`, their union — when the
 *   contract was exported with them (`export-client-contract --events`);
 * - `domain/generated/index.ts`: the three, re-exported;
 * - `domain/generated/contract.json`: the snapshot they were written from, for `metasOf`;
 * - `adapters/generated/client.ts`: every operation (and event) as data, and
 *   `clientOf(operations)` over any wire;
 * - `adapters/generated/entities.ts`: an `entity<T, C>()` per model a screen can list.
 *
 * A bare metamodel (`export_metamodel`, no bindings) writes only `domain/generated/`.
 *
 * Context: it writes only its two `generated/` folders, whole every time — what is no longer
 * generated goes —, and the same bytes for the same contract, so `make verify-client` regenerates
 * and fails on any difference. The folders are the generator's: keep them out of the
 * application's prettier and eslint, or a formatter rewrites what was generated.
 */
const USAGE = [
  "usage: sincpro-client generate <contract.json> --out <dir> [--domain <name>] [--base <path>]",
  "       sincpro-client scaffold <contract.json> --out <dir> [--operations <module>]",
  "       sincpro-client check [--root src] [--tsconfig tsconfig.json]",
].join("\n");

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
function parsed(args: readonly string[]):
  | {
      command: "generate" | "scaffold";
      source: string;
      out: string;
      options: GenerateOptions;
      operations: string | undefined;
    }
  | undefined {
  const [command, source, ...rest] = args;
  if ((command !== "generate" && command !== "scaffold") || source === undefined)
    return undefined;
  const flags = new Map<string, string>();
  for (let at = 0; at < rest.length; at += 2) {
    const flag = rest[at];
    const value = rest[at + 1];
    if (flag === undefined || value === undefined || !flag.startsWith("--")) return undefined;
    flags.set(flag, value);
  }
  const out = flags.get("--out");
  const known = new Set(
    command === "generate" ? ["--out", "--domain", "--base"] : ["--out", "--operations"],
  );
  if (out === undefined || [...flags.keys()].some((one) => !known.has(one))) return undefined;
  const domain = flags.get("--domain");
  const base = flags.get("--base");
  return {
    command,
    source,
    out,
    options: {
      ...(domain === undefined ? {} : { domain }),
      ...(base === undefined ? {} : { base }),
    },
    operations: flags.get("--operations"),
  };
}

/** The skeleton, each file only when it is not there: what is there is the application's. */
function scaffold(metamodel: Metamodel, out: string, operations: string | undefined): number {
  const files = scaffoldFilesOf(metamodel, operations === undefined ? {} : { operations });
  const written: string[] = [];
  const kept: string[] = [];
  for (const [name, source] of Object.entries(files)) {
    const path = join(out, name);
    if (existsSync(path)) {
      kept.push(name);
      continue;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, source);
    written.push(name);
  }
  console.log(
    `✓ ${aliasOf(metamodel)} → ${out}: written ${written.join(", ") || "nothing"}${kept.length === 0 ? "" : `; kept, already yours: ${kept.join(", ")}`}`,
  );
  return 0;
}

/** The import rules (`codegen/check.ts`): every break said, and a failing exit when any. */
async function check(args: readonly string[]): Promise<number> {
  const flags = new Map<string, string>();
  for (let at = 0; at < args.length; at += 2) {
    const flag = args[at];
    const value = args[at + 1];
    if (
      flag === undefined ||
      value === undefined ||
      !["--root", "--tsconfig"].includes(flag)
    ) {
      console.error(USAGE);
      return 2;
    }
    flags.set(flag, value);
  }
  const root = flags.get("--root") ?? "src";
  const tsconfig = flags.get("--tsconfig");
  let found: Awaited<ReturnType<typeof checkImports>>;
  try {
    found = await checkImports(root, tsconfig === undefined ? {} : { tsconfig });
  } catch (error) {
    if (!(error instanceof CheckError)) throw error;
    console.error(`✘ ${error.message}`);
    return 2;
  }
  for (const one of found)
    console.error(`✘ ${root}/${one.file} imports "${one.imports}": ${one.why}`);
  if (found.length > 0) return 1;
  console.log(`✓ ${root}: every import keeps the layers`);
  return 0;
}

function main(args: readonly string[]): number {
  const asked = parsed(args);
  if (asked === undefined) {
    console.error(USAGE);
    return 2;
  }
  const metamodel = JSON.parse(readFileSync(asked.source, "utf8")) as Metamodel;
  if (asked.command === "scaffold") return scaffold(metamodel, asked.out, asked.operations);
  const files = generatedFilesOf(metamodel, asked.options);
  files[`${GENERATED_DOMAIN}/contract.json`] =
    `${JSON.stringify(canonical(metamodel), null, 2)}\n`;
  for (const folder of [GENERATED_DOMAIN, GENERATED_ADAPTERS])
    rmSync(join(asked.out, folder), { recursive: true, force: true });
  for (const [name, source] of Object.entries(files)) {
    const path = join(asked.out, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, source);
  }
  console.log(`✓ ${aliasOf(metamodel)} → ${asked.out} (${Object.keys(files).join(", ")})`);
  return 0;
}

const args = process.argv.slice(2);
if (args[0] === "check")
  void check(args.slice(1)).then((code) => {
    process.exitCode = code;
  });
else process.exitCode = main(args);
