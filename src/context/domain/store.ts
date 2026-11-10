/**
 * `ContextStore`: where the context lives — the port each platform implements with its own
 * technology, so every use case reads the same context the same way.
 *
 *     store.save("process", { tenant_id: "acme", lang: "es" });
 *     store.load("process")      →  { tenant_id: "acme", lang: "es" }     undefined when never saved
 *     store.version("process")   →  1                                       0 when never saved
 *     store.watch?.("process", () => …)                                     a change anywhere
 *
 * Context: sincpro_framework's `ContextStore` with the same four methods — the process's memory by
 * default, a Redis when a project says so — and one more, optional, a client needs: `watch`, so
 * a screen redraws when the tenant changes. The store never decides what the context is: it keeps
 * values under a key (`process`, `bounded_context:<name>`), and `Context` reads and writes them.
 *
 * One per platform, chosen by the application (`configureProcess({ context })`):
 *
 * - `memoryContexts()` — this package's default, everywhere.
 * - a browser: the same, or one over `sessionStorage` to survive a reload, or over the screens'
 *   own store (Zustand, Redux) so they share one source.
 * - a phone: MMKV (synchronous), or memory hydrated from AsyncStorage at start and written through.
 * - a server that renders: one over `AsyncLocalStorage`, so two requests never see each other's.
 *
 * Reads are synchronous on purpose: a use case reads its context where a gesture starts, and an
 * asynchronous store would make every use case wait for it.
 */

/** What a context holds: plain values, the way JSON carries them to the server. */
export type ContextValues = Readonly<Record<string, unknown>>;

export interface ContextStore {
  /** What `key` holds, or `undefined` when nothing was saved there. */
  load(key: string): ContextValues | undefined;
  /** `values` under `key`, replacing what was there. Each save moves the key's version. */
  save(key: string, values: ContextValues): void;
  /** `key` is gone. Its version moves too. */
  delete(key: string): void;
  /**
   * How many times `key` changed — what a reader compares to know it changed. `load` may answer
   * a new object each time (a store that parses JSON does); the version is what says it is new.
   */
  version(key: string): number;
  /**
   * Calls `listener` whenever `key` changes, from here or from elsewhere (another tab, a native
   * module); answers the way to stop. Optional: without it, only the changes made through this
   * package's `Context` are heard.
   */
  watch?(key: string, listener: () => void): () => void;
}
