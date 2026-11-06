import type { ContextStore, ContextValues } from "@sincpro/client-framework/context/store";

/**
 * One level of the context: the process's (`processContext`) or a bounded context's
 * (`project.context`), read and written the same way on every platform.
 *
 *     processContext.set({ tenant_id: "acme" });      the company changed — every screen hears it
 *     processContext.get("tenant_id")                  →  "acme"
 *     project.context.set({ warehouse_id: 4 });        only what `project` runs
 *     const stop = processContext.watch(() => redraw());
 *
 * Context: sincpro_framework reads its context from a tree — the process, the bounded context,
 * the scope, the execution — and the nearest wins. A client has the same levels: a use case runs
 * with the process's values, under them its bounded context's, under them a scope's
 * (`project.scoped({...})`), read once where the gesture starts and inherited by every Feature
 * it runs. That snapshot is `this.context` and what travels to the server in `sincpro-context`.
 *
 * Where the values live is the platform's (`ContextStore`): this is only the door. `values` is
 * the same object until something changes it, so a screen can hand it straight to React's
 * `useSyncExternalStore`, and `watch` is bound — pass it as it is.
 */
export type Context<C extends object = ContextValues> = {
  /** Its values now: the same object until they change. Never change it — `set` does. */
  readonly values: Readonly<Partial<C>>;
  get<K extends keyof C & string>(name: K): C[K] | undefined;
  /** Adds or replaces these names; the others stay. */
  set(values: Partial<C>): void;
  /** Removes these names — every name when none is given. */
  clear(...names: (keyof C & string)[]): void;
  /** Calls `listener` whenever its values change; answers the way to stop. */
  watch(listener: () => void): () => void;
};

/**
 * Where a level finds its store: the one in use now, and word when another replaces it — the
 * process's, which `configureProcess` may change after a screen started listening.
 */
export type StoreSource = {
  current(): ContextStore;
  replaced(listener: () => void): () => void;
};

const NOTHING: ContextValues = {};

/**
 * The level saved under `key` in whatever store `source` holds now — asked again on every call,
 * so a store the process configures after this level was made is the one used, and whoever
 * listens moves to it and hears the change.
 */
export function contextAt<C extends object = ContextValues>(
  key: string,
  source: StoreSource,
): Context<C> {
  const storeOf = () => source.current();
  // The values last read, by store and version: a store that answers a new object on every
  // `load` still gives one object per change.
  let seen: { store: ContextStore; version: number; values: ContextValues } | undefined;
  // Who listens when the store cannot say it changed (`watch` is optional).
  const listeners = new Set<() => void>();

  const read = (): ContextValues => {
    const store = storeOf();
    const version = store.version(key);
    if (seen?.store !== store || seen.version !== version)
      seen = { store, version, values: store.load(key) ?? NOTHING };
    return seen.values;
  };
  const write = (values: ContextValues | undefined) => {
    const store = storeOf();
    if (values === undefined) store.delete(key);
    else store.save(key, values);
    if (store.watch === undefined) for (const listener of [...listeners]) listener();
  };

  return {
    get values() {
      return read() as Readonly<Partial<C>>;
    },
    get: (name) => read()[name] as C[typeof name] | undefined,
    set: (values) => write({ ...read(), ...values }),
    clear(...names) {
      if (names.length === 0) return write(undefined);
      const kept: Record<string, unknown> = { ...read() };
      for (const name of names) delete kept[name];
      write(kept);
    },
    watch(listener) {
      let watching: ContextStore | undefined;
      let unwatch: (() => void) | undefined;
      const follow = () => {
        const store = storeOf();
        if (store === watching) return;
        unwatch?.();
        watching = store;
        unwatch = store.watch?.(key, listener);
      };
      follow();
      listeners.add(listener);
      // Another store is other values: listen to it, and say so.
      const unreplaced = source.replaced(() => {
        follow();
        listener();
      });
      return () => {
        unwatch?.();
        unreplaced();
        listeners.delete(listener);
      };
    },
  };
}
