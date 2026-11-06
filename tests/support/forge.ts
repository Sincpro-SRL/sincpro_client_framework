import { entity } from "@sincpro/client-framework";
import type { Meta } from "@sincpro/criteria";

/**
 * forge's `Tenant` EXACTLY as sincpro_framework 3.27 described it — copied from `GET /v1/tenants`
 * of a running forge (the bulky `detail` and `resolvers` left out).
 *
 * Context: it is here to keep us honest. forge declares no labels, so every word a screen shows
 * is the field's own name («display_name»): what "render from the metadata" gives TODAY for a
 * service that has not filled it in. The rows are made up.
 */
export const tenantMeta: Meta = {
  aggregate: "Tenant",
  identity: "id",
  default_order: "-created_at",
  get_id: "id",
  display: "display_name",
  search: {
    selection: {
      field: "display_name",
      value: {
        $: "param",
        name: "text",
      },
      operator: "like",
    },
  },
  name: {
    default: "Tenant",
  },
  fields: {
    id: {
      type: "text",
      nullable: false,
      choices: [],
      choice_labels: {},
      exact: false,
      label: {},
      help: {},
      readonly: true,
      required: false,
      default: null,
      readonly_when: null,
      required_when: null,
      visible_when: null,
      sortable: true,
      groupable: true,
      aggregates: ["min", "max", "count", "count_distinct"],
      computed: false,
      owner: null,
      ops: ["=", "!=", "like", "starts with", "in", "not in"],
      many: false,
      relation: null,
      identified_by: null,
      parent_field: null,
      related_field: null,
      kind: "scalar",
    },
    created_at: {
      type: "datetime",
      nullable: false,
      choices: [],
      choice_labels: {},
      exact: false,
      label: {},
      help: {},
      readonly: true,
      required: false,
      default: null,
      readonly_when: null,
      required_when: null,
      visible_when: null,
      sortable: true,
      groupable: true,
      aggregates: ["min", "max", "count", "count_distinct"],
      computed: false,
      owner: null,
      ops: ["=", "!=", ">", ">=", "<", "<=", "between"],
      many: false,
      relation: null,
      identified_by: null,
      parent_field: null,
      related_field: null,
      kind: "scalar",
    },
    updated_at: {
      type: "datetime",
      nullable: true,
      choices: [],
      choice_labels: {},
      exact: false,
      label: {},
      help: {},
      readonly: true,
      required: false,
      default: null,
      readonly_when: null,
      required_when: null,
      visible_when: null,
      sortable: false,
      groupable: true,
      aggregates: ["min", "max", "count", "count_distinct"],
      computed: false,
      owner: null,
      ops: ["=", "!=", ">", ">=", "<", "<=", "between", "is null"],
      many: false,
      relation: null,
      identified_by: null,
      parent_field: null,
      related_field: null,
      kind: "scalar",
    },
    version: {
      type: "integer",
      nullable: false,
      choices: [],
      choice_labels: {},
      exact: false,
      label: {},
      help: {},
      readonly: true,
      required: false,
      default: 0,
      readonly_when: null,
      required_when: null,
      visible_when: null,
      sortable: true,
      groupable: true,
      aggregates: [
        "sum",
        "avg",
        "min",
        "max",
        "count",
        "count_distinct",
        "percentile",
        "median",
      ],
      computed: false,
      owner: null,
      ops: ["=", "!=", ">", ">=", "<", "<=", "between", "in", "not in"],
      many: false,
      relation: null,
      identified_by: null,
      parent_field: null,
      related_field: null,
      kind: "scalar",
    },
    display_name: {
      type: "text",
      nullable: false,
      choices: [],
      choice_labels: {},
      exact: false,
      label: {},
      help: {},
      readonly: false,
      required: true,
      default: "",
      readonly_when: null,
      required_when: null,
      visible_when: null,
      sortable: true,
      groupable: true,
      aggregates: ["min", "max", "count", "count_distinct"],
      computed: false,
      owner: null,
      ops: ["=", "!=", "like", "starts with", "in", "not in"],
      many: false,
      relation: null,
      identified_by: null,
      parent_field: null,
      related_field: null,
      kind: "scalar",
    },
    active: {
      type: "boolean",
      nullable: false,
      choices: [],
      choice_labels: {},
      exact: false,
      label: {},
      help: {},
      readonly: false,
      required: false,
      default: true,
      readonly_when: null,
      required_when: null,
      visible_when: null,
      sortable: true,
      groupable: true,
      aggregates: ["bool_and", "bool_or", "count"],
      computed: false,
      owner: null,
      ops: ["="],
      many: false,
      relation: null,
      identified_by: null,
      parent_field: null,
      related_field: null,
      kind: "scalar",
    },
    members: {
      type: "one2many",
      nullable: false,
      choices: [],
      choice_labels: {},
      exact: false,
      label: {},
      help: {},
      readonly: false,
      required: false,
      default: null,
      readonly_when: null,
      required_when: null,
      visible_when: null,
      sortable: false,
      groupable: false,
      aggregates: [],
      computed: false,
      owner: null,
      ops: [],
      many: true,
      relation: "Membership",
      identified_by: "tenant_id",
      parent_field: "id",
      related_field: "tenant_id",
      kind: "relation",
    },
    groups: {
      type: "one2many",
      nullable: false,
      choices: [],
      choice_labels: {},
      exact: false,
      label: {},
      help: {},
      readonly: false,
      required: false,
      default: null,
      readonly_when: null,
      required_when: null,
      visible_when: null,
      sortable: false,
      groupable: false,
      aggregates: [],
      computed: false,
      owner: null,
      ops: [],
      many: true,
      relation: "Group",
      identified_by: "tenant_id",
      parent_field: "id",
      related_field: "tenant_id",
      kind: "relation",
    },
  },
};

export type Tenant = {
  id: string;
  display_name: string;
  active: boolean;
  created_at: string;
  updated_at: string | null;
  version: number;
  members: {
    items: { id: string; tenant_id: string; email: string; role: string }[];
    count: { value: number; exact: boolean };
    cursor: string | null;
  };
  groups: {
    items: { id: string; display_name: string }[];
    count: { value: number; exact: boolean };
    cursor: string | null;
  };
};

export const tenants = entity<Tenant>("auth:tenant", { list: "/tenants" });

const NOMBRES = [
  "ACME Bolivia",
  "Odoo Ñandú S.R.L.",
  "Cooperativa Las Brisas",
  "Clínica Norte",
  "Logística Andina",
];

export const TENANTS: Tenant[] = NOMBRES.map((name, i) => ({
  id: name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, ""),
  display_name: name,
  active: i !== 3,
  created_at: `2026-0${1 + i}-1${i}T10:00:00Z`,
  updated_at: null,
  version: 1,
  members: {
    items: [
      { id: `m-${i}`, tenant_id: `t-${i}`, email: `admin@tenant${i}.bo`, role: "owner" },
    ],
    count: { value: 1 + i * 3, exact: true },
    cursor: null,
  },
  groups: { items: [], count: { value: 0, exact: true }, cursor: null },
}));

export const FORGE = { "/tenants": { meta: tenantMeta, rows: TENANTS } };
