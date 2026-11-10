import { memoryContexts } from "@sincpro/client-framework/context/adapters/memory";
import type { ContextStore } from "@sincpro/client-framework/context/domain/store";
import {
  type Context,
  contextAt,
  type StoreSource,
} from "@sincpro/client-framework/context/entrypoint/context";

/**
 * Where this process keeps its context: the store `configureProcess` chose (`memoryContexts()`
 * until it chooses), read on every call, never at import.
 *
 * Context: a level made before `main` configures the process (`project` is defined when its
 * module loads) still reads the store chosen later; whoever listens moves to the new store and
 * hears the change.
 */
let current: ContextStore = memoryContexts();
const replacing = new Set<() => void>();

/** @internal — `configureProcess` is the way in. */
export function replaceProcessStore(store: ContextStore): void {
  const before = current;
  current = store;
  if (current !== before) for (const listener of [...replacing]) listener();
}

/** The process's store as every level of the context reads it — the process's and each bounded context's. */
export const processStore: StoreSource = {
  current: () => current,
  replaced(listener) {
    replacing.add(listener);
    return () => void replacing.delete(listener);
  },
};

/**
 * The process's level of the context: what every use case of every bounded context runs with —
 * the tenant, the company, the language.
 *
 *     processContext.set({ tenant_id: "acme" });
 */
export const processContext: Context = contextAt("process", processStore);
