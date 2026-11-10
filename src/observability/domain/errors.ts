/**
 * What a platform plugs to report what nobody expected.
 *
 * Context: the backend reports each unexpected failure once, with the use case and the trace it
 * belongs to; GlitchTip, Sentry or memory in a test receive it here. A reporter that fails is
 * ignored: telling about a failure never becomes a second one.
 */

/** What a report says about where the error happened. */
export type ErrorAbout = {
  /** `<bounded context>.<Service>`: the use case's identity, as the backend's — or, for what
   *  failed outside one (`reportError`), where it happened (`view project:issue/acme-3`). */
  useCase: string;
  /** The trace the error belongs to — the same id the server logged, when it got that far. */
  traceId: string;
  /** The execution's own id. */
  executionId: string;
  /** What the use case ran with: the process's context, its bounded context's, its scope's. */
  context: Readonly<Record<string, unknown>>;
};

/** Reports what nobody expected. One per platform; none when nothing reports. */
export interface ErrorReporter {
  report(error: unknown, about: ErrorAbout): void;
}
