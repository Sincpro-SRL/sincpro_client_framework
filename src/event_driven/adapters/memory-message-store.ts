import type {
  MessageStore,
  StoredMessage,
} from "@sincpro/client-framework/event_driven/domain/store";

/** A memory store, and what it holds — in the order added — for whoever inspects it. */
export type MemoryMessageStore = MessageStore & {
  readonly messages: readonly StoredMessage[];
};

/**
 * The messages of a stored queue in this process's memory: what a browser tab or a test keeps.
 * Gone with the process — a phone's store is a table.
 */
export function memoryMessageStore(): MemoryMessageStore {
  const held: StoredMessage[] = [];
  return {
    get messages() {
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
