import assert from "node:assert/strict";

import {
  bodyFor,
  type Entity,
  entity,
  listRoute,
  pathFor,
  PICK_PARAM,
  type ResourceRef,
  SCOPE_NAME_PARAM,
  SCOPE_PARAM,
  scopeNameOf,
  scopeOfRef,
} from "@sincpro/client-framework";
import type { Expression } from "@sincpro/criteria";
import { test } from "vitest";

import { VENTAS } from "../support/ventas";

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

test("an entity knows its trash: archive and restore by the record's key, purge over all of it", () => {
  const banners = entity("site:banner", {
    list: "/banners",
    delete: "DELETE /banners/{id}",
    archive: "POST /banners/{id}/archive",
    restore: "POST /banners/{id}/restore",
    purge: "POST /banners/purge",
  });
  assert.deepEqual(banners.archive, { method: "POST", path: "/banners/{id}/archive" });
  assert.deepEqual(banners.restore, { method: "POST", path: "/banners/{id}/restore" });
  assert.deepEqual(banners.purge, { method: "POST", path: "/banners/purge" });
  assert.equal(pathFor(banners.archive!, "b 1"), "/banners/b%201/archive");
  assert.equal(pathFor(banners.restore!, "b1"), "/banners/b1/restore");
  // A purge names no record: its path is the collection's.
  assert.equal(pathFor(banners.purge!), "/banners/purge");
  // None of them is a Command, and an entity without a trash has none of them.
  assert.deepEqual(banners.commands, {});
  const plain = entity("site:page", { list: "/pages" });
  assert.equal(plain.archive, undefined);
  assert.equal(plain.restore, undefined);
  assert.equal(plain.purge, undefined);
  // A route without its method is refused when the entity is declared.
  assert.throws(
    () => entity("site:banner", { list: "/banners", purge: "/banners/purge" }),
    /is not "METHOD \/path"/,
  );
});

type Payment = { id: string; member_id: string; amount: string };
const payments = entity<Payment>("members:payment", { list: "/payments" });

test("a list opened under a cut carries the cut and whose it is, and reads both back", () => {
  const cut = { field: "member_id", operator: "=", value: "m-1" } as const;
  const ref: ResourceRef = payments.listRef(cut, "María");
  // It is the list, never a chooser: no row answers anyone.
  assert.equal(ref.params?.[PICK_PARAM], undefined);
  assert.equal(ref.id, undefined);
  assert.deepEqual(ref, {
    domain: "members",
    kind: "payment",
    params: { [SCOPE_PARAM]: JSON.stringify(cut), [SCOPE_NAME_PARAM]: "María" },
  });
  assert.equal(SCOPE_NAME_PARAM, "of");
  assert.deepEqual(scopeOfRef(ref), cut);
  assert.equal(scopeNameOf(ref), "María");
});

test("a cut without a name says nothing of whose it is", () => {
  const cut = { field: "member_id", operator: "=", value: "m-1" } as const;
  for (const ref of [
    payments.listRef(cut),
    payments.listRef(cut, ""),
    payments.listRef(cut, " "),
  ]) {
    assert.equal(SCOPE_NAME_PARAM in (ref.params ?? {}), false);
    assert.equal(scopeNameOf(ref), undefined);
  }
  assert.equal(scopeNameOf({ params: { [SCOPE_NAME_PARAM]: "" } }), undefined);
  assert.equal(scopeNameOf({}), undefined);
});

test("a typed entity's cut names its fields, and the entity is still an Entity", () => {
  // @ts-expect-error — a cut over a field a payment does not have
  const wrong = payments.listRef({ field: "nope", operator: "=", value: 1 });
  const loose: Entity = payments;
  assert.equal(wrong.kind, "payment");
  assert.equal(loose.listRef({ field: "anything", operator: "=", value: 1 }).kind, "payment");
});
