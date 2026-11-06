import type { ContextValues } from "@sincpro/client-framework/context/store";

/**
 * How a context is written to text and read back: what a `ContextStore` that persists uses
 * (`sessionStorage`, MMKV), and what travels to the server in `sincpro-context`.
 *
 *     plainCodec.dumps({ tenant_id: "acme", company_id: 2, session: socket })
 *       →  '{"tenant_id":"acme","company_id":2}'
 *     plainCodec.loads('{"tenant_id":"acme"}')   →  { tenant_id: "acme" }
 *
 * Context: sincpro_framework's `ContextCodec`, and its `PlainCodec` — the one for anything outside
 * the codebase: another language, a browser, a phone. Only the travelling values go — text,
 * numbers, booleans, `null`, and lists of them; an object, a function or a connection held in the
 * context stays where it is. Reading never fails a context whole: text that is not a JSON object
 * reads as an empty one. A project with a schema of its own writes its own codec over this port.
 */
/** The header the context travels in: the one sincpro_framework's entrances read. */
export const CONTEXT_HEADER = "sincpro-context";

export interface ContextCodec {
  dumps(values: ContextValues): string;
  loads(text: string): ContextValues;
}

function isPlain(value: unknown): boolean {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

/** Whether a value travels: a plain value, or a list of them. */
export function travels(value: unknown): boolean {
  return isPlain(value) || (Array.isArray(value) && value.every(isPlain));
}

/** The values of `context` that travel; the rest stays in this process. */
export function travelling(context: ContextValues): ContextValues {
  return Object.fromEntries(Object.entries(context).filter(([, value]) => travels(value)));
}

export const plainCodec: ContextCodec = {
  dumps: (values) => JSON.stringify(travelling(values)),
  loads(text) {
    try {
      const found: unknown = JSON.parse(text);
      return found !== null && typeof found === "object" && !Array.isArray(found)
        ? (found as ContextValues)
        : {};
    } catch {
      return {};
    }
  },
};
