import type { Method } from "@sincpro/client-framework/client/domain/transport";
import {
  type AnyRecord,
  type Criteria,
  type Expression,
  readExpression,
} from "@sincpro/criteria";

/**
 * The parts any record may have beside its name: what a link, a card or a record's header says
 * about it, whatever the entity.
 */
export type SummaryPart =
  | "description"
  | "state"
  | "type"
  | "image"
  | "createdAt"
  | "createdBy"
  | "updatedAt"
  | "updatedBy";

/**
 * Which field of the entity plays each part, when it is not the conventional one. `person`: its
 * records are people or companies.
 *
 * Context: declared once with the rest of the entity (`entity(…, { summary })`) because it is
 * what the entity IS, not how one screen draws it; how a platform reads a record's summary from
 * it is the platform's.
 */
export type SummaryFields = Partial<Record<SummaryPart, string>> & { person?: boolean };

/**
 * What each Command of an entity is sent with, by its name: `{ send: { message: string } }`.
 *
 * Context: the default is any name and any body — every entity declared before Commands had
 * types keeps compiling. A typed entity is still one of these (`Entity<T, C>` is assignable to
 * `Entity<T>`), so every piece that takes an entity takes it.
 */
export type CommandBodies = Readonly<Record<string, AnyRecord>>;

/**
 * What each Command of an entity answers, by its name: `{ send: { run_id: string } }` — what a
 * generated entity reads off each operation's `output`.
 *
 * Context: `useCommand(issues, "send").run(…)` returns it with no type argument written; a
 * Command it does not name answers `unknown`, as every Command did before.
 */
export type CommandAnswers = Readonly<Record<string, unknown>>;

/**
 * Everything a screen needs to know about where an entity lives on the server, declared once.
 *
 * Context: a screen should not know a URL. It names the entity, and the entity says where its
 * list is, where one record is, which Commands it takes, how it is saved and previewed, where a
 * draft is kept and where its history is. `key` is how the workspace refers to it
 * (`domain:kind`, the shape of a composer `ResourceRef`).
 *
 * The routes are declared, not guessed: sincpro_framework publishes a route per use case and
 * its model definition does not list them (yet). A route is `"METHOD /path/{id}"` for a write.
 *
 *     export const invoices = entity<Invoice>("billing:invoice", {
 *       list: "/invoices",
 *       create: "POST /invoices",
 *       save: "PUT /invoices/{id}",
 *       preview: "POST /invoices/preview",
 *       commands: { confirm: "POST /invoices/{id}/confirm", cancel: "POST /invoices/{id}/cancel" },
 *       history: "/invoices/{id}/events",
 *     });
 *
 * Its Commands may be typed too — what each one is sent with, by name (`CommandBodies`), and
 * what each one answers (`CommandAnswers`) — and then `useCommand` and `CommandButton` take
 * only those names and those bodies, and give back that answer:
 *
 *     entity<Issue, { send: { message: string } }, { send: { run_id: string } }>(…)
 */
export type Entity<
  T extends AnyRecord = AnyRecord,
  C extends CommandBodies = CommandBodies,
  A extends CommandAnswers = CommandAnswers,
> = {
  /** `domain:kind`, e.g. `"billing:invoice"`. */
  key: string;
  domain: string;
  kind: string;
  /** Where the workspace finds it: the list without an id, one record with it — the shape of a
   *  composer `ResourceRef`, built here so no screen writes `{ domain, kind, id }` by hand. */
  ref: (id?: string) => EntityRef;
  /** A record that does not exist yet — the form that creates one. Its view is the record's.
   *  With `values`, the form starts with them over the model's defaults: an invoice created
   *  from its customer starts with that customer (`startingValuesOf`). */
  newRef: (values?: AnyRecord) => EntityRef;
  /** Its list opened to CHOOSE one: a row answers whoever asked (composer's `api.pick`). With
   *  `query`, the list opens on that literal search — what was typed in the picker; with
   *  `scope`, it offers only what the picker may choose (`scopeOfRef`). */
  chooserRef: (query?: string, scope?: Expression) => EntityRef;
  /** The route of its list. */
  list: string;
  /** The route of one record. */
  one: (id: string) => string;
  /** Its Commands, by name. */
  commands: Readonly<Record<keyof C & string, WriteRoute>>;
  /** How a new record is created: the list's own route, usually. */
  create?: WriteRoute;
  /** How an edit is saved: the record's own route with `{id}`. */
  save?: WriteRoute;
  /** «What does this record become?» before saving — sincpro_framework's `Preview`. */
  preview?: WriteRoute;
  /** Where this caller keeps an edit between requests — sincpro_framework's `Drafts`. */
  draft?: WriteRoute;
  /** sincpro_framework's `Edit`: ONE route that keeps the draft, saves and discards, by its
   *  `action`. Declared, a save sends the record whole as the form holds it — not the fields
   *  that changed under `save` — and it is also where the draft is kept. */
  edit?: WriteRoute;
  /** Its business events: where ONE record's events are read (sincpro_framework's
   *  `DomainEvents`), `{id}` where its key goes — a page of them, as a list answers. */
  history?: string;
  /** Every record of a criteria as a file: the route `exportRoute` fills, `downloadRoute` asks. */
  export?: string;
  /** Which fields are its description, state, picture… when they are not the conventional
   *  ones (`summaryOf`). Empty: the convention decides. */
  summary: SummaryFields;
  /** The aggregate it is, as a relation of another model names it (`relation: "Cliente"`).
   *  Without it, the `aggregate` of its model definition, once known. */
  aggregate?: string;
  /** Only carries the record type; never read. */
  readonly _record?: T;
  /** Only carries what each Command is sent with; never read. */
  readonly _commands?: C;
  /** Only carries what each Command answers; never read. */
  readonly _answers?: A;
};

/** A composer `ResourceRef`, structurally: `core/` does not import the composer. */
export type EntityRef = {
  domain: string;
  kind: string;
  id?: string;
  params?: Readonly<Record<string, string>>;
};

/**
 * The params that say what a reference without an id is for: `new` is the form of a record
 * that does not exist yet, `pick` is the list opened to choose one. Params, because they are
 * what a composer reference carries and survives a reload with.
 */
export const NEW_PARAM = "new";
export const PICK_PARAM = "pick";
/** What was typed where the chooser was asked for: its list opens on that search. */
export const QUERY_PARAM = "q";
/** The list a record was opened from (its `Trail`): «3 / 64» and the arrows to its neighbours. */
export const TRAIL_PARAM = "from";
/** What a new record starts with, as JSON: one param keeps each value's type (a number stays
 *  a number), where a param per field would turn all of them into text. */
export const WITH_PARAM = "with";
/** What a chooser may offer at all, as JSON: the picker's cut — its criteria, the keys it
 *  excludes, its named list's scope — that the list it opens ANDs under everything. */
export const SCOPE_PARAM = "scope";

/**
 * What a new record's reference says it starts with (`newRef(values)`), or nothing.
 *
 * Context: a reference survives a reload and a link, so its params can be anything a person
 * typed in the address bar — a value that is not a JSON object is not a start, never an error.
 */
export function startingValuesOf(ref: Pick<EntityRef, "params">): AnyRecord {
  const written = ref.params?.[WITH_PARAM];
  if (written === undefined) return {};
  try {
    const read: unknown = JSON.parse(written);
    return read !== null && typeof read === "object" && !Array.isArray(read)
      ? (read as AnyRecord)
      : {};
  } catch {
    return {};
  }
}

/**
 * The cut a chooser's reference carries (`chooserRef(query, scope)`), or nothing.
 *
 * Context: a picker that may offer only some records — the contacts of the chosen customer, the
 * tenants a project is not shared with yet — opened the workspace's chooser on the WHOLE
 * entity, and offered the rest. The cut travels in the reference, so it survives a reload; read
 * from an address bar it is untyped, so it is read the way criteria reads a filter from outside
 * (`readExpression`), and one that does not read is no cut, never an error. It narrows what is
 * OFFERED; the server still decides what may be stored.
 */
export function scopeOfRef(ref: Pick<EntityRef, "params">): Expression | undefined {
  const written = ref.params?.[SCOPE_PARAM];
  if (written === undefined) return undefined;
  try {
    return readExpression(JSON.parse(written));
  } catch {
    return undefined;
  }
}

/**
 * A write: its method and its path, `{id}` where the record's key goes. A Command may also say
 * which field of its body names the record it runs on (`target`: `issue_id`), and then the
 * record's id is written there when it is sent (`bodyFor`).
 */
export type WriteRoute = { method: Method; path: string; target?: string };

/**
 * A Command's route: `"POST /invoices/{id}/confirm"`, or, when its body names the record —
 * sincpro_framework's `targets`, what a generated entity declares —, the route and that field:
 * `{ route: "POST /issues", target: "project_id" }`.
 */
export type CommandRoute = string | { route: string; target: string };

/** Each Command's route, by name. Typed Commands MUST each have their route — a name a screen
 *  may run with nowhere to send it is caught here, not on the click. */
type CommandRoutes<C extends CommandBodies> = string extends keyof C
  ? { commands?: Readonly<Record<string, CommandRoute>> }
  : { commands: Readonly<Record<keyof C & string, CommandRoute>> };

export type EntityRoutes<C extends CommandBodies = CommandBodies> = CommandRoutes<C> & {
  list: string;
  /** With `{id}` where the key goes. Without it, `<list>/<id>` — sincpro_framework's convention. */
  one?: string;
  /** `"POST /invoices"`: where a new record goes. */
  create?: string;
  save?: string;
  preview?: string;
  draft?: string;
  /** `"PUT /invoices/{id}/edit"`: the use case that answers sincpro_framework's `Edit`. */
  edit?: string;
  /** `"/invoices/{id}/events"`: a record's events (`DomainEvents[Invoice, …]`), oldest first. */
  history?: string;
  /** `"/invoices/export"`: every record of a criteria as a file (`Export[Invoice, Streamed]`),
   *  asked through `exportRoute` and `downloadRoute`. */
  export?: string;
  /** `{ image: "logo", state: "estado_pago", person: true }` — not a route, but declared once
   *  with the rest of what a screen should not have to know. */
  summary?: SummaryFields;
  /** `"Cliente"`: what a many2one of another model calls it, so a form resolves it alone. */
  aggregate?: string;
};

const METHODS = new Set<Method>(["POST", "PUT", "PATCH", "DELETE"]);

/** `"POST /invoices/{id}/confirm"` → its method and path. A write without a method is a bug. */
export function writeRoute(text: string): WriteRoute {
  const [method, path] = text.trim().split(/\s+/, 2);
  if (!METHODS.has(method as Method) || path === undefined)
    throw new Error(`"${text}" is not "METHOD /path": a write says how it is sent`);
  return { method: method as Method, path };
}

const PATH_KEY = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * The path with the record's key in place of `{id}`, and every other `{name}` taken from the
 * body's field of that name: `POST /projects/{id}/shares/{tenant_id}/revoke` with
 * `{ tenant_id: "acme" }`.
 *
 * Context: sincpro_framework reads a path parameter as a field of the use case's DTO (its
 * wire merges `{...body, ...path_params}`), so the body already names every key a route
 * needs — a second argument for them would say the same thing twice. A key the body lacks is
 * the screen's bug, said before anything is sent. Without an `id`, `{id}` stays: a create or a
 * preview of a new record has none.
 */
export function pathFor(route: WriteRoute, id?: string, body?: AnyRecord): string {
  return route.path.replace(PATH_KEY, (whole, name: string) => {
    if (name === "id") return id === undefined ? whole : encodeURIComponent(id);
    const value = body?.[name];
    if (value === undefined || value === null || value === "")
      throw new Error(`"${route.method} ${route.path}" needs "${name}" in the body`);
    return encodeURIComponent(String(value));
  });
}

/**
 * What a Command of a record is sent with: the body as given, and — when its route says which
 * field names the record (`target`) — the record's id in that field.
 *
 *     bodyFor({ method: "POST", path: "/issues", target: "project_id" }, "p1", { title: "x" })
 *       ->  { title: "x", project_id: "p1" }
 *
 * Context: sincpro_framework says, per operation, which input field holds the key of each
 * entity it runs on (`targets`). A path that carries it (`/issues/{issue_id}/messages`) and a
 * body that carries it (`POST /issues` with `project_id`) are the same thing to the server — a
 * path parameter is read as a field of the DTO — so it goes in the body, and `pathFor` takes it
 * from there. Without an id (a Command that creates) the body is sent as it is.
 */
export function bodyFor(
  route: WriteRoute,
  id: string | undefined,
  body: AnyRecord,
): AnyRecord {
  if (route.target === undefined || id === undefined || id === "") return body;
  return { ...body, [route.target]: id };
}

/** A Command's route as declared: a `"METHOD /path"`, or that and the field naming its record. */
function commandRoute(declared: CommandRoute): WriteRoute {
  if (typeof declared === "string") return writeRoute(declared);
  return { ...writeRoute(declared.route), target: declared.target };
}

/**
 * A list's route with its own parameters: `{ tenant_id: "acme" }` → `/projects?tenant_id=acme`.
 * An empty value is no parameter — a filter left blank. A list under a record names its key in
 * the path (`/tenants/{tenant_id}/members`): that parameter fills it, and only the rest goes in
 * the query.
 *
 * Context: sincpro_framework reads a path parameter as a field of the search's DTO, the same
 * field a query parameter would fill, so the screen gives them all as one set of parameters. A
 * key the path needs and the parameters lack is the screen's bug, said before anything is sent.
 */
export function listRoute(list: string, params?: Readonly<Record<string, string>>): string {
  const given = params ?? {};
  const placed = new Set<string>();
  const path = list.replace(PATH_KEY, (_whole, name: string) => {
    const value = given[name];
    if (value === undefined || value === "")
      throw new Error(`the list "${list}" needs "${name}" in its parameters`);
    placed.add(name);
    return encodeURIComponent(value);
  });
  const query = new URLSearchParams(
    Object.entries(given).filter(([name, value]) => value !== "" && !placed.has(name)),
  ).toString();
  if (query === "") return path;
  return `${path}${path.includes("?") ? "&" : "?"}${query}`;
}

/** What an export is written as: Parquet, an Arrow IPC stream, or JSON Lines. */
export type ExportFormat = "parquet" | "arrow" | "jsonl";

/**
 * The route of an export: its path, its keys filled from `params`, the criteria and the format as
 * its query — what `downloadRoute` asks.
 *
 *     exportRoute("/invoices/export", { selection: { field: "paid", operator: "=", value: false } }, "jsonl")
 *       -> "/invoices/export?criteria=%7B…%7D&format=jsonl"
 */
export function exportRoute<T>(
  path: string,
  criteria?: Criteria<T>,
  format?: ExportFormat,
  params?: Readonly<Record<string, string>>,
): string {
  return listRoute(path, {
    ...params,
    ...(criteria === undefined ? {} : { criteria: JSON.stringify(criteria) }),
    ...(format === undefined ? {} : { format }),
  });
}

export function entity<
  T extends AnyRecord = AnyRecord,
  C extends CommandBodies = CommandBodies,
  A extends CommandAnswers = CommandAnswers,
>(key: string, routes: EntityRoutes<C>): Entity<T, C, A> {
  if (!/^[^:\s]+:[^:\s]+$/.test(key))
    throw new Error(`entity key "${key}" is not domain:kind`);
  const list = routes.list.split("?")[0] ?? routes.list;
  const template = routes.one ?? `${list}/{id}`;
  const [domain = "", kind = ""] = key.split(":");
  return {
    key,
    domain,
    kind,
    ref: (id) => ({ domain, kind, ...(id === undefined || id === "" ? {} : { id }) }),
    newRef: (values) => ({
      domain,
      kind,
      params: {
        [NEW_PARAM]: "1",
        ...(values === undefined || Object.keys(values).length === 0
          ? {}
          : { [WITH_PARAM]: JSON.stringify(values) }),
      },
    }),
    chooserRef: (query, scope) => ({
      domain,
      kind,
      params: {
        [PICK_PARAM]: "1",
        ...(query === undefined || query.trim() === ""
          ? {}
          : { [QUERY_PARAM]: query.trim() }),
        ...(scope === undefined ? {} : { [SCOPE_PARAM]: JSON.stringify(scope) }),
      },
    }),
    list: routes.list,
    one: (id) => template.replace("{id}", encodeURIComponent(id)),
    // Built from exactly the names `routes.commands` was typed with.
    commands: Object.fromEntries(
      Object.entries<CommandRoute>(routes.commands ?? {}).map(([name, declared]) => [
        name,
        commandRoute(declared),
      ]),
    ) as Record<keyof C & string, WriteRoute>,
    ...(routes.create === undefined ? {} : { create: writeRoute(routes.create) }),
    ...(routes.save === undefined ? {} : { save: writeRoute(routes.save) }),
    ...(routes.preview === undefined ? {} : { preview: writeRoute(routes.preview) }),
    ...(routes.draft === undefined ? {} : { draft: writeRoute(routes.draft) }),
    ...(routes.edit === undefined ? {} : { edit: writeRoute(routes.edit) }),
    ...(routes.history === undefined ? {} : { history: routes.history }),
    ...(routes.export === undefined ? {} : { export: routes.export }),
    summary: routes.summary ?? {},
    ...(routes.aggregate === undefined ? {} : { aggregate: routes.aggregate }),
  };
}
