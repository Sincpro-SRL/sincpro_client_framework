import assert from "node:assert/strict";

import {
  bodyFor,
  entity,
  listRoute,
  pathFor,
  SCOPE_PARAM,
  scopeOfRef,
} from "@sincpro/client-framework";
import type { Expression } from "@sincpro/criteria";
import { test } from "vitest";

import { VENTAS } from "./support/ventas";

const projects = entity("forge:project", {
  list: "/projects",
  commands: {
    revoke: "POST /projects/{id}/shares/{tenant_id}/revoke",
    move: "POST /projects/{id}/move",
    openIssue: { route: "POST /issues", target: "project_id" },
    send: { route: "POST /issues/{issue_id}/messages", target: "issue_id" },
  },
  create: "POST /tenants/{tenant_id}/projects",
});

test("a Command whose body names its record gets the record's id there", () => {
  const open = projects.commands["openIssue"]!;
  assert.deepEqual(open, { method: "POST", path: "/issues", target: "project_id" });
  assert.deepEqual(bodyFor(open, "p1", { title: "Falla el login" }), {
    title: "Falla el login",
    project_id: "p1",
  });
});

test("the record's field in the path is filled from the body, as the server reads it", () => {
  const send = projects.commands["send"]!;
  const body = bodyFor(send, "i 7", { message: "y el reporte" });
  assert.equal(pathFor(send, "i 7", body), "/issues/i%207/messages");
});

test("without a target, or without an id, the body goes as it was given", () => {
  const move = projects.commands["move"]!;
  assert.deepEqual(bodyFor(move, "p1", { tenant_id: "acme" }), { tenant_id: "acme" });
  const open = projects.commands["openIssue"]!;
  assert.deepEqual(bodyFor(open, undefined, { project_id: "p2" }), { project_id: "p2" });
});

test("a route with two keys takes the second from the body, as the server reads it", () => {
  const revoke = projects.commands["revoke"]!;
  assert.equal(
    pathFor(revoke, "p 1", { tenant_id: "acme/bo" }),
    "/projects/p%201/shares/acme%2Fbo/revoke",
  );
});

test("a key the body lacks is the screen's bug, said before anything is sent", () => {
  const revoke = projects.commands["revoke"]!;
  assert.throws(() => pathFor(revoke, "p1", {}), /needs "tenant_id"/);
  assert.throws(() => pathFor(revoke, "p1", { tenant_id: "" }), /needs "tenant_id"/);
});

test("a create fills its route's keys from what it sends; a route with only {id} is as before", () => {
  assert.equal(
    pathFor(projects.create!, undefined, { tenant_id: "acme" }),
    "/tenants/acme/projects",
  );
  assert.equal(pathFor(projects.commands["move"]!, "p1"), "/projects/p1/move");
});

const customers = entity("ventas:cliente", { list: "/clientes" });

test("a chooser carries the picker's cut, and reads it back as the expression it was", () => {
  const cut: Expression = { field: "id", operator: "not in", value: ["C-001", "C-004"] };
  const ref = customers.chooserRef("Glo", cut);
  assert.equal(ref.params?.[SCOPE_PARAM], JSON.stringify(cut));
  assert.deepEqual(scopeOfRef(ref), cut);
  assert.equal(scopeOfRef(customers.chooserRef("Glo")), undefined);
});

test("a cut typed in an address bar that does not read is no cut, never an error", () => {
  assert.equal(scopeOfRef({ params: { [SCOPE_PARAM]: "{not json" } }), undefined);
  assert.equal(scopeOfRef({ params: { [SCOPE_PARAM]: '{"name":"Globex"}' } }), undefined);
});

test("a list under a record takes its key from the parameters, and the rest as its query", () => {
  assert.equal(
    listRoute("/tenants/{tenant_id}/members", { tenant_id: "acme bo", role: "admin" }),
    "/tenants/acme%20bo/members?role=admin",
  );
  assert.equal(
    listRoute("/projects", { tenant_id: "acme", q: "" }),
    "/projects?tenant_id=acme",
  );
});

test("a list whose path needs a key the parameters lack is refused before anything is sent", () => {
  assert.throws(
    () => listRoute("/tenants/{tenant_id}/members", { role: "admin" }),
    /the list "\/tenants\/\{tenant_id\}\/members" needs "tenant_id"/,
  );
});

test("an entity keeps its export route, and a record route with a question reads in memory", async () => {
  const { entity, memoryTransport } = await import("@sincpro/client-framework");
  const groups = entity("auth:Group", {
    list: "/groups",
    one: "/groups/{id}?draft=true",
    export: "/groups/export",
  });
  const meta = (await memoryTransport(VENTAS).list("/clientes", {})).meta!;
  const transport = memoryTransport({
    "/groups": { meta: { ...meta, identity: "id", get_id: "id" }, rows: [{ id: "g1" }] },
  });

  assert.equal(groups.export, "/groups/export");
  const read = await transport.one<{ id: string }>(groups.one("g1"));
  assert.equal(read.record.id, "g1");
});
