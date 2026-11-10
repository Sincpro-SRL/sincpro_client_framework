import { defineMeta, entity, field } from "@sincpro/client-framework";

/**
 * A sales domain DECLARED BY HAND — no sincpro_framework behind it. The same thing an app does
 * for a backend that sends no model definition, or before its server exists: write the meta
 * once, with the words a person reads, and every list and record below reads it like one the
 * server sent.
 *
 * The rows are made up but shaped the way sincpro_framework answers: a many2one comes expanded
 * as the record it points at, a one2many as a PAGE of its own (`{items, count, cursor}`).
 */

export type Cliente = {
  id: string;
  name: string;
  tax_id: string;
  city: string;
  credit_limit: string;
  active: boolean;
};

export type Linea = {
  id: string;
  product: string;
  quantity: number;
  price: string;
  subtotal: string;
};

export type Factura = {
  number: string;
  customer_id: string;
  customer_name: string;
  customer: Pick<Cliente, "id" | "name">;
  state: "draft" | "posted" | "paid" | "cancelled";
  invoice_date: string;
  due_date: string | null;
  amount_total: string;
  tags: string[];
  payment: "cash" | "card";
  card_reference: string;
  notes: string;
  discount: string;
  urgent: boolean;
  lines: { items: Linea[]; count: { value: number; exact: boolean }; cursor: string | null };
  created_at: string;
  version: number;
};

export const clienteMeta = defineMeta({
  aggregate: "Cliente",
  identity: "id",
  display: "name",
  name: { default: "Clientes" },
  search: ["name", "tax_id"],
  defaultOrder: "name",
  fields: {
    id: field.text({ label: "Código", readonly: true }),
    name: field.text({ label: "Nombre", required: true }),
    tax_id: field.text({ label: "NIT" }),
    city: field.text({ label: "Ciudad" }),
    credit_limit: field.number({ label: "Límite de crédito", exact: true }),
    active: field.boolean({ label: "Activo" }),
    // The customer's invoices: the related aggregate's key that points back here.
    invoices: field.one2many(
      "Factura",
      { identifiedBy: "customer_id" },
      { label: "Facturas" },
    ),
  },
});

export const lineaMeta = defineMeta({
  aggregate: "LineaFactura",
  identity: "id",
  display: "product",
  name: { default: "Líneas" },
  fields: {
    id: field.text({ label: "Línea", readonly: true }),
    product: field.text({ label: "Producto" }),
    quantity: field.integer({ label: "Cantidad" }),
    price: field.number({ label: "Precio", exact: true }),
    subtotal: field.number({ label: "Subtotal", exact: true, readonly: true }),
  },
});

export const facturaMeta = defineMeta({
  aggregate: "Factura",
  identity: "number",
  display: "number",
  name: { default: "Facturas" },
  search: ["number", "customer_name"],
  defaultOrder: "-invoice_date",
  fields: {
    number: field.text({ label: "Número", readonly: true }),
    customer_id: field.text({ label: "Cliente (código)", required: true }),
    // Published by the server beside the relation: criteria compares an aggregate's OWN
    // fields, so «search invoices by the customer's name» needs the name here.
    customer_name: field.text({ label: "Nombre del cliente" }),
    customer: field.many2one(
      "Cliente",
      { identifiedBy: "customer_id", definition: clienteMeta },
      { label: "Cliente" },
    ),
    state: field.choice(["draft", "posted", "paid", "cancelled"], {
      label: "Estado",
      readonly: true,
      default: "draft",
      labels: {
        draft: "Borrador",
        posted: "Publicada",
        paid: "Pagada",
        cancelled: "Anulada",
      },
    }),
    invoice_date: field.date({ label: "Fecha" }),
    due_date: field.date({ label: "Vence", nullable: true }),
    amount_total: field.number({ label: "Total", exact: true, readonly: true }),
    tags: field.tags({ label: "Etiquetas" }),
    payment: field.choice(["cash", "card"], {
      label: "Forma de pago",
      default: "cash",
      labels: { cash: "Efectivo", card: "Tarjeta" },
      readonlyWhen: { field: "state", operator: "!=", value: "draft" },
    }),
    // Required and shown only when paid by card — the hint the server publishes, evaluated over
    // what is on screen.
    card_reference: field.text({
      label: "Referencia de la tarjeta",
      requiredWhen: { field: "payment", operator: "=", value: "card" },
      visibleWhen: { field: "payment", operator: "=", value: "card" },
    }),
    notes: field.text({ label: "Nota" }),
    discount: field.number({ label: "Descuento %", exact: true, default: "0" }),
    urgent: field.boolean({ label: "Urgente", default: false }),
    lines: field.one2many(
      "LineaFactura",
      { identifiedBy: "invoice_number", definition: lineaMeta },
      { label: "Líneas" },
    ),
    created_at: field.datetime({ label: "Creada", readonly: true }),
    version: field.integer({ label: "Versión", readonly: true }),
  },
});

export const clientes = entity<Cliente>("ventas:cliente", { list: "/clientes" });
export const facturas = entity<Factura>("ventas:factura", {
  list: "/facturas",
  create: "POST /facturas",
  save: "PUT /facturas/{id}",
  preview: "POST /facturas/preview",
  draft: "PUT /facturas/{id}/draft",
  commands: {
    confirmar: "POST /facturas/{id}/confirm",
    anular: "POST /facturas/{id}/cancel",
  },
  history: "/facturas/{id}/events",
});

const CIUDADES = ["Santa Cruz", "La Paz", "Cochabamba", "Sucre", "Tarija"];
const NOMBRES = [
  "Importadora del Oriente",
  "Clínica San Gabriel",
  "Ferretería El Progreso",
  "Globex Bolivia",
  "Agroindustrial Chiquitano",
  "Farmacorp Norte",
  "Constructora Andina",
  "Lácteos del Valle",
];
const PRODUCTOS = [
  "Cemento 50 kg",
  "Fierro 12 mm",
  "Pintura látex",
  "Cable 2.5 mm",
  "Tubo PVC",
];
const ESTADOS: Factura["state"][] = [
  "draft",
  "posted",
  "paid",
  "paid",
  "posted",
  "cancelled",
];

export const CLIENTES: Cliente[] = NOMBRES.map((name, i) => ({
  id: `C-${String(i + 1).padStart(3, "0")}`,
  name,
  tax_id: String(1020304000 + i * 7919),
  city: CIUDADES[i % CIUDADES.length] ?? "Santa Cruz",
  credit_limit: (25000 + i * 12500).toFixed(2),
  active: i % 5 !== 4,
}));

function lineasDe(n: number, seed: number): Linea[] {
  return Array.from({ length: n }, (_, i) => {
    const quantity = 1 + ((seed + i * 3) % 9);
    const price = 35 + ((seed * 7 + i * 13) % 400);
    return {
      id: `L-${seed}-${i + 1}`,
      product: PRODUCTOS[(seed + i) % PRODUCTOS.length] ?? "Producto",
      quantity,
      price: price.toFixed(2),
      subtotal: (quantity * price).toFixed(2),
    };
  });
}

/** One invoice has 120 lines and the server sends the first 20: the partial page case. */
export const FACTURA_GRANDE = "F-2026-0007";

export const FACTURAS: Factura[] = Array.from({ length: 64 }, (_, i) => {
  const number = `F-2026-${String(i + 1).padStart(4, "0")}`;
  const cliente = CLIENTES[i % CLIENTES.length] ?? CLIENTES[0]!;
  const total = number === FACTURA_GRANDE ? 120 : 1 + (i % 4);
  const all = lineasDe(total, i + 1);
  const shown = all.slice(0, 20);
  const day = 1 + (i % 28);
  const month = 1 + (Math.floor(i / 7) % 10);
  const date = `2026-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const state = ESTADOS[i % ESTADOS.length] ?? "draft";
  return {
    number,
    customer_id: cliente.id,
    customer_name: cliente.name,
    customer: { id: cliente.id, name: cliente.name },
    state,
    invoice_date: date,
    due_date:
      state === "draft"
        ? null
        : `2026-${String(Math.min(month + 1, 12)).padStart(2, "0")}-15`,
    amount_total: all.reduce((sum, l) => sum + Number(l.subtotal), 0).toFixed(2),
    tags: i % 3 === 0 ? ["exportación"] : i % 5 === 0 ? ["urgente", "mayorista"] : [],
    payment: i % 4 === 0 ? "card" : "cash",
    card_reference: i % 4 === 0 ? `VISA-${4000 + i}` : "",
    notes: "",
    discount: "0",
    urgent: i % 9 === 0,
    lines: {
      items: shown,
      count: { value: all.length, exact: true },
      cursor: all.length > shown.length ? "c2hvd246MjA" : null,
    },
    created_at: `${date}T14:${String(10 + (i % 40)).padStart(2, "0")}:00Z`,
    version: 1 + (i % 3),
  };
});

export const VENTAS = {
  "/clientes": { meta: clienteMeta, rows: CLIENTES },
  "/facturas": { meta: facturaMeta, rows: FACTURAS },
};
