import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  type ClientContract,
  entityKeyOf,
  eventMetasOf,
  metasOf,
  versionsOf,
} from "@sincpro/client-framework";
import { choiceLabelOf, labelOf } from "@sincpro/criteria";
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

/** A contract exported with its events by sincpro_framework 3.37.1: each field of an event
 *  carries its `x-sincpro`, as an entity's do. */
const desk: ClientContract = {
  models: {
    Agent: {
      type: "object",
      title: "Agent",
      properties: {
        id: { type: "string", "x-sincpro": { type: "text", label: { default: "ID" } } },
      },
      "x-sincpro": { entity: "Agent", identity: "id" },
    },
  },
  events: {
    "desk.ticket.v1.closed": {
      schema: {
        type: "object",
        title: "TicketClosed",
        required: ["name", "reason"],
        properties: {
          name: { const: "desk.ticket.v1.closed", type: "string" },
          reason: {
            type: "string",
            title: "Reason",
            "x-sincpro": { type: "text", label: { default: "Reason", es: "Motivo" } },
          },
          outcome: {
            enum: ["solved", "duplicate"],
            type: "string",
            "x-sincpro": {
              type: "text",
              choice_labels: {
                solved: { default: "Solved", es: "Resuelto" },
                duplicate: { default: "Duplicate", es: "Duplicado" },
              },
            },
          },
          by: {
            anyOf: [{ $ref: "#/models/Agent" }, { type: "null" }],
            title: "Closed by",
            "x-sincpro": {
              type: "many2one",
              relation: "Agent",
              label: { default: "Closed by" },
            },
          },
          entity_display: {
            type: "string",
            title: "Record",
            "x-sincpro": { type: "text", label: { default: "Record", es: "Registro" } },
          },
        },
      },
    },
  },
};

test("each event of a contract is described by its wire name, its fields in the model's words", () => {
  const metas = eventMetasOf(desk);
  assert.deepEqual(Object.keys(metas), ["desk.ticket.v1.closed"]);
  const closed = metas["desk.ticket.v1.closed"]!;
  assert.equal(labelOf(closed, "reason", "es"), "Motivo");
  assert.equal(labelOf(closed, "entity_display", "es"), "Registro");
  assert.equal(choiceLabelOf(closed, "outcome", "duplicate", "es"), "Duplicado");
  // Who closed it points at a model of the contract, described as a relation is.
  assert.equal(closed.fields.by?.type, "many2one");
  assert.ok(closed.fields.by?.definition?.fields.id !== undefined);
});

test("a contract exported without its events describes none", () => {
  assert.deepEqual(eventMetasOf(project), {});
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
