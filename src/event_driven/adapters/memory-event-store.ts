import type {
  EventStore,
  StoredEvent,
} from "@sincpro/client-framework/event_driven/domain/store";

/** A memory store, and what it holds — in the order added — for whoever inspects it. */
export type MemoryEventStore = EventStore & { readonly events: readonly StoredEvent[] };

/**
 * The events of a stored queue in this process's memory: what a browser tab or a test keeps.
 * Gone with the process — a phone's store is a table.
 */
export function memoryEventStore(): MemoryEventStore {
  const held: StoredEvent[] = [];
  return {
    get events() {
      return [...held];
    },
    add(stored) {
      held.push(stored);
    },
    next(skip) {
      return held.find((one) => one.state === "pending" && !skip.has(one.envelope.id));
    },
    save(stored) {
      const at = held.findIndex((one) => one.envelope.id === stored.envelope.id);
      if (at >= 0) held[at] = stored;
    },
  };
}
