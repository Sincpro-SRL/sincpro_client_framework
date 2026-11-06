import type {
  ErrorAbout,
  ErrorReporter,
} from "@sincpro/client-framework/observability/ports";

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
 *     const runtime = createRuntime({ reporter });
 *
 * Context: it imports nothing — it takes the client the platform made (with its DSN, release
 * and data rules), so it costs no dependency and works on every platform. What is reported is
 * already decided by the runtime (`outcomeOf`: only `failed`); this only says where it happened.
 * The context goes as a context, not as tags: a tag is indexed and searched, and an execution's
 * values are not the place for that.
 */
export function sentryReporter(client: ExceptionClient): ErrorReporter {
  return {
    report(error: unknown, about: ErrorAbout) {
      client.captureException(error, {
        captureContext: {
          tags: {
            "sincpro.use_case": about.useCase,
            ...(about.traceId === "" ? {} : { trace_id: about.traceId }),
          },
          contexts: {
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
