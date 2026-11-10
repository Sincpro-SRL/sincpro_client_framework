import assert from "node:assert/strict";

import {
  entity,
  memoryTransport,
  readRoute,
  restTransport,
  TransportError,
  type VersionDrift,
} from "@sincpro/client-framework";
import { criteria, plain } from "@sincpro/criteria";
import { test } from "vitest";

type Call = { url: string; headers: Record<string, string> };

function server(status: number, body: unknown, calls: Call[]): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
}

const PAGE = {
  projects: [{ id: "odoo-acme" }],
  cursor: null,
  count: { value: 1, exact: true },
  model_version: "v1",
  dropped: [],
};
test("the criteria joins a route that already has its own query", async () => {
  const calls: Call[] = [];
  const transport = restTransport({ base: "/v1", fetch: server(200, PAGE, calls) });
  await transport.list("/projects?tenant_id=acme", plain(criteria().limit(5)));
  const url = calls[0]?.url ?? "";
  assert.ok(url.startsWith("/v1/projects?tenant_id=acme&criteria="), url);
});

test("the criteria travels as plain JSON — what the framework's REST entrypoint reads", async () => {
  const calls: Call[] = [];
  const transport = restTransport({ fetch: server(200, PAGE, calls) });
  await transport.list("/projects", plain(criteria().selection(["id", "=", "x"])));
  const sent = new URL(calls[0]?.url ?? "", "http://x").searchParams.get("criteria") ?? "";
  assert.deepEqual(JSON.parse(sent).selection, { field: "id", operator: "=", value: "x" });
});

test("the records come out of the field named after them", async () => {
  const transport = restTransport({ fetch: server(200, PAGE, []) });
  const page = await transport.list("/projects", {});
  assert.deepEqual(page.rows, [{ id: "odoo-acme" }]);
});

test("a read of the context's own goes as a GET and comes back as it was answered", async () => {
  const calls: Call[] = [];
  const transport = restTransport({
    base: "/v1",
    fetch: server(200, { id: "u1", roles: ["admin"] }, calls),
  });
  const caller = await readRoute<{ id: string; roles: string[] }>(transport, "/me?scope=all");
  assert.deepEqual(caller, { id: "u1", roles: ["admin"] });
  assert.equal(calls[0]?.url, "/v1/me?scope=all");
});

test("a refused read carries the server's problem, as every other call", async () => {
  const transport = restTransport({
    fetch: server(403, { status: 403, title: "Forbidden", kind: "forbidden" }, []),
  });
  await assert.rejects(readRoute(transport, "/me"), TransportError);
});

test("a transport with no read says so by name, never a TypeError inside a screen", async () => {
  const bare = memoryTransport({});
  await assert.rejects(
    readRoute(bare, "/me"),
    /this transport has no read\(\): it cannot ask GET \/me/,
  );
  const answering = memoryTransport({}, { read: (route) => ({ route }) });
  assert.deepEqual(await readRoute(answering, "/me"), { route: "/me" });
});

test("one record is the answer's own field; the envelope is left out", async () => {
  const answer = { tenant: { id: "acme" }, model_version: "v1", dropped: [], draft: null };
  const transport = restTransport({ fetch: server(200, answer, []) });
  const one = await transport.one(entity("auth:tenant", { list: "/tenants" }).one("acme"));
  assert.deepEqual(one.record, { id: "acme" });
});

test("headers are asked for on every call: a token that rotates", async () => {
  const calls: Call[] = [];
  let token = "a";
  const transport = restTransport({
    fetch: server(200, PAGE, calls),
    headers: () => ({ Authorization: `Bearer ${token}` }),
  });
  await transport.list("/projects", {});
  token = "b";
  await transport.list("/projects", {});
  assert.deepEqual(
    calls.filter((c) => c.url.startsWith("/projects")).map((c) => c.headers["Authorization"]),
    ["Bearer a", "Bearer b"],
  );
});

/** A service with one model, `Project`, published in its discovery document. */
function described(version: string, calls: Call[], served: { document: number }) {
  const contract = {
    type: "object",
    title: "Project",
    properties: {
      id: { type: "string", "x-sincpro": { type: "text", sortable: true, ops: ["="] } },
      name: { type: "string", title: "Name", "x-sincpro": { type: "text", widget: "text" } },
    },
    required: ["name"],
    "x-sincpro": { entity: "Project", identity: "id", version },
  };
  const document = {
    paths: { "/v1/projects": { get: { "x-sincpro-entities": ["Project"] } } },
    components: { schemas: { Project: contract } },
  };
  return (async (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, headers });
    if (url === "/openapi.json") {
      served.document += 1;
      if (headers["If-None-Match"] === `"${version}"`)
        return new Response(null, { status: 304 });
      return new Response(JSON.stringify(document), { headers: { ETag: `"${version}"` } });
    }
    return new Response(JSON.stringify({ ...PAGE, model_version: "v2" }));
  }) as typeof fetch;
}

test("the definition of a model is read once from the discovery document, not from answers", async () => {
  const served = { document: 0 };
  const transport = restTransport({ base: "/v1", fetch: described("v2", [], served) });

  const first = await transport.list("/projects", {});
  const second = await transport.list("/projects", {});

  assert.equal(first.meta?.aggregate, "Project");
  assert.equal(first.meta?.fields["name"]?.required, true);
  assert.equal(second.meta?.aggregate, "Project");
  assert.equal(
    served.document,
    1,
    "read once while the version it holds is the answered one",
  );
});

test("a value a record holds, named once and pointed at, keeps its definition (sincpro_framework #244)", async () => {
  const issue = {
    type: "object",
    title: "Issue",
    properties: {
      id: { type: "string", "x-sincpro": { type: "text" } },
      snapshot: {
        $ref: "#/components/schemas/ProjectSnapshot",
        "x-sincpro": { type: "embedded", widget: "embedded" },
      },
    },
    "x-sincpro": { entity: "Issue", identity: "id", version: "v1" },
  };
  const snapshot = {
    type: "object",
    title: "ProjectSnapshot",
    properties: { host: { type: "string", "x-sincpro": { type: "text" } } },
    "x-sincpro": { entity: "ProjectSnapshot" },
  };
  const document = {
    paths: { "/v1/issues": { get: { "x-sincpro-entities": ["Issue"] } } },
    components: { schemas: { Issue: issue, ProjectSnapshot: snapshot } },
  };
  const transport = restTransport({
    base: "/v1",
    fetch: (async (url: string) =>
      url === "/openapi.json"
        ? new Response(JSON.stringify(document))
        : new Response(
            JSON.stringify({ issues: [], cursor: null, model_version: "v1" }),
          )) as typeof fetch,
  });

  const page = await transport.list("/issues", {});
  // With @sincpro/criteria 1.0.0 the pointed value had no definition: a form drew it blank.
  assert.equal(page.meta?.fields["snapshot"]?.definition?.fields["host"]?.type, "text");
});

test("a server ahead of the snapshot the code came from is told once per model and version", async () => {
  const drifts: VersionDrift[] = [];
  const behind = restTransport({
    base: "/v1",
    fetch: described("v2", [], { document: 0 }),
    snapshot: { Project: "v1" },
    onVersionDrift: (drift) => drifts.push(drift),
  });
  await behind.list("/projects", {});
  await behind.list("/projects", {});
  assert.deepEqual(drifts, [{ model: "Project", snapshot: "v1", live: "v2" }]);

  const current = restTransport({
    base: "/v1",
    fetch: described("v2", [], { document: 0 }),
    snapshot: { Project: "v2" },
    onVersionDrift: (drift) => drifts.push(drift),
  });
  await current.list("/projects", {});
  assert.equal(drifts.length, 1, "a snapshot that matches the server says nothing");
});

test("an answer of another version reads the document again, revalidated by its tag", async () => {
  const calls: Call[] = [];
  const served = { document: 0 };
  const transport = restTransport({ base: "/v1", fetch: described("v1", calls, served) });

  await transport.list("/projects", {});

  assert.equal(served.document, 2, "the answer said v2; the document held v1");
  const again = calls.filter((c) => c.url === "/openapi.json")[1];
  assert.equal(again?.headers["If-None-Match"], '"v1"');
});

test("an entity is domain:kind, and its record lives under its list", () => {
  const invoices = entity("billing:invoice", { list: "/invoices" });
  assert.equal(invoices.one("F 1"), "/invoices/F%201");
  assert.throws(() => entity("invoice", { list: "/invoices" }), /domain:kind/);
});
