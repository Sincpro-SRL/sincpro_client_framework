import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  CheckError,
  checkImports,
  placeOf,
  violationOf,
} from "@sincpro/client-framework/codegen";
import { test } from "vitest";

/** An application's tree, written to a folder of its own, with `@/` as its alias for `src/`. */
function application(
  files: Readonly<Record<string, string>>,
  configs?: Readonly<Record<string, unknown>>,
): string {
  const root = mkdtempSync(join(tmpdir(), "check-"));
  symlinkSync(resolve("node_modules"), join(root, "node_modules"));
  for (const [name, config] of Object.entries(configs ?? {}))
    writeFileSync(join(root, name), JSON.stringify(config));
  if (configs === undefined)
    writeFileSync(
      join(root, "tsconfig.json"),
      JSON.stringify({
        // A comment-free config, as `tsc --init` would not write — read by TypeScript either way.
        compilerOptions: {
          baseUrl: ".",
          paths: { "@/*": ["./src/*"] },
          moduleResolution: "bundler",
          module: "esnext",
          jsx: "react-jsx",
        },
        include: ["src"],
      }),
    );
  for (const [name, source] of Object.entries(files)) {
    mkdirSync(dirname(join(root, "src", name)), { recursive: true });
    writeFileSync(join(root, "src", name), source);
  }
  return root;
}

test("a file's place is its bounded context and its layer", () => {
  assert.deepEqual(placeOf("domains/sales/services/close.ts"), {
    kind: "context",
    context: "sales",
    layer: "services",
    index: false,
  });
  assert.deepEqual(placeOf("domains/sales/index.ts"), {
    kind: "context",
    context: "sales",
    layer: null,
    index: true,
  });
  assert.deepEqual(placeOf("entrypoints/app.tsx"), { kind: "entrypoint" });
  assert.deepEqual(placeOf("main.tsx"), { kind: "other" });
});

test("what each layer never imports — and what it may", () => {
  const services = placeOf("domains/sales/services/close.ts");
  assert.match(violationOf(services, "react", null) ?? "", /plain logic/);
  assert.match(violationOf(services, "@sincpro/web-ui", null) ?? "", /plain logic/);
  assert.match(violationOf(services, "@sincpro/web-framework", null) ?? "", /plain logic/);
  assert.equal(violationOf(services, "@sincpro/web-framework/core", null), undefined);
  assert.equal(violationOf(services, "@sincpro/client-framework", null), undefined);
  const components = placeOf("domains/sales/components/invoice/Row.tsx");
  assert.equal(violationOf(components, "@sincpro/web-ui", null), undefined);
  assert.match(
    violationOf(components, "@sincpro/web-composer", null) ?? "",
    /where things open/,
  );
  assert.match(
    violationOf(placeOf("domains/sales/domain/money.ts"), "react-native", null) ?? "",
    /plain/,
  );
});

test("an application that keeps the layers passes; each break is said, with its file and why", async () => {
  const root = application({
    "domains/common/infrastructure/transport.ts": "export const transport = {};\n",
    "domains/common/domain/money.ts": "export type Money = { amount: string };\n",
    "domains/auth/index.ts": "export const auth = {};\n",
    "domains/auth/services/session.ts": "export const session = {};\n",
    "domains/sales/domain/invoice.ts":
      'import type { Money } from "@/domains/common/domain/money";\nexport type Invoice = { total: Money };\n',
    "domains/sales/adapters/printer.ts": "export const printer = {};\n",
    "domains/sales/infrastructure/dependencies.ts":
      'import { auth } from "@/domains/auth";\nimport { transport } from "../../common/infrastructure/transport";\nexport const deps = { auth, transport };\n',
    "domains/sales/services/close.ts":
      'import { deps } from "../infrastructure/dependencies";\nexport const close = () => deps;\n',
    "domains/sales/index.ts": 'export { close } from "./services/close";\n',
    "entrypoints/app.tsx":
      'import { close } from "@/domains/sales";\nexport const app = close;\n',
  });
  assert.deepEqual(await checkImports(join(root, "src")), []);

  const broken = application({
    "domains/auth/services/session.ts": "export const session = {};\n",
    "domains/auth/index.ts": "export const auth = {};\n",
    "domains/sales/adapters/printer.ts": "export const printer = {};\n",
    "domains/sales/domain/invoice.ts":
      'import { printer } from "../adapters/printer";\nexport const invoice = printer;\n',
    "domains/sales/services/close.ts":
      'import { useState } from "react";\nimport { session } from "@/domains/auth/services/session";\nexport const close = [useState, session];\n',
    "domains/common/domain/x.ts":
      'import { auth } from "../../auth";\nexport const x = auth;\n',
    "entrypoints/app.tsx":
      'import { close } from "../domains/sales/services/close";\nexport const app = close;\n',
  });
  const found = await checkImports(join(broken, "src"));
  assert.deepEqual(found.map(({ file, imports }) => `${file} → ${imports}`).sort(), [
    "domains/common/domain/x.ts → ../../auth",
    "domains/sales/domain/invoice.ts → ../adapters/printer",
    "domains/sales/services/close.ts → @/domains/auth/services/session",
    "domains/sales/services/close.ts → react",
    "entrypoints/app.tsx → ../domains/sales/services/close",
  ]);
  assert.match(
    found.find((one) => one.imports.includes("auth/services"))?.why ?? "",
    /never imports another's insides/,
  );
});

const ALIASED = {
  compilerOptions: {
    baseUrl: ".",
    paths: { "@/*": ["./src/*"] },
    moduleResolution: "bundler",
    module: "esnext",
    jsx: "react-jsx",
  },
  include: ["src"],
};

const CROSSING = {
  "domains/auth/services/session.ts": "export const session = {};\n",
  "domains/sales/services/close.ts":
    'import { session } from "@/domains/auth/services/session";\nexport const close = session;\n',
};

test("Vite's layout — a tsconfig of references, the aliases in tsconfig.app.json — is followed", async () => {
  const root = application(CROSSING, {
    "tsconfig.json": { files: [], references: [{ path: "./tsconfig.app.json" }] },
    "tsconfig.app.json": ALIASED,
  });
  const found = await checkImports(join(root, "src"), {
    tsconfig: join(root, "tsconfig.json"),
  });
  assert.deepEqual(
    found.map(({ imports }) => imports),
    ["@/domains/auth/services/session"],
  );
});

test("a tsconfig that is not there, or an alias no config finds, stops the check — never a green", async () => {
  const root = application(CROSSING, {
    "tsconfig.json": { compilerOptions: { paths: { "@/*": ["./nowhere/*"] } } },
  });
  await assert.rejects(
    checkImports(join(root, "src"), { tsconfig: join(root, "nope.json") }),
    CheckError,
  );
  await assert.rejects(checkImports(join(root, "missing")), /does not exist/);
  const found = await checkImports(join(root, "src"));
  assert.match(found[0]?.why ?? "", /does not resolve/);
});

test("within a bounded context, each layer never imports what the table forbids; nothing imports the entrypoints", async () => {
  const root = application({
    "domains/sales/components/Row.tsx": "export const Row = 1;\n",
    "domains/sales/services/close.ts":
      'import { Row } from "../components/Row";\nexport const close = Row;\n',
    "domains/sales/domain/invoice.ts":
      'import { close } from "../services/close";\nexport const invoice = close;\n',
    "domains/common/infrastructure/x.ts":
      'import { app } from "@/entrypoints/app";\nexport const x = app;\n',
    "entrypoints/app.tsx": "export const app = 1;\n",
    // A stylesheet is the bundler's: never read as an alias that does not resolve.
    "main.tsx":
      'import "@/entrypoints/styles.css";\nimport { close } from "@/domains/sales/services/close";\nexport const main = close;\n',
  });
  const found = await checkImports(join(root, "src"));
  assert.deepEqual(found.map(({ file, imports }) => `${file} → ${imports}`).sort(), [
    "domains/common/infrastructure/x.ts → @/entrypoints/app",
    "domains/sales/domain/invoice.ts → ../services/close",
    "domains/sales/services/close.ts → ../components/Row",
    "main.tsx → @/domains/sales/services/close",
  ]);
});

test("a bounded context that is a package of its own (a monorepo): its src/ is its layers, its name its index", () => {
  assert.deepEqual(placeOf("domains/ventas/src/services/close.ts"), {
    kind: "context",
    context: "ventas",
    layer: "services",
    index: false,
  });
  assert.deepEqual(placeOf("src/domains/ventas/index.ts"), {
    kind: "context",
    context: "ventas",
    layer: null,
    index: true,
  });
  assert.deepEqual(placeOf("src/entrypoints/app.tsx"), { kind: "entrypoint" });
});
