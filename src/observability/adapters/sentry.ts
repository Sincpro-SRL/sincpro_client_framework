import type {
  ErrorAbout,
  ErrorReporter,
} from "@sincpro/client-framework/observability/domain/errors";

/**
 * What this adapter needs of a Sentry-compatible client: its `captureException`. A browser's
 * `BrowserClient`, Node's, React Native's — and GlitchTip, which speaks Sentry's protocol.
 */
export type ExceptionClient = {
  captureException(
    error: unknown,
    hint?: {
      captureContext?: {
        tags?: Record<string, string>;
        user?: { id: string };
        contexts?: Record<string, Record<string, unknown>>;
      };
    },
  ): unknown;
};

/**
 * The `ErrorReporter` port over a Sentry-compatible client: an unexpected error reported with the
 * use case it happened in, its trace — the id the backend logged too — and its context.
 *
 *     // @sincpro/web-framework/errors builds the browser's client with GlitchTip's DSN
 *     const reporter = sentryReporter(client);
 *     configureProcess({ reporter });
 *
 * Context: it imports nothing — it takes the client the platform made (with its DSN, release
 * and data rules), so it costs no dependency and works on every platform. What is reported is
 * already decided by the process (`outcomeOf`: only `failed`); this only says where it happened.
 * The context goes as a context, not as tags: a tag is indexed and searched, and an execution's
 * values are not the place for that.
 */
export function sentryReporter(client: ExceptionClient): ErrorReporter {
  return {
    report(error: unknown, about: ErrorAbout) {
      client.captureException(error, {
        captureContext: {
          // sincpro_framework's keys (PRD_03 §5, §4.10): the same text as the log line and the span.
          tags: {
            "sincpro.use_case": about.useCase,
            ...(about.boundedContext ? { "sincpro.context": about.boundedContext } : {}),
            ...(about.layer ? { "sincpro.layer": about.layer } : {}),
            ...(about.kind
              ? { "sincpro.outcome": about.kind, "sincpro.kind": about.kind }
              : {}),
            ...(about.errorType ? { "error.type": about.errorType } : {}),
            ...(about.release ? { release: about.release } : {}),
            ...(about.serviceName ? { service_name: about.serviceName } : {}),
            ...(about.serviceVersion
              ? {
                  service_version: about.serviceVersion,
                  "sincpro.version": about.serviceVersion,
                }
              : {}),
            ...(about.tenant ? { tenant: about.tenant } : {}),
            ...(about.userId ? { user_id: about.userId } : {}),
            ...(about.traceId === "" ? {} : { trace_id: about.traceId }),
          },
          // The issue opens its trace, and says how many users it hit.
          ...(about.userId ? { user: { id: about.userId } } : {}),
          contexts: {
            ...(about.traceId === ""
              ? {}
              : {
                  trace: {
                    trace_id: about.traceId,
                    ...(about.spanId ? { span_id: about.spanId } : {}),
                  },
                }),
            sincpro: {
              use_case: about.useCase,
              execution_id: about.executionId,
              ...(about.traceId === "" ? {} : { trace_id: about.traceId }),
              context: about.context,
            },
          },
        },
      });
    },
  };
}
