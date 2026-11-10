/**
 * What answers a use case's failure instead of raising it — sincpro_framework's error handlers.
 *
 *     project.addFeatureErrorHandler((error) => {
 *       if (error instanceof IssueNotFound) return new ResponseEmpty();   // the answer
 *       throw error;                                                     // the next handler
 *     });
 *
 * Context: three chains per bounded context — global (around `project.execute`), feature and
 * application service —, each run first-registered-first. A handler that throws hands what it
 * threw to the next; the last one's throw reaches the caller. The failure was already recorded
 * where it happened (its span, its log line and, when unexpected, its report): a handler decides
 * the answer, not whether it is observed. A handler that only watches must end with `throw`:
 * what it returns is the answer.
 */
export type ErrorHandler = (error: unknown) => unknown;

/** An error's class, as `expectErrors` names it. */
export type ErrorClass = abstract new (...args: never[]) => unknown;
