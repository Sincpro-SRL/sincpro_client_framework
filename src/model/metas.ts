import type { Meta } from "@sincpro/criteria";

/**
 * The model definitions already known, by entity key (`"billing:invoice"`).
 *
 * Context: sincpro_framework publishes each model once, in the discovery document the
 * transport reads (`core/discovery`); an answer carries only its version. This keeps the
 * definitions ACROSS readings, so the second list of the same entity, the record opened from it
 * and the select that points at it draw their labels before the rows arrive.
 *
 * Seeded, it is the preload: definitions written at build time (a snapshot of the server's,
 * or `defineMeta`) reach the first screen with no request at all.
 */
export type MetaStore = {
  get(key: string): Meta | undefined;
  set(key: string, meta: Meta): void;
};

export function metaStore(seed: Readonly<Record<string, Meta>> = {}): MetaStore {
  const known = new Map<string, Meta>(Object.entries(seed));
  return {
    get: (key) => known.get(key),
    set: (key, meta) => void known.set(key, meta),
  };
}
