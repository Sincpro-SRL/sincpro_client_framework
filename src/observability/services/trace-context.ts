import type { Span } from "@sincpro/client-framework/observability/domain/tracing";

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

/** A span as W3C trace context writes it (`traceparent`), or `undefined` when nothing traces. */
export function traceparentOf(span: Span): string | undefined {
  if (span.traceId === "" || span.spanId === "") return undefined;
  return `00-${span.traceId}-${span.spanId}-${span.sampled ? "01" : "00"}`;
}

/**
 * The span another process opened, as its `traceparent` says — what a run continues when a
 * message from it arrives. `undefined` for one that is not W3C's or names the all-zeros trace.
 *
 *     remoteSpan("00-4bf9…4736-00f0…02b7-01")   ->  { traceId: "4bf9…4736", spanId: "00f0…02b7", sampled: true }
 */
export function remoteSpan(traceparent: string, tracestate?: string): Span | undefined {
  const found = TRACEPARENT.exec(traceparent.trim().toLowerCase());
  if (found === null) return undefined;
  const [, traceId = "", spanId = "", flags = "00"] = found;
  if (/^0+$/.test(traceId) || /^0+$/.test(spanId)) return undefined;
  return {
    traceId,
    spanId,
    sampled: (Number.parseInt(flags, 16) & 1) === 1,
    ...(tracestate ? { state: tracestate } : {}),
    set: () => undefined,
    end: () => undefined,
  };
}
