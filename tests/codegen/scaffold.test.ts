import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { Metamodel } from "@sincpro/client-framework/codegen";
import { scaffoldFilesOf } from "@sincpro/client-framework/codegen";
import ts from "typescript";
import { test } from "vitest";

import contract from "../support/forge-contract/project.contract.json";

const project = contract as unknown as Metamodel;

test("a bounded context's skeleton is the backend's layout, named after the contract", () => {
  const files = scaffoldFilesOf(project);
  assert.deepEqual(Object.keys(files).sort(), [
    "index.ts",
    "infrastructure/bounded_context.ts",
    "infrastructure/dependencies.ts",
    "services/index.ts",
  ]);
  assert.ok(
    files["infrastructure/dependencies.ts"]?.includes(
      "export interface ProjectDependencies {",
    ),
  );
  assert.ok(
    files["infrastructure/dependencies.ts"]?.includes(
      'boundedContext.addDependency("client", clientOf(operations));',
    ),
  );
  assert.ok(
    files["infrastructure/bounded_context.ts"]?.includes(
      "export abstract class Feature<C extends Command<R> | DomainEvent, R> extends BaseFeature<C, R>",
    ),
  );
  assert.ok(
    files["index.ts"]?.includes(
      'export const projectBoundedContext = configProjectBoundedContext("project", operations);',
    ),
  );
  assert.ok(
    files["index.ts"]?.includes(
      'import { operations } from "../common/infrastructure/operations";',
    ),
  );
  assert.ok(
    scaffoldFilesOf(project, { operations: "@/app/operations" })["index.ts"]?.includes(
      'import { operations } from "@/app/operations";',
    ),
  );
});

test("the constant says it is a bounded context, whatever the alias: never a bare word or an abbreviation", () => {
  const named = (alias: string) => scaffoldFilesOf({ ...project, alias })["index.ts"] ?? "";
  assert.ok(named("import").includes("export const importBoundedContext ="));
  assert.ok(named("operations").includes("export const operationsBoundedContext ="));
  assert.ok(named("sales-orders").includes("export const salesOrdersBoundedContext ="));
  const files = Object.values(scaffoldFilesOf(project)).join("\n");
  assert.ok(!/\b(bc|ctx)\b/.test(files));
});

test("the skeleton compiles as it is written, beside what the generator writes", () => {
  const root = mkdtempSync(join(tmpdir(), "scaffold-"));
  // The application's own packages: what the generated files import (`@sincpro/criteria`).
  symlinkSync(resolve("node_modules"), join(root, "node_modules"));
  const own = join(root, "domains", "project");
  cpSync(resolve("tests/support/forge-contract/project"), join(own, "generated"), {
    recursive: true,
  });
  for (const [name, source] of Object.entries(scaffoldFilesOf(project))) {
    mkdirSync(join(own, name, ".."), { recursive: true });
    writeFileSync(join(own, name), source);
  }
  mkdirSync(join(root, "domains", "common", "infrastructure"), { recursive: true });
  writeFileSync(
    join(root, "domains", "common", "infrastructure", "operations.ts"),
    'import { memoryTransport, restOperations } from "@sincpro/client-framework";\nexport const operations = restOperations(memoryTransport({}));\n',
  );
  const program = ts.createProgram([join(own, "index.ts")], {
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
    noUnusedLocals: true,
    baseUrl: resolve("."),
    paths: {
      "@sincpro/client-framework": ["./src/index.ts"],
      "@sincpro/client-framework/*": ["./src/*"],
    },
    typeRoots: [resolve("node_modules/@types")],
    types: [],
  });
  const problems = ts
    .getPreEmitDiagnostics(program)
    .filter((one) => one.file?.fileName.startsWith(root))
    .map((one) => ts.flattenDiagnosticMessageText(one.messageText, "\n"));
  assert.deepEqual(problems, []);
});
