/**
 * A record of any bounded context, named by one text — sincpro_framework's `EntityRef`:
 * `billing.Invoice:01a1e6f2c0b37a4e9b1d2c3e4f5a6b7c`.
 *
 *     parseEntityRef("billing.Invoice:F:7")   ->  { boundedContext: "billing", entity: "Invoice", key: "F:7" }
 *     entityRefOf({ boundedContext: "billing", entity: "Invoice", key: "F:7" })   ->  "billing.Invoice:F:7"
 *     isEntityRef("Invoice:F:7")              ->  false: no bounded context
 *
 * Context: what travels in a payload that comes back later — a payment's metadata, a webhook, a
 * notification — says which record it is about this way, and whoever receives it reads the
 * record by its own `Get` (the backend's `Resolve`, an operation of whichever bounded context
 * publishes it) without knowing its route. On the wire a ref is always its text, published as
 * `{"type": "string", "format": "entity-ref"}`, so here it is a text too, typed by its form: the
 * generator types a field of that format as `EntityRef`, a literal in the form type-checks, and
 * any other string is read with `parseEntityRef` or checked with `isEntityRef` first. The bounded
 * context and the entity are named as a `Reference` names a relation (`auth.Tenant`) — the
 * entity by its class's name, never a workspace's `kind` —, and the key is the one its `Get`
 * finds it by.
 *
 * The rule is the backend's `EntityRef.parse`: the key is everything after the FIRST `:` (a key
 * may hold one), the entity what follows the LAST `.` before it (a bounded context may hold one),
 * and none of the three empty. The entity is checked as the contract's `pattern` publishes it
 * (`[A-Za-z_][A-Za-z0-9_]*`), so a ref the client accepts is one the published schema accepts.
 */
export type EntityRef = `${string}.${string}:${string}`;

/** What a ref names: its bounded context, its entity — the class's name — and its key. */
export type EntityRefParts = {
  readonly boundedContext: string;
  readonly entity: string;
  readonly key: string;
};

/** How a ref is written, as a refusal names it — the backend's `FORMAT`. */
const FORMAT = "bounded_context.Entity:key";
/** An entity's name, as the contract's `pattern` publishes it. */
const ENTITY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The parts `text` writes, or `undefined` when it is no ref. */
function partsOf(text: string): EntityRefParts | undefined {
  const colon = text.indexOf(":");
  if (colon < 0) return undefined;
  const named = text.slice(0, colon);
  const key = text.slice(colon + 1);
  const dot = named.lastIndexOf(".");
  if (dot < 0) return undefined;
  const boundedContext = named.slice(0, dot);
  const entity = named.slice(dot + 1);
  if (boundedContext === "" || !ENTITY.test(entity) || key === "") return undefined;
  return { boundedContext, entity, key };
}

/**
 * What a ref names — refused when `text` is not one, as the backend refuses it (a `422` on a DTO
 * field).
 *
 *     parseEntityRef("billing.Invoice:0192…")   ->  { boundedContext: "billing", entity: "Invoice", key: "0192…" }
 *     parseEntityRef("Invoice:0192…")           ->  throws: no bounded context
 */
export function parseEntityRef(text: string): EntityRefParts {
  const parts = partsOf(text);
  if (parts === undefined)
    throw new Error(`${JSON.stringify(text)} is no entity ref: write ${FORMAT}`);
  return parts;
}

/** Whether `value` is a text in a ref's form — what a string read from outside is checked with. */
export function isEntityRef(value: unknown): value is EntityRef {
  return typeof value === "string" && partsOf(value) !== undefined;
}

/**
 * The text of a ref — the backend's `str(ref)`: `<bounded context>.<Entity>:<key>`. Refused when
 * the parts would not read back as themselves: a bounded context holding a `:`, an entity that is
 * not a name, an empty part.
 *
 *     entityRefOf({ boundedContext: "billing", entity: "Invoice", key: "0192…" })   ->  "billing.Invoice:0192…"
 */
export function entityRefOf(parts: EntityRefParts): EntityRef {
  const text = `${parts.boundedContext}.${parts.entity}:${parts.key}`;
  const read = partsOf(text);
  if (
    read === undefined ||
    read.boundedContext !== parts.boundedContext ||
    read.entity !== parts.entity ||
    read.key !== parts.key
  )
    throw new Error(
      `${JSON.stringify(parts)} writes no entity ref: ${FORMAT}, the bounded context without «:» ` +
        "and the entity a name",
    );
  return text as EntityRef;
}
