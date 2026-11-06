import {
  isSpanContextValid,
  ROOT_CONTEXT,
  type Span as OtelSpan,
  SpanKind,
  SpanStatusCode,
  trace,
  TraceFlags,
  type Tracer as OtelTracer,
} from "@opentelemetry/api";
import type { Outcome, Span, Tracer } from "@sincpro/client-framework/observability/ports";

/**
 * The `Tracer` port over OpenTelemetry's API: every use case a span of whatever provider the
 * platform registered.
 *
 *     // a browser (@sincpro/web-framework/telemetry does this), Node, React Native…
 *     const tracer = openTelemetryTracer(provider.getTracer("forge-web"));
 *     const runtime = createRuntime({ tracer });
 *
 * Context: only `@opentelemetry/api`, which runs the same on every platform — the provider, its
 * exporter and where it sends are the platform's (the browser's OTLP over fetch, a phone's
 * queue, a server's SDK). An optional entry with an optional peer: an application that does not
 * import it installs nothing and ships nothing.
 *
 * The parent is given, never read from OpenTelemetry's context: a run carries its own execution
 * (`Execution`), so two use cases at once never take each other's span, and no context manager
 * (Zone.js) is needed. A span nothing records (a sampler said no, no provider registered)
 * answers no ids — so no `traceparent` claims a trace that does not exist.
 */
export function openTelemetryTracer(tracer: OtelTracer): Tracer {
  return {
    start(name, options): Span {
      const parent = options.parent;
      const parentContext =
        parent !== undefined && parent.traceId !== "" && parent.spanId !== ""
          ? trace.setSpanContext(ROOT_CONTEXT, {
              traceId: parent.traceId,
              spanId: parent.spanId,
              traceFlags: parent.sampled ? TraceFlags.SAMPLED : TraceFlags.NONE,
              isRemote: false,
            })
          : ROOT_CONTEXT;
      const span = tracer.startSpan(
        name,
        {
          kind: SpanKind.INTERNAL,
          ...(options.attributes ? { attributes: options.attributes } : {}),
        },
        parentContext,
      );
      const own = span.spanContext();
      const valid = isSpanContextValid(own);
      const state = own.traceState?.serialize();
      return {
        traceId: valid ? own.traceId : "",
        spanId: valid ? own.spanId : "",
        sampled: valid && (own.traceFlags & TraceFlags.SAMPLED) === TraceFlags.SAMPLED,
        ...(state ? { state } : {}),
        set: (attributes) => void span.setAttributes(attributes),
        end: (outcome, error) => close(span, outcome, error),
      };
    },
  };
}

/**
 * How the use case ended, said the way OpenTelemetry reads it: `failed` is an error with its
 * exception; `refused` and `aborted` are expected answers — said in `sincpro.outcome`, never as
 * an error, the way the backend leaves a refusal out of its error rate.
 */
function close(span: OtelSpan, outcome: Outcome, error: unknown): void {
  span.setAttribute("sincpro.outcome", outcome);
  if (outcome === "failed") {
    if (error instanceof Error) span.recordException(error);
    span.setStatus({
      code: SpanStatusCode.ERROR,
      ...(error instanceof Error ? { message: error.message } : {}),
    });
  } else if (outcome === "ok") span.setStatus({ code: SpanStatusCode.OK });
  span.end();
}
