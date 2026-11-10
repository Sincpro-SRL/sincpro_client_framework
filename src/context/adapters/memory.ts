import type {
  ContextStore,
  ContextValues,
} from "@sincpro/client-framework/context/domain/store";

/**
 * The context in this process's memory: the default, on every platform. A test gets a fresh one
 * from `configureProcess()`.
 */
export function memoryContexts(): ContextStore {
  const held = new Map<string, ContextValues>();
  const versions = new Map<string, number>();
  const listeners = new Map<string, Set<() => void>>();

  const changed = (key: string) => {
    versions.set(key, (versions.get(key) ?? 0) + 1);
    for (const listener of [...(listeners.get(key) ?? [])]) listener();
  };

  return {
    load: (key) => held.get(key),
    save(key, values) {
      // A copy: whoever handed the values may keep changing their object.
      held.set(key, { ...values });
      changed(key);
    },
    delete(key) {
      if (!held.delete(key)) return;
      changed(key);
    },
    version: (key) => versions.get(key) ?? 0,
    watch(key, listener) {
      const own = listeners.get(key) ?? new Set();
      listeners.set(key, own);
      own.add(listener);
      return () => void own.delete(listener);
    },
  };
}
