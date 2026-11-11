import { failureOf } from "@sincpro/client-framework/common/failures";
import { type JsonValue, valuesOf } from "@sincpro/client-framework/common/serialization";
import type { DomainEvent, RemoteEvent } from "@sincpro/client-framework/core/domain/dto";
import type { Envelope } from "@sincpro/client-framework/event_driven/domain/envelope";
import type {
  EventQueue,
  EventType,
  Subscribes,
} from "@sincpro/client-framework/event_driven/domain/queue";
import type {
  DeliveryFailure,
  EventStore,
  StoredEvent,
} from "@sincpro/client-framework/event_driven/domain/store";
import { eventFrom } from "@sincpro/client-framework/event_driven/services/messages";
import { loggerAdapter } from "@sincpro/client-framework/observability/services/logging";

export type StoredQueueOptions = {
  /** Where the events wait: memory, a phone's SQLite, a browser's IndexedDB. */
  readonly store: EventStore;
  /** Who executes them: every bounded context that hears each one. */
  readonly subscriber: Subscribes;
  /**
   * How a stored payload becomes its class again. By default, `static fromJSON` when the class
   * has one, else its values set on an instance of it — as JSON gave them: an event that carries
   * a `Money`, a `Decimal` or a date declares `fromJSON` to read them back as such.
   */
  readonly rebuild?: (type: EventType, payload: JsonValue) => DomainEvent | RemoteEvent;
  /**
   * Whether an event may be delivered now — a phone asks for a connection, or a session. One
   * that is not waits while the rest go on; `drain()` again when what it waits for comes back.
   */
  readonly ready?: (stored: StoredEvent) => boolean | Promise<boolean>;
  /** The first wait after a failed attempt, in ms (1 s); doubled each time, never past `longestWait`. */
  readonly wait?: number;
  /** The longest wait between attempts, in ms (one minute). */
  readonly longestWait?: number;
  /**
   * How many attempts an event gets before it is set aside although a retry might still fix it
   * (10): a bug of this process (`internal`) or a dependency gone for good must not hold the line
   * forever. `Infinity` keeps trying.
   */
  readonly maxAttempts?: number;
  /** Told each time an event settles — delivered, set aside, or waiting to retry —: a screen's activity. */
  readonly onSettled?: (stored: StoredEvent) => void;
};

/** A stored queue, and the door to deliver what waits — on a timer, back online, in the foreground. */
export type StoredQueue = EventQueue & { drain(): Promise<void> };

function described(boundedContext: string, error: unknown): DeliveryFailure {
  const failure = failureOf(error);
  return {
    boundedContext,
    kind: failure.kind,
    reason: failure.reason,
    message: error instanceof Error ? error.message : String(error),
  };
}

/**
 * The queue that stores an event before delivering it, and delivers it until every bounded
 * context that hears it has it — the backend's store-and-forward (`Forwarding`), over a store
 * each platform plugs.
 *
 *     const queue = storedQueue({ store: sqliteEventStore(db), subscriber, ready: online });
 *     shopBoundedContext.addDependency("publisher", new Publisher(queue));
 *     connectivity.onBack(() => queue.drain());
 *
 * Context: what a phone did by hand in its event bus, the same on every platform. `publish`
 * returns once the event is stored — nobody waits for the delivery. Then, one at a time and in
 * the order stored:
 *
 * 1. An event not ready (`ready`) waits while the rest go on.
 * 2. Nobody hears its name: delivered — a fact recorded, nobody's to act on.
 * 3. Rebuilt as its class; one that cannot be is set aside.
 * 4. Executed in every bounded context that hears it and does not have it yet (`reached`).
 * 5. A failure every attempt would repeat (`PERMANENT_KINDS`: a refusal, invalid, not found) sets
 *    that context aside; any other is tried again after the backoff — or what the failure asks
 *    for (`retryAfter`, an open circuit's time left) —, and what comes after waits, so the
 *    order holds; after `maxAttempts`, it is set aside too.
 * Final: delivered when every context has it, set aside — the dead-letter queue — when one
 *    refused it for good or ran out of attempts; `onSettled` hears either.
 *
 * Delivery is at least once: a process that stops after a context executed an event and before
 * the store saved it executes it there again on the next drain. What must not act twice keys what
 * it does by the envelope's id — `this.execution.causationId` in the use case of the event — or
 * by the entity the event names.
 * And one process drains a store: two tabs over one IndexedDB claim it first (the Web Locks API).
 */
export function storedQueue(options: StoredQueueOptions): StoredQueue {
  const { store, subscriber } = options;
  const firstWait = options.wait ?? 1000;
  const longestWait = options.longestWait ?? 60_000;
  const maxAttempts = options.maxAttempts ?? 10;
  if (!(maxAttempts >= 1)) throw new TypeError("A stored queue needs one attempt at least");
  const rebuild = options.rebuild ?? eventFrom;
  let draining: Promise<void> | undefined;
  let again = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const settle = async (stored: StoredEvent) => {
    await store.save(stored);
    try {
      options.onSettled?.(stored);
    } catch {
      // Telling a screen never changes a delivery.
    }
  };

  const wakeAt = (at: number) => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(
      () => {
        timer = undefined;
        void queue.drain();
      },
      Math.max(0, at - Date.now()),
    );
    // A timer of its own must not keep a process alive that has nothing else to do.
    (timer as { unref?: () => void }).unref?.();
  };

  /** One pass over what waits; it stops at an event that must wait its turn. */
  const pass = async () => {
    const skip = new Set<string>();
    for (;;) {
      const head = await store.next(skip);
      if (head === undefined) return;
      const id = head.envelope.id;
      if (head.retryAt !== null && Date.parse(head.retryAt) > Date.now()) {
        wakeAt(Date.parse(head.retryAt));
        return;
      }
      if (options.ready && !(await options.ready(head))) {
        skip.add(id);
        continue;
      }
      const attempts = head.attempts + 1;
      const type = subscriber.eventTypeOf(head.envelope.name);
      if (type === undefined) {
        await settle({ ...head, state: "delivered", attempts, retryAt: null, failures: [] });
        continue;
      }
      let event: DomainEvent | RemoteEvent;
      try {
        event = rebuild(type, head.payload);
      } catch (error) {
        await settle({
          ...head,
          state: "set_aside",
          attempts,
          retryAt: null,
          failures: [described("", error)],
        });
        continue;
      }
      const handled = await subscriber.handle(event, head.envelope, head.reached);
      const reached = [...head.reached];
      const failures: DeliveryFailure[] = [];
      let retryAfter = 0;
      let repeat = false;
      for (const one of handled) {
        if (!("error" in one)) {
          reached.push(one.boundedContext);
          continue;
        }
        failures.push(described(one.boundedContext, one.error));
        const failure = failureOf(one.error);
        if (failure.permanent) reached.push(one.boundedContext);
        else {
          repeat = true;
          retryAfter = Math.max(retryAfter, (failure.retryAfter ?? 0) * 1000);
        }
      }
      if (repeat && attempts < maxAttempts) {
        const backoff = Math.min(longestWait, firstWait * 2 ** (attempts - 1));
        const at = Date.now() + Math.max(backoff, retryAfter);
        await settle({
          ...head,
          state: "pending",
          attempts,
          retryAt: new Date(at).toISOString(),
          reached,
          failures,
        });
        wakeAt(at);
        return;
      }
      await settle({
        ...head,
        state: failures.length === 0 ? "delivered" : "set_aside",
        attempts,
        retryAt: null,
        reached,
        failures,
      });
    }
  };

  const queue: StoredQueue = {
    async put(event: DomainEvent | RemoteEvent, envelope: Envelope) {
      await store.add({
        envelope,
        payload: valuesOf(event),
        state: "pending",
        attempts: 0,
        retryAt: null,
        reached: [],
        failures: [],
      });
      queue.drain().catch((error: unknown) =>
        loggerAdapter.error("The stored queue could not deliver", {
          reason: failureOf(error).reason,
        }),
      );
    },
    drain() {
      if (draining !== undefined) {
        again = true;
        return draining;
      }
      draining = (async () => {
        try {
          do {
            again = false;
            await pass();
          } while (again);
        } finally {
          draining = undefined;
        }
      })();
      return draining;
    },
  };
  return queue;
}
