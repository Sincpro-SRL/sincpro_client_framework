import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  type ClientContract,
  entityKeyOf,
  metasOf,
  versionsOf,
} from "@sincpro/client-framework";
import { labelOf } from "@sincpro/criteria";
import { test } from "vitest";

import { entities } from "../support/forge-contract/project/adapters/generated/entities";

const project = JSON.parse(
  readFileSync(
    new URL("../support/forge-contract/project.contract.json", import.meta.url),
    "utf8",
  ),
) as ClientContract;

test("an entity's key is its domain and its model's name in snake case", () => {
  assert.equal(entityKeyOf("project", "Issue"), "project:issue");
  assert.equal(entityKeyOf("project", "ProjectEvent"), "project:project_event");
  assert.equal(entityKeyOf("crm", "URLMap"), "crm:url_map");
});

test("a contract's models are preloaded under their entities' keys, as the server describes them", () => {
  const metas = metasOf(project, "project");
  assert.deepEqual(Object.keys(metas).sort(), [
    "project:issue",
    "project:project",
    "project:project_event",
    "project:project_repository",
    "project:run",
    "project:run_step",
  ]);
  const issue = metas["project:issue"]!;
  assert.equal(labelOf(issue, "status", "es"), "Estado");
  // A related model, named as a definition inside the Issue's contract, is described too.
  assert.ok(issue.fields.runs?.definition?.fields.status !== undefined);
  // A value the issue holds, a model of its own pointed at (#244), keeps its definition.
  assert.equal(issue.fields.project_snapshot?.definition?.fields.host?.type, "text");
});

test("every generated entity finds its preloaded definition under its own key", () => {
  const metas = metasOf(project, "project");
  for (const one of entities) assert.ok(metas[one.key] !== undefined, one.key);
});

test("the snapshot's version of each entity is what a transport compares answers with", () => {
  const versions = versionsOf(project);
  assert.deepEqual(Object.keys(versions).sort(), [
    "Issue",
    "Project",
    "ProjectEvent",
    "ProjectRepository",
    "Run",
    "RunStep",
  ]);
  assert.match(versions["Issue"] ?? "", /^[0-9a-f]{64}$/);
});
