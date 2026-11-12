import { BIND, type Execution } from "@sincpro/client-framework/context/domain/execution";
import type {
  AnyCommand,
  DomainEvent,
  RemoteCommand,
  RemoteEvent,
} from "@sincpro/client-framework/core/domain/dto";
import type { Cause } from "@sincpro/client-framework/core/domain/pipeline";
import {
  type Envelope,
  envelopeOf,
} from "@sincpro/client-framework/event_driven/domain/envelope";
import type { MessageQueue } from "@sincpro/client-framework/event_driven/domain/queue";
import { commandEnvelopeOf } from "@sincpro/client-framework/event_driven/services/messages";
import { traceparentOf } from "@sincpro/client-framework/observability/services/trace-context";

/**
 * Puts messages into a queue — what a Feature or a screen holds to tell whoever listens, or to
 * ask for something that runs when it can, as the backend's `Publisher`:
 *
 *     shopBoundedContext.addDependency("publisher", new Publisher(queue));
 *     await this.publisher.publish(new OrderPaid(order.id));       // a fact: every hearer
 *     await this.publisher.send(new CommandSendMessage(chat, text)); // an intention: its bus
 *
 * Context: a dependency of a bounded context is bound to each run (`BIND`), so what a Feature
 * publishes joins that run's flow — the same `correlationId`, caused by the run — with nothing
 * passed by hand. Outside a run, an event is the head of its own flow.
 */
export class Publisher {
  constructor(
    private readonly queue: MessageQueue,
    private readonly cause?: Cause,
  ) {}

  /** `event` into the queue, with its envelope; answers the envelope once the queue took it. */
  async publish(event: DomainEvent | RemoteEvent): Promise<Envelope> {
    const envelope = envelopeOf(event, this.cause);
    await this.queue.put(event, envelope);
    return envelope;
  }

  /**
   * `command` into the queue, with its envelope: an intention, stored and run by the bus that
   * consumes it when it can — its answer arrives later, kept with it. Answers the envelope once
   * the queue took it: its id is the Command's key.
   */
  async send(command: AnyCommand | RemoteCommand): Promise<Envelope> {
    const envelope = commandEnvelopeOf(command, this.cause);
    await this.queue.send(command, envelope);
    return envelope;
  }

  /** The same publisher, publishing as `execution`: what it publishes and sends joins that run's flow. */
  [BIND](execution: Execution): Publisher {
    const traceparent = traceparentOf(execution.span);
    return new Publisher(this.queue, {
      id: execution.id,
      correlationId: execution.correlationId,
      ...(traceparent ? { traceparent } : {}),
      ...(execution.span.state ? { tracestate: execution.span.state } : {}),
    });
  }
}
