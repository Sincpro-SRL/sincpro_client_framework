import {
  defineMeta,
  type Draft,
  field,
  type Method,
  TransportError,
} from "@sincpro/client-framework";
import type { AnyRecord } from "@sincpro/criteria";

import { CLIENTES, type Factura, FACTURAS, VENTAS } from "./ventas";

/**
 * The sales service the use cases run against — what a sincpro_framework service does, in
 * memory: a save checks the version it was read at (409 when someone saved first), a Command
 * may be run dry (`dry_run: true` answers what it would do), a `Preview` says what the record
 * becomes, a draft is kept per record with its own version, and every change leaves a business
 * event in `/ventas-events` with its label. The customers speak sincpro_framework's `Edit`, a
 * new one created under the id the client minted.
 *
 * Each call to `servidorVentas()` starts from fresh copies: one story's writes never leak into
 * another's.
 */
export const eventoMeta = defineMeta({
  aggregate: "VentaEvento",
  identity: "id",
  defaultOrder: "-created_at",
  fields: {
    id: field.text({ readonly: true }),
    created_at: field.datetime({ label: "Cuándo" }),
    entity_type: field.text(),
    entity_id: field.text(),
    from_state: field.text({ label: "Antes" }),
    to_state: field.text({ label: "Ahora" }),
    by: field.text({ label: "Quién" }),
  },
});

const ESTADO: Record<Factura["state"], string> = {
  draft: "Borrador",
  posted: "Publicada",
  paid: "Pagada",
  cancelled: "Anulada",
};

const refuse = (route: string, status: number, problem: Record<string, unknown>) =>
  new TransportError(route, status, {
    errors: [],
    extensions: {},
    retryable: false,
    next_step: "fix_request",
    ...problem,
  } as never);

export function servidorVentas() {
  const facturas: Factura[] = structuredClone(FACTURAS);
  const clientes: AnyRecord[] = structuredClone(CLIENTES);
  const eventos: AnyRecord[] = facturas.map((f) => ({
    id: `ev-${f.number}-0`,
    created_at: f.created_at,
    entity_type: "Factura",
    entity_id: f.number,
    label: { default: "Invoice created", es: "Factura creada" },
    by: "ana@sincpro.com.bo",
  }));
  const drafts = new Map<string, Draft>();
  let seq = 0;

  const find = (route: string, number: string) => {
    const found = facturas.find((f) => f.number === number);
    if (found === undefined)
      throw refuse(route, 404, {
        kind: "not_found",
        reason: "AGGREGATE_NOT_FOUND",
        detail: `${number} no existe.`,
      });
    return found;
  };

  const event = (f: Factura, es: string, from?: Factura["state"]) =>
    eventos.push({
      id: `ev-${f.number}-${++seq}`,
      created_at: new Date(Date.UTC(2026, 9, 31, 12, seq)).toISOString(),
      entity_type: "Factura",
      entity_id: f.number,
      label: { default: es, es },
      ...(from === undefined ? {} : { from_state: ESTADO[from], to_state: ESTADO[f.state] }),
      by: "ana@sincpro.com.bo",
    });

  /** A new invoice: the server numbers it, starts it as a draft and answers its identity. */
  function crear(route: string, sent: AnyRecord): unknown {
    const cliente = CLIENTES.find((c) => c.id === sent["customer_id"]);
    if (cliente === undefined)
      throw refuse(route, 422, {
        kind: "invalid",
        reason: "VALIDATION",
        title: "La factura no se creó",
        errors: [{ pointer: "/customer_id", detail: "Elegí un cliente que exista." }],
      });
    const number = `F-2026-${String(facturas.length + 1).padStart(4, "0")}`;
    const f: Factura = {
      number,
      customer_id: cliente.id,
      customer_name: cliente.name,
      customer: { id: cliente.id, name: cliente.name },
      state: "draft",
      invoice_date: String(sent["invoice_date"] ?? "2026-10-31"),
      due_date: null,
      amount_total: "0.00",
      tags: (sent["tags"] as string[] | undefined) ?? [],
      payment: (sent["payment"] as Factura["payment"] | undefined) ?? "cash",
      card_reference: String(sent["card_reference"] ?? ""),
      notes: String(sent["notes"] ?? ""),
      discount: String(sent["discount"] ?? "0"),
      urgent: sent["urgent"] === true,
      lines: { items: [], count: { value: 0, exact: true }, cursor: null },
      created_at: new Date(Date.UTC(2026, 9, 31, 12, ++seq)).toISOString(),
      version: 1,
    };
    facturas.push(f);
    event(f, "Factura creada");
    return { number, version: 1 };
  }

  /**
   * The lines as sincpro_framework computes them: each subtotal from its quantity and price.
   * What the form sent, in its order; a new line still without an id.
   */
  const computed = (lines: readonly AnyRecord[]): AnyRecord[] =>
    lines.map((line) => ({
      ...line,
      subtotal: (Number(line["quantity"] ?? 0) * Number(line["price"] ?? 0)).toFixed(2),
    }));

  /** What the domain says of each line: its states (`items[i]`) and its warnings (`path`). */
  const linesSaid = (lines: readonly AnyRecord[]) => ({
    // A line of 100 or more takes the volume price: the price list sets it, not the form.
    items: lines.map((line) =>
      Number(line["quantity"] ?? 0) >= 100 ? { price: { readonly: true } } : {},
    ),
    advice: lines.flatMap((line, i) =>
      line["price"] !== undefined && line["price"] !== "" && Number(line["price"]) < 1
        ? [{ message: "Precio bajo el costo", field: "lines", path: ["lines", i, "price"] }]
        : [],
    ),
  });

  /** The lines written whole, in order (sincpro_framework): a line names an id the invoice has,
   *  or none — the server mints it. Every wrong cell answers 422 with where it is. */
  function linesWritten(
    route: string,
    f: Factura,
    lines: readonly AnyRecord[],
  ): Factura["lines"] {
    const known = new Set(f.lines.items.map((line) => line.id));
    const errors = lines.flatMap((line, i) => [
      ...(line["id"] !== undefined && !known.has(String(line["id"]))
        ? [
            {
              pointer: `#/values/lines/${i}/id`,
              detail: `La línea ${String(line["id"])} no es de esta factura.`,
            },
          ]
        : []),
      ...(Number(line["quantity"] ?? 0) <= 0
        ? [
            {
              pointer: `#/values/lines/${i}/quantity`,
              detail: "La cantidad tiene que ser mayor a cero.",
            },
          ]
        : []),
    ]);
    if (errors.length > 0)
      throw refuse(route, 422, {
        kind: "invalid",
        reason: "VALIDATION",
        title: "La factura no se guardó",
        errors,
      });
    const items = computed(lines).map((line) => ({
      ...line,
      id: line["id"] === undefined ? `L-${f.number}-n${++seq}` : String(line["id"]),
    })) as unknown as Factura["lines"]["items"];
    f.amount_total = items.reduce((sum, line) => sum + Number(line.subtotal), 0).toFixed(2);
    return { items, count: { value: items.length, exact: true }, cursor: null };
  }

  function stale(route: string, f: Factura) {
    return refuse(route, 409, {
      kind: "conflict",
      reason: "STALE_AGGREGATE",
      title: "Alguien lo guardó antes",
      detail: `${f.number} cambió después de que lo abriste.`,
    });
  }

  /** A save, by whichever door it came: the domain's rules, then the record stored. */
  function guardar(route: string, f: Factura, values: AnyRecord) {
    if (Number(values["discount"] ?? 0) > 50)
      throw refuse(route, 422, {
        kind: "invalid",
        reason: "VALIDATION",
        title: "La factura no se guardó",
        errors: [{ pointer: "/discount", detail: "El descuento no puede pasar del 50 %." }],
      });
    if (
      f.payment === "card" &&
      values["payment"] === undefined &&
      values["card_reference"] === ""
    )
      throw refuse(route, 422, {
        kind: "invalid",
        reason: "VALIDATION",
        errors: [
          { pointer: "/card_reference", detail: "Falta la referencia de la tarjeta." },
        ],
      });
    if (Array.isArray(values["lines"]))
      values["lines"] = linesWritten(route, f, values["lines"] as AnyRecord[]);
    Object.assign(f, values, { version: f.version + 1 });
    drafts.delete(f.number);
    event(f, "Factura editada");
    return { number: f.number, version: f.version };
  }

  /**
   * sincpro_framework's `Edit` over the customers (`PUT /clientes/{id}/edit`): the record named
   * by `id` — the stored one, or a NEW one created under the id the client minted. The values
   * carry what a person writes: a field the framework writes (`id`) is refused, as
   * `apply_values` refuses it; the path and the body name the same record.
   */
  function editarCliente(route: string, id: string, sent: AnyRecord): unknown {
    const values = (sent["values"] ?? {}) as AnyRecord;
    const invalid = (pointer: string, detail: string) =>
      refuse(route, 422, {
        kind: "invalid",
        reason: "INVALID_VALUE",
        errors: [{ pointer, detail }],
      });
    if (sent["id"] !== id)
      throw invalid("#/id", "El cuerpo y la ruta nombran otro registro.");
    if ("id" in values) throw invalid("#/values/id", "Cliente.id lo escribe el framework.");
    const kept = drafts.get(id);
    if (sent["action"] === "discard") {
      drafts.delete(id);
      return { cliente: clientes.find((c) => c["id"] === id) ?? null, draft: null };
    }
    if ((kept?.version ?? 0) !== sent["version"])
      throw refuse(route, 409, {
        kind: "conflict",
        reason: "DRAFT_CONFLICT",
        detail: "Otra pestaña guardó el borrador antes.",
      });
    const stored = clientes.find((c) => c["id"] === id);
    if (sent["action"] === "save") {
      const whole = { ...kept?.values, ...values };
      if (typeof whole["name"] !== "string" || whole["name"].trim() === "")
        throw invalid("#/values/name", "El cliente necesita un nombre.");
      drafts.delete(id);
      if (stored !== undefined) Object.assign(stored, whole);
      else clientes.push({ active: true, ...whole, id });
      return { cliente: { ...clientes.find((c) => c["id"] === id) }, draft: null };
    }
    const next: Draft = { values, version: (kept?.version ?? 0) + 1, origin_version: 0 };
    drafts.set(id, next);
    return {
      cliente: { ...stored, ...values, id },
      draft: { version: next.version, origin_version: next.origin_version },
    };
  }

  function handle(method: Method, route: string, body: unknown): unknown {
    const sent = (body ?? {}) as AnyRecord;
    const [, , number, action] = route.split("/");

    if (method === "PUT" && route.startsWith("/clientes/") && action === "edit")
      return editarCliente(route, decodeURIComponent(number ?? ""), sent);

    if (method === "POST" && route === "/facturas/preview") {
      const values = sent["values"] as AnyRecord;
      const card = values["payment"] === "card";
      const lines = Array.isArray(values["lines"])
        ? computed(values["lines"] as AnyRecord[])
        : undefined;
      const said = lines === undefined ? undefined : linesSaid(lines);
      return {
        values: lines === undefined ? {} : { lines },
        states: {
          card_reference: { required: card, visible: card },
          ...(said === undefined ? {} : { lines: { items: said.items } }),
        },
        warnings: [
          ...(typeof values["notes"] === "string" && values["notes"].length > 80
            ? [
                {
                  field: "notes",
                  path: ["notes"],
                  message: "La nota es larga: va impresa en la factura.",
                },
              ]
            : []),
          ...(said?.advice ?? []),
        ],
      };
    }

    if (method === "POST" && route === "/facturas") return crear(route, sent);

    const f = find(route, decodeURIComponent(number ?? ""));

    // sincpro_framework's `Edit`, `save`: the fields it changed, out of the record whole, stored
    // if nobody moved the record (or its draft) since it was read; the draft is dropped.
    if (method === "PUT" && action === "draft" && sent["action"] === "save") {
      const kept = drafts.get(f.number);
      if ((kept?.version ?? 0) !== sent["version"] || sent["origin_version"] !== f.version)
        throw stale(route, f);
      const values = sent["values"] as AnyRecord;
      const changed = sent["changed"] as string[];
      return guardar(
        route,
        f,
        Object.fromEntries(changed.filter((k) => k in values).map((k) => [k, values[k]])),
      );
    }

    // `discard`: the draft dropped; the stored record stays as it was.
    if (method === "PUT" && action === "draft" && sent["action"] === "discard") {
      drafts.delete(f.number);
      return { factura: { ...f }, draft: null };
    }

    // sincpro_framework's `Edit` (save_draft): the record as the form holds it, the fields it
    // changed, the draft version it read; answers the record and the draft it is now.
    if (method === "PUT" && action === "draft") {
      const kept = drafts.get(f.number);
      if ((kept?.version ?? 0) !== sent["version"])
        throw refuse(route, 409, {
          kind: "conflict",
          reason: "DRAFT_CONFLICT",
          detail: "Otra pestaña guardó el borrador antes.",
        });
      const values = sent["values"] as AnyRecord;
      const changed = new Set(sent["changed"] as string[]);
      const next: Draft = {
        values: Object.fromEntries(Object.entries(values).filter(([k]) => changed.has(k))),
        version: (kept?.version ?? 0) + 1,
        origin_version: Number(sent["origin_version"] ?? f.version),
      };
      drafts.set(f.number, next);
      return {
        factura: { ...f, ...next.values },
        draft: { version: next.version, origin_version: next.origin_version },
      };
    }

    if (method === "PUT" && action === undefined) {
      if (sent["version"] !== f.version) throw stale(route, f);
      const { version: _, ...values } = sent;
      return guardar(route, f, values);
    }

    if (method === "POST" && action === "confirm") {
      if (f.state !== "draft")
        throw refuse(route, 422, {
          kind: "domain",
          reason: "NOT_DRAFT",
          title: "Ya está confirmada",
          detail: `${f.number} está ${ESTADO[f.state].toLowerCase()}.`,
        });
      const from = f.state;
      f.state = "posted";
      f.version += 1;
      event(f, "Factura confirmada", from);
      return { number: f.number, state: f.state };
    }

    if (method === "POST" && action === "cancel") {
      if (sent["dry_run"] === true)
        return {
          text: `${f.number} queda anulada: su total de Bs. ${f.amount_total} sale del libro de ventas. La factura y su historial se conservan.`,
          data: { number: f.number, amount_total: f.amount_total },
        };
      const from = f.state;
      f.state = "cancelled";
      f.version += 1;
      event(f, "Factura anulada", from);
      return { number: f.number, state: f.state };
    }

    throw refuse(route, 404, {
      kind: "not_found",
      reason: "ROUTE_NOT_FOUND",
      detail: `Nada contesta ${method} ${route}.`,
    });
  }

  return {
    tables: {
      ...VENTAS,
      "/clientes": { meta: VENTAS["/clientes"].meta, rows: clientes },
      "/facturas": { meta: VENTAS["/facturas"].meta, rows: facturas },
      "/ventas-events": { meta: eventoMeta, rows: eventos },
    },
    handle,
    draft: (route: string) =>
      drafts.get(decodeURIComponent(route.split("/")[2] ?? "")) ?? null,
    /** Someone else saves it: what makes the next save from a screen a conflict. */
    alguienGuarda: (number: string) => {
      const f = facturas.find((one) => one.number === number);
      if (f) f.version += 1;
    },
    keepDraft: (number: string, values: AnyRecord) =>
      drafts.set(number, { values, version: 1, origin_version: 1 }),
  };
}
