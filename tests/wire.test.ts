import assert from "node:assert/strict";

import { pathFor, restTransport, TransportError } from "@sincpro/client-framework";
import { criteria, plain } from "@sincpro/criteria";
import { test } from "vitest";

import { restServer } from "./support/rest";
import { servidorVentas } from "./support/servidor";
import { facturas } from "./support/ventas";

function wire() {
  const servidor = servidorVentas();
  const server = restServer(servidor);
  return {
    servidor,
    server,
    transport: restTransport({ base: server.base, fetch: server.fetch }),
  };
}

test("a list travels as sincpro_framework's envelope, criteria as JSON in the query", async () => {
  const { server, transport } = wire();
  const page = await transport.list("/facturas", plain(criteria().limit(5)));
  assert.equal(page.rows.length, 5);
  assert.equal(page.meta?.aggregate, "Factura");
  assert.equal(page.count?.value, 64);
  assert.match(server.calls[0]!.url, /^\/v1\/facturas\?criteria=%7B/);
});

test("a record comes under its own name, with the draft this caller kept", async () => {
  const { servidor, transport } = wire();
  servidor.keepDraft("F-2026-0007", { notes: "Llamar" });
  const one = await transport.one<{ number: string }>(facturas.one("F-2026-0007"));
  assert.equal(one.record.number, "F-2026-0007");
  assert.deepEqual(one.draft?.values, { notes: "Llamar" });
});

test("a refusal comes as problem+json and is read back as the same problem", async () => {
  const { transport } = wire();
  const save = facturas.save!;
  await assert.rejects(
    transport.send(save.method, pathFor(save, "F-2026-0007"), { discount: "80", version: 1 }),
    (error: unknown) => {
      assert.ok(error instanceof TransportError);
      assert.equal(error.status, 422);
      assert.deepEqual(error.problem?.errors, [
        { pointer: "/discount", detail: "El descuento no puede pasar del 50 %." },
      ]);
      return true;
    },
  );
});

test("a Command goes as a POST with its JSON body, dry run included", async () => {
  const { server, transport } = wire();
  const cancel = facturas.commands["anular"]!;
  const answer = await transport.send<{ text: string }>(
    cancel.method,
    pathFor(cancel, "F-2026-0002"),
    {
      dry_run: true,
    },
  );
  assert.match(answer.text, /queda anulada/);
  assert.deepEqual(server.calls.at(-1), {
    method: "POST",
    url: "/v1/facturas/F-2026-0002/cancel",
    body: { dry_run: true },
  });
});
