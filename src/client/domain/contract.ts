import { type Contract, type Meta, metaFromContract } from "@sincpro/criteria";

/**
 * A bounded context's client contract, as the application keeps it: the snapshot
 * `sincpro-client generate` writes (`contract.json`), or the document a service serves
 * (`GET /client-contract/<context>.json`). Its models are read here, and its events when it
 * carries them.
 *
 * Context: the generated entities are keyed `<domain>:<kind>` (`project:issue`) — the key the
 * workspace refers to them by and the meta store keeps their definitions under —, so the rule
 * that turns a model's name into its kind lives once, here, and both the generator and the
 * preload read it.
 */
export type ClientContract = {
  models: Readonly<Record<string, Contract>>;
  $defs?: Readonly<Record<string, Contract>>;
  /** Its domain events by wire name, when it was exported with them (`--events`). */
  events?: Readonly<Record<string, { schema: Contract }>>;
};

/** `ProjectEvent` → `project_event`: the kind in an entity's key. */
export function kindOf(model: string): string {
  return model
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

/** The key of a model's entity: `entityKeyOf("project", "ProjectEvent")` → `"project:project_event"`. */
export function entityKeyOf(domain: string, model: string): string {
  return `${domain}:${kindOf(model)}`;
}

/**
 * The version of every entity of `contract`, by its model's name — what `restTransport`
 * compares each answer with (`snapshot`) to say when the generated code is behind the server.
 *
 *     restTransport({ base: "/v1", snapshot: versionsOf(contract), onVersionDrift: warn })
 */
export function versionsOf(contract: ClientContract): Record<string, string> {
  return Object.fromEntries(
    Object.entries(contract.models).flatMap(([name, model]) => {
      const version = model["x-sincpro"]?.version;
      return model["x-sincpro"]?.identity != null && typeof version === "string"
        ? [[name, version]]
        : [];
    }),
  );
}

/** What a definition points at by name (`#/models/Run`): a related model, a value it holds. */
function relatedOf(contract: ClientContract): Record<string, Contract> {
  return { ...(contract.$defs ?? {}), ...contract.models };
}

/**
 * The definition of every model of `contract`, by its entity's key — what `FrameworkProvider
 * metas` preloads, so the first screen draws its labels with no request at all. The transport
 * still reads the live definition and asks again when an answer says another version.
 *
 *     <FrameworkProvider transport={transport} metas={metasOf(contract, "project")}>
 */
export function metasOf(contract: ClientContract, domain: string): Record<string, Meta> {
  const related = relatedOf(contract);
  return Object.fromEntries(
    Object.entries(contract.models)
      // Only an entity has a key of its own; a value it holds is described inside it.
      .filter(([, model]) => model["x-sincpro"]?.identity != null)
      .map(([name, model]) => [entityKeyOf(domain, name), metaFromContract(model, related)]),
  );
}

/**
 * The definition of every domain event of `contract`, by its wire name: what each field it
 * carries is called, for a history to draw it. Empty for a contract exported without its events.
 *
 *     labelOf(eventMetasOf(contract)["desk.ticket.v1.closed"], "reason", "es")   -> "Motivo"
 *
 * Context: what one occurrence says — what happened, the record, who — travels in the event
 * itself (`label`, `entity_display`, `actor`), in the words of its day. The words of its fields
 * are the contract's, as sincpro_framework publishes them since 3.37.1.
 */
export function eventMetasOf(contract: ClientContract): Record<string, Meta> {
  const related = relatedOf(contract);
  return Object.fromEntries(
    Object.entries(contract.events ?? {}).map(([name, event]) => [
      name,
      metaFromContract(event.schema, related),
    ]),
  );
}
