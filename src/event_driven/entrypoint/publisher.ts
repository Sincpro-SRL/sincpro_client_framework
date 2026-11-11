import { BIND, type Execution } from "@sincpro/client-framework/context/domain/execution";
import type { DomainEvent, RemoteEvent } from "@sincpro/client-framework/core/domain/dto";
import type { Cause } from "@sincpro/client-framework/core/domain/pipeline";
import {
  type Envelope,
  envelopeOf,
} from "@sincpro/client-framework/event_driven/domain/envelope";
import type { EventQueue } from "@sincpro/client-framework/event_driven/domain/queue";
import { traceparentOf } from "@sincpro/client-framework/observability/services/trace-context";

/**
 * Puts events into a queue — what a Feature holds to tell whoever listens, as the backend's
 * `Publisher`:
 *
 *     shopBoundedContext.addDependency("publisher", new Publisher(queue));
 *     // in a Feature:
 *     await this.publisher.publish(new OrderPaid(order.id));   // its Envelope
 *
 * Context: a dependency of a bounded context is bound to each run (`BIND`), so what a Feature
 * publishes joins that run's flow — the same `correlationId`, caused by the run — with nothing
 * passed by hand. Outside a run, an event is the head of its own flow.
 */
export class Publisher {
  constructor(
    private readonly queue: EventQueue,
    private readonly cause?: Cause,
  ) {}

  /** `event` into the queue, with its envelope; answers the envelope once the queue took it. */
  async publish(event: DomainEvent | RemoteEvent): Promise<Envelope> {
    const envelope = envelopeOf(event, this.cause);
    await this.queue.put(event, envelope);
    return envelope;
  }

  /** The same publisher, publishing as `execution`: its events join that run's flow. */
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
