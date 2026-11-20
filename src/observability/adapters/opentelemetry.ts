import {
  type Context as OtelContext,
  context as otelContext,
  isSpanContextValid,
  ROOT_CONTEXT,
  type Span as OtelSpan,
  SpanKind,
  SpanStatusCode,
  trace,
  TraceFlags,
  type Tracer as OtelTracer,
} from "@opentelemetry/api";
import type {
  Outcome,
  Span,
  Tracer,
} from "@sincpro/client-framework/observability/domain/tracing";

/** How `openTelemetryTracer` places a use case's span. Every option is off by default. */
export type OpenTelemetryTracerOptions = {
  /**
   * A span given no parent — a run with no run above it and no delivered message to continue —
   * starts in OpenTelemetry's active context, a child of the span active there: a use case run
   * while a server renders a page is a child of the render, one trace from the page to the API,
   * as sincpro_framework's use case is a child of the span active in its process. A span given a
   * parent keeps it, always — the active span is never mixed in —, and the framework never makes
   * its own spans active, so two runs at once never take each other's. Default `false`: a run
   * with no parent starts a trace of its own, whatever is active.
   *
   * It reads what the application registered and registers nothing. On Node that is a context
   * manager: `AsyncLocalStorageContextManager` from `@opentelemetry/context-async-hooks`, or the
   * one its SDK registers (`NodeSDK`, `@vercel/otel`). Without one the active context is the
   * root and this changes nothing — so in a browser that registers none it is harmless; one that
   * does (`ZoneContextManager`) has a root run start under the span active where it is executed.
   */
  readonly adoptActiveSpan?: boolean;
  /**
   * A failed run's span carries its exception — an `exception` event with its type, message and
   * stack — and its message as the status. Default `true`, as always.
   *
   * `false` keeps a failed span to what the run sets (`error.type`, `sincpro.outcome`,
   * `sincpro.fault`) and an ERROR status, without the message or the stack. Recommended where
   * errors go to an error tracker with their trace id (GlitchTip, through `sentryReporter`): the
   * detail lives there, under its access rules, and not in every backend that stores traces — in
   * an ERP the message of a failure can name a customer or an amount. OpenTelemetry, too, moves
   * away from exceptions as span events (2026).
   */
  readonly recordExceptions?: boolean;
};

/**
 * The `Tracer` port over OpenTelemetry's API: every use case a span of whatever provider the
 * platform registered.
 *
 *     // a browser (@sincpro/web-framework/telemetry does this), Node, React Native…
 *     const tracer = openTelemetryTracer(provider.getTracer("forge-web"));
 *     configureProcess({ tracer });
 *
 *     // a server that renders pages (Next.js), with a context manager registered: a use case
 *     // the render runs is a child of the render's span
 *     openTelemetryTracer(provider.getTracer("forge-web"), { adoptActiveSpan: true });
 *
 * Context: only `@opentelemetry/api`, which runs the same on every platform — the provider, its
 * exporter and where it sends are the platform's (the browser's OTLP over fetch, a phone's
 * queue, a server's SDK). An optional entry with an optional peer: an application that does not
 * import it installs nothing and ships nothing.
 *
 * The parent is given — the run above, the message a run continues —, never read from
 * OpenTelemetry's context: a run carries its own execution (`Execution`), so two use cases at
 * once never take each other's span, and no context manager (Zone.js) is needed. A run given
 * none starts a trace of its own; the one place the active context is read is there, and only
 * when the application asks (`adoptActiveSpan`). A span nothing records (a sampler said no, no
 * provider registered) answers no ids — so no `traceparent` claims a trace that does not exist.
 */
export function openTelemetryTracer(
  tracer: OtelTracer,
  { adoptActiveSpan = false, recordExceptions = true }: OpenTelemetryTracerOptions = {},
): Tracer {
  return {
    start(name, options): Span {
      const span = tracer.startSpan(
        name,
        {
          kind: SpanKind.INTERNAL,
          ...(options.attributes ? { attributes: options.attributes } : {}),
        },
        parentContextOf(options.parent, adoptActiveSpan),
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
        end: (outcome, error) => close(span, outcome, recordExceptions ? error : undefined),
      };
    },
  };
}

/**
 * Where a span starts. Given a parent, under it — at the root when that parent traces nothing —,
 * never in the active context: the run above, or the message it continues, is its parent. Given
 * none, in the active context when the application asked for it, else at the root.
 */
function parentContextOf(parent: Span | undefined, adoptActiveSpan: boolean): OtelContext {
  if (parent === undefined) return adoptActiveSpan ? otelContext.active() : ROOT_CONTEXT;
  if (parent.traceId === "" || parent.spanId === "") return ROOT_CONTEXT;
  return trace.setSpanContext(ROOT_CONTEXT, {
    traceId: parent.traceId,
    spanId: parent.spanId,
    traceFlags: parent.sampled ? TraceFlags.SAMPLED : TraceFlags.NONE,
    isRemote: false,
  });
}

/**
 * How the use case ended, said the way OpenTelemetry reads it: `failed` is an error — with its
 * exception on the span where it was raised, the only one handed it, unless the application keeps
 * the detail out of its traces (`recordExceptions: false`: no error is handed over) —; `refused` and `aborted`
 * are expected answers, never an error, the way the backend leaves a refusal out of its error
 * rate. `sincpro.outcome` (`ok` or the failure's kind), `sincpro.fault` and `error.type` are set
 * by the run before it ends.
 */
function close(span: OtelSpan, outcome: Outcome, error: unknown): void {
  if (outcome === "failed") {
    if (error instanceof Error) span.recordException(error);
    span.setStatus({
      code: SpanStatusCode.ERROR,
      ...(error instanceof Error ? { message: error.message } : {}),
    });
  } else if (outcome === "ok") span.setStatus({ code: SpanStatusCode.OK });
  span.end();
}
