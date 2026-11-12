import {
  type Change,
  type ChangeFeed,
  changeOf,
} from "@sincpro/client-framework/client/domain/changes";
import type { Method } from "@sincpro/client-framework/client/domain/transport";

/**
 * A feed in the process's memory: every listener hears every change announced while it follows.
 *
 *     const changes = changeFeed();
 *     const stop = changes.follow((change) => console.log(change.route));
 *
 * Context: one is enough for an application — `processChanges`, which every transport of this
 * package announces to by default —; another is for a test, or a transport that must not be heard.
 * A listener added while a change is being announced hears the next one, not that one.
 */
export function changeFeed(): ChangeFeed {
  const listeners = new Set<(change: Change) => void>();
  return {
    announce(change) {
      for (const listener of [...listeners]) {
        try {
          listener(change);
        } catch {
          // Hearing a write never changes its answer, as tracing and listening never do.
        }
      }
    },
    follow(listener) {
      if (typeof listener !== "function") throw new TypeError("A listener is a function");
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

/**
 * What the process wrote, for whoever keeps what it read: the feed this package's transports
 * (`restTransport`, `memoryTransport`) announce every write to unless told otherwise, and the one
 * a platform's caches and screens follow.
 *
 *     processChanges.follow((change) => …);
 *
 * Context: it lives as long as the process — `configureProcess` does not clear it —, so whoever
 * follows keeps the function that stops it, as with `processListeners`.
 */
export const processChanges: ChangeFeed = changeFeed();

/**
 * `write` — a transport's `send` —, and then its change announced on `feed`, whatever it answered:
 * a refusal may have changed something too (a 409 says someone else did), and a request with no
 * answer may have run. A preview or a dry run announces nothing (`changeOf`).
 *
 *     send: (method, route, body) => announced(changes, method, route, body, () => post(…)),
 */
export async function announced<T>(
  feed: ChangeFeed,
  method: Method,
  route: string,
  body: unknown,
  write: () => Promise<T>,
): Promise<T> {
  try {
    return await write();
  } finally {
    const change = changeOf(method, route, body);
    if (change !== undefined) feed.announce(change);
  }
}
