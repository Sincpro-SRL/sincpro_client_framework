import type {
  AnyCommand,
  DomainEvent,
  RemoteCommand,
  RemoteEvent,
} from "@sincpro/client-framework/core/domain/dto";
import type { Envelope } from "@sincpro/client-framework/event_driven/domain/envelope";
import type {
  Handled,
  MessageQueue,
  Subscribes,
} from "@sincpro/client-framework/event_driven/domain/queue";

/**
 * The queue that delivers in the call, in memory — the backend's `SyncQueue`: `publish` returns
 * once every bounded context that hears the event executed it, `send` once its bus ran the
 * Command. What a web application starts
 * with, and what a test proves a flow with.
 *
 * Context: nothing is stored, so nothing outlives the process — a phone's queue is durable and
 * the platform's. Every subscriber runs; then the first failure, if any, reaches the publisher,
 * as an in-process call would.
 */
export function syncQueue(subscriber: Subscribes): MessageQueue {
  const raise = (handled: readonly Handled[]) => {
    const failed = handled.find((one) => "error" in one);
    if (failed && "error" in failed) throw failed.error;
  };
  return {
    async put(event: DomainEvent | RemoteEvent, envelope: Envelope) {
      raise(await subscriber.handle(event, envelope));
    },
    async send(command: AnyCommand | RemoteCommand, envelope: Envelope) {
      raise(await subscriber.execute(command, envelope));
    },
  };
}
