import assert from "node:assert/strict";

import { metaFromSchema, type SchemaComponents } from "@sincpro/client-framework";
import { test } from "vitest";

import forge from "./support/forge-openapi.json" with { type: "json" };

const components = forge.components as unknown as SchemaComponents;
test("a value object's enums and lists come out of the schema", () => {
  const spec = metaFromSchema("ProjectSpecification", components);
  assert.deepEqual(spec.fields["language"]?.choices, ["es", "en"]);
  assert.equal(spec.fields["verification_checks"]?.type, "text[]");
  assert.equal(spec.fields["engineer_review"]?.type, "boolean");
  assert.equal(spec.fields["preparation"]?.kind, "embedded");
});

test("a command's form: what is required, what has a default, what it is called", () => {
  const register = metaFromSchema("CommandRegisterProject", components);
  assert.equal(register.fields["project_id"]?.required, true);
  assert.equal(register.fields["tenant_id"]?.required, false);
  assert.equal(register.fields["tenant_id"]?.default, "");
  assert.deepEqual(register.fields["project_id"]?.label, { default: "Project Id" });
  assert.equal(register.fields["project_repositories"]?.many, true);
  assert.equal(register.fields["project_repositories"]?.kind, "embedded");
});

test("a reference the document does not hold is unknown, never a crash", () => {
  const spec = metaFromSchema("ArtifactTransfer", components);
  assert.equal(spec.fields["source"]?.type, "unknown");
  assert.equal(spec.fields["destination"]?.type, "text");
});
