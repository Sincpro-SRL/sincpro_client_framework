import { failureOf } from "@sincpro/client-framework/common/failures";
import { type JsonValue, valuesOf } from "@sincpro/client-framework/common/serialization";
import type {
  AnyCommand,
  DomainEvent,
  RemoteCommand,
  RemoteEvent,
} from "@sincpro/client-framework/core/domain/dto";
import type { Envelope } from "@sincpro/client-framework/event_driven/domain/envelope";
import type {
  CommandType,
  EventType,
  Handled,
  MessageQueue,
  Subscribes,
} from "@sincpro/client-framework/event_driven/domain/queue";
import type {
  DeliveryFailure,
  MessageKind,
  MessageStore,
  StoredMessage,
} from "@sincpro/client-framework/event_driven/domain/store";
import {
  DEFAULT_DELIVERY_POLICY,
  type DeliveryPolicy,
  type FullDeliveryPolicy,
  type Verdict,
  verdictOf,
} from "@sincpro/client-framework/event_driven/domain/verdict";
import {
  commandFrom,
  eventFrom,
} from "@sincpro/client-framework/event_driven/services/messages";
import { loggerAdapter } from "@sincpro/client-framework/observability/services/logging";

export type StoredQueueOptions = {
  /** Where the messages wait: memory, a phone's SQLite, a browser's IndexedDB. */
  readonly store: MessageStore;
  /** Who executes them: every bounded context that hears an event; the bus that consumes a Command. */
  readonly subscriber: Subscribes;
  /**
   * How a stored event becomes its class again. By default, `static fromJSON` when the class has
   * one, else its values set on an instance of it — as JSON gave them: an event that carries a
   * `Money`, a `Decimal` or a date declares `fromJSON` to read them back as such.
   */
  readonly rebuild?: (type: EventType, payload: JsonValue) => DomainEvent | RemoteEvent;
  /** How a stored Command becomes its class again; `commandFrom` by default. */
  readonly rebuildCommand?: (
    type: CommandType,
    payload: JsonValue,
  ) => AnyCommand | RemoteCommand;
  /**
   * Whether a message may be delivered now — a phone asks for a connection, or a session. One
   * that is not waits while the rest go on; `drain()` again when what it waits for comes back.
   */
  readonly ready?: (stored: StoredMessage) => boolean | Promise<boolean>;
  /** The queue's policy, over `DEFAULT_DELIVERY_POLICY`: 0 retries, no limit to waiting. */
  readonly policy?: DeliveryPolicy;
  /**
   * One message's policy, over the queue's — what its class declares, what the application set
   * for its name: a platform reads it its own way.
   */
  readonly policyOf?: (stored: StoredMessage) => DeliveryPolicy | undefined;
  /**
   * The verdict on each delivery — `verdictOf` by default. A platform extends the rules by
   * wrapping it (the phone's "the connection dropped: wait for it"), never by changing the queue.
   */
  readonly verdict?: (delivery: Parameters<typeof verdictOf>[0]) => Verdict;
  /** The first wait before a message is sent again, in ms (1 s); doubled each time, never past `longestWait`. */
  readonly wait?: number;
  /** The longest wait between sends, in ms (one minute). */
  readonly longestWait?: number;
  /** Told each time a message settles — delivered, set aside, or waiting —: a screen follows it. */
  readonly onSettled?: (stored: StoredMessage) => void;
};

/** A stored queue, and the door to deliver what waits — on a timer, back online, in the foreground. */
export type StoredQueue = MessageQueue & { drain(): Promise<void> };

function described(boundedContext: string, error: unknown): DeliveryFailure {
  const failure = failureOf(error);
  return {
    boundedContext,
    kind: failure.kind,
    reason: failure.reason,
    message: error instanceof Error ? error.message : String(error),
  };
}

/** `policy` over `base`, rule by rule: what it does not say, `base` says. */
function over(
  base: FullDeliveryPolicy,
  policy: DeliveryPolicy | undefined,
): FullDeliveryPolicy {
  return {
    retries: policy?.retries ?? base.retries,
    maxAttempts: policy?.maxAttempts ?? base.maxAttempts,
    requiresNetwork: policy?.requiresNetwork ?? base.requiresNetwork,
  };
}

/** What one delivery ran into: each consumer's answer or failure, or why it could not run. */
type Ran = { readonly handled: readonly Handled[]; readonly answer: JsonValue | null };

/**
 * The queue that stores a message before delivering it — an event until every bounded context
 * that hears it has it, a Command until the bus that consumes it answered — the backend's
 * store-and-forward (`Forwarding`), over a store each platform plugs.
 *
 *     const queue = storedQueue({ store: sqliteMessageStore(db), subscriber, ready: online });
 *     shopBoundedContext.addDependency("publisher", new Publisher(queue));
 *     connectivity.onBack(() => queue.drain());
 *
 * Context: `publish` and `send` return once the message is stored — nobody waits for the
 * delivery. Then, one at a time and in the order stored:
 *
 * 1. A message waiting its time (`retryAt`), or not ready (`ready`), waits while the rest go on.
 * 2. An event nobody hears is delivered — a fact recorded, nobody's to act on —; a Command
 *    nobody consumes here is set aside.
 * 3. Rebuilt as its class; one that cannot be is set aside.
 * 4. An event is executed by every bounded context that hears it and does not have it yet
 *    (`reached`); a Command, by the bus that consumes it — its answer kept.
 * 5. The verdict (`verdictOf`, or the platform's) says what follows, with its policy (`policyOf`
 *    over `policy`): delivered; wait — the other side is not there now —; sent again while it has
 *    retries; or set aside — the dead-letter queue —, for a person. A consumer that failed in a
 *    way every attempt would repeat is never run again.
 * Final: `onSettled` hears every settlement.
 *
 * Delivery is at least once: a process that stops after a context executed a message and before
 * the store saved it executes it there again on the next drain. What must not act twice keys what
 * it does by the envelope's id — `this.execution.causationId` in its use case, the
 * `Idempotency-Key` a write sends — or by the entity it names. And one process drains a store:
 * two tabs over one IndexedDB claim it first (the Web Locks API).
 */
export function storedQueue(options: StoredQueueOptions): StoredQueue {
  const { store, subscriber } = options;
  const firstWait = options.wait ?? 1000;
  const longestWait = options.longestWait ?? 60_000;
  const base = over(DEFAULT_DELIVERY_POLICY, options.policy);
  if (!(base.retries >= 0)) throw new TypeError("A stored queue's retries are 0 or more");
  if (!(base.maxAttempts >= 1))
    throw new TypeError("A stored queue sends a message once at least");
  const rebuild = options.rebuild ?? eventFrom;
  const rebuildCommand = options.rebuildCommand ?? commandFrom;
  const decide = options.verdict ?? verdictOf;
  let draining: Promise<void> | undefined;
  let again = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const settle = async (stored: StoredMessage) => {
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

  /** Runs `head` by its kind; `undefined` when it settled without running. */
  const run = async (head: StoredMessage, attempts: number): Promise<Ran | undefined> => {
    const settledWith = async (state: "delivered" | "set_aside", error?: unknown) => {
      await settle({
        ...head,
        state,
        attempts,
        retryAt: null,
        failures: error === undefined ? [] : [described("", error)],
      });
      return undefined;
    };
    if (head.kind === "command") {
      const type = subscriber.commandTypeOf(head.envelope.name);
      if (type === undefined)
        return settledWith(
          "set_aside",
          new Error(`${head.envelope.name} is not consumed from this queue`),
        );
      let command: AnyCommand | RemoteCommand;
      try {
        command = rebuildCommand(type, head.payload);
      } catch (error) {
        return settledWith("set_aside", error);
      }
      const handled = await subscriber.execute(command, head.envelope, head.reached);
      const answered = handled.find((one) => !("error" in one));
      return {
        handled,
        answer:
          answered && "answer" in answered && answered.answer !== undefined
            ? valuesOf(answered.answer)
            : head.answer,
      };
    }
    const type = subscriber.eventTypeOf(head.envelope.name);
    if (type === undefined) return settledWith("delivered");
    let event: DomainEvent | RemoteEvent;
    try {
      event = rebuild(type, head.payload);
    } catch (error) {
      return settledWith("set_aside", error);
    }
    return {
      handled: await subscriber.handle(event, head.envelope, head.reached),
      answer: null,
    };
  };

  /** One pass over what waits: every message ready and due, in order; then a timer for the next due. */
  const pass = async () => {
    const skip = new Set<string>();
    let nextDue: number | undefined;
    for (;;) {
      const head = await store.next(skip);
      if (head === undefined) break;
      const id = head.envelope.id;
      const due = head.retryAt === null ? 0 : Date.parse(head.retryAt);
      if (due > Date.now()) {
        skip.add(id);
        nextDue = nextDue === undefined ? due : Math.min(nextDue, due);
        continue;
      }
      if (options.ready && !(await options.ready(head))) {
        skip.add(id);
        continue;
      }
      const attempts = head.attempts + 1;
      const ran = await run(head, attempts);
      if (ran === undefined) continue;
      const reached = [...head.reached];
      const failures: DeliveryFailure[] = [];
      const errors: unknown[] = [];
      for (const one of ran.handled) {
        if (!("error" in one)) {
          reached.push(one.boundedContext);
          continue;
        }
        failures.push(described(one.boundedContext, one.error));
        errors.push(one.error);
        // A consumer that refused it for good is never run again, whatever comes next.
        if (failureOf(one.error).permanent) reached.push(one.boundedContext);
      }
      const verdict = decide({
        stored: head,
        attempts,
        errors,
        policy: over(base, options.policyOf?.(head)),
        backoff: Math.min(longestWait, firstWait * 2 ** (attempts - 1)),
      });
      const common = { ...head, attempts, reached, failures, answer: ran.answer };
      if (verdict.settlement === "wait" || verdict.settlement === "retry") {
        const after = verdict.after;
        const at = after === undefined ? null : Date.now() + after;
        await settle({
          ...common,
          state: "pending",
          retryAt: at === null ? null : new Date(at).toISOString(),
        });
        skip.add(id);
        if (at !== null) nextDue = nextDue === undefined ? at : Math.min(nextDue, at);
        continue;
      }
      await settle({ ...common, state: verdict.settlement, retryAt: null });
    }
    if (nextDue !== undefined) wakeAt(nextDue);
  };

  const store_ = async (
    kind: MessageKind,
    message: DomainEvent | RemoteEvent | AnyCommand | RemoteCommand,
    envelope: Envelope,
  ) => {
    await store.add({
      kind,
      envelope,
      payload: valuesOf(message),
      state: "pending",
      attempts: 0,
      retryAt: null,
      reached: [],
      failures: [],
      answer: null,
    });
    queue.drain().catch((error: unknown) =>
      loggerAdapter.error("The stored queue could not deliver", {
        reason: failureOf(error).reason,
      }),
    );
  };

  const queue: StoredQueue = {
    put: (event, envelope) => store_("event", event, envelope),
    send: (command, envelope) => store_("command", command, envelope),
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
