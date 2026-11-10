import assert from "node:assert/strict";

import { defineMeta, field } from "@sincpro/client-framework";
import { fieldsThatFilter, fieldsThatSort, labelOf, searchOver } from "@sincpro/criteria";
import { test } from "vitest";

import { tenantMeta } from "../support/forge";
import { facturaMeta } from "../support/ventas";

test("a hand-written definition takes the same operators the framework publishes", () => {
  const forgeText = tenantMeta.fields["display_name"];
  const ours = field.text();
  assert.deepEqual(ours.ops, forgeText?.ops);
  assert.deepEqual(field.datetime().ops, tenantMeta.fields["created_at"]?.ops);
  assert.deepEqual(field.boolean().ops, tenantMeta.fields["active"]?.ops);
});

test("a nullable field is never sortable: keyset paging over it loses rows", () => {
  assert.equal(field.date({ nullable: true }).sortable, false);
  assert.ok(field.date({ nullable: true }).ops.includes("is null"));
  assert.ok(!fieldsThatSort(facturaMeta).includes("due_date"));
});

test("relations and value objects are not filtered directly", () => {
  const filterable = fieldsThatFilter(facturaMeta);
  assert.ok(!filterable.includes("customer"));
  assert.ok(!filterable.includes("lines"));
  assert.ok(filterable.includes("customer_id"));
});

test("labels are read in the language asked, the default otherwise", () => {
  const meta = defineMeta({
    aggregate: "T",
    identity: "id",
    fields: {
      id: field.text(),
      title: field.text({ label: { default: "Title", es: "Título" } }),
    },
  });
  assert.equal(labelOf(meta, "title", "es"), "Título");
  assert.equal(labelOf(meta, "title", "en"), "Title");
});

test("the search template is filled the way the server fills it", () => {
  const where = searchOver(facturaMeta, "0007");
  assert.deepEqual(where, {
    any: [
      { field: "number", operator: "like", value: "0007" },
      { field: "customer_name", operator: "like", value: "0007" },
    ],
  });
});

test("naming a field that is not declared is caught when the definition is written", () => {
  assert.throws(
    () =>
      defineMeta({
        aggregate: "T",
        identity: "id",
        display: "name",
        fields: { id: field.text() },
      }),
    /name named but not declared/,
  );
});
