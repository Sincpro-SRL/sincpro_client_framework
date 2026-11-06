import type {
  Attributes,
  ErrorAbout,
  ErrorReporter,
  Outcome,
  Span,
  Tracer,
} from "@sincpro/client-framework/observability/ports";

/**
 * A tracer and a reporter that keep what they were told, so a test reads it back.
 *
 *     const tracer = memoryTracer();
 *     const project = bindServices(createRuntime({ tracer }), "project", { closeIssue });
 *     await project.closeIssue.execute(input);
 *     tracer.spans.map((one) => one.name);   // ["project/closeIssue", "project/send", …]
 *
 * Context: a use case is proven in Node with nothing of a platform; these are the platform's
 * part, held in memory. Not test doubles of this package — real implementations of its ports.
 */

/** A span as the memory tracer kept it. */
export type RecordedSpan = {
  name: string;
  traceId: string;
  spanId: string;
  /** The span it was opened under, when it was. */
  parentSpanId: string | undefined;
  attributes: Record<string, string | number | boolean>;
  /** How it ended; `undefined` while it is open. */
  outcome: Outcome | undefined;
  error: unknown;
};

export type MemoryTracer = Tracer & { readonly spans: RecordedSpan[] };

function hex(bytes: number): string {
  return Array.from(globalThis.crypto.getRandomValues(new Uint8Array(bytes)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function memoryTracer(): MemoryTracer {
  const spans: RecordedSpan[] = [];
  return {
    spans,
    start(name: string, options: { parent?: Span; attributes?: Attributes }): Span {
      const recorded: RecordedSpan = {
        name,
        traceId: options.parent?.traceId || hex(16),
        spanId: hex(8),
        parentSpanId: options.parent?.spanId || undefined,
        attributes: { ...options.attributes },
        outcome: undefined,
        error: undefined,
      };
      spans.push(recorded);
      return {
        traceId: recorded.traceId,
        spanId: recorded.spanId,
        sampled: true,
        set: (attributes) => void Object.assign(recorded.attributes, attributes),
        end: (outcome, error) => {
          if (recorded.outcome !== undefined) return;
          recorded.outcome = outcome;
          recorded.error = error;
        },
      };
    },
  };
}

export type MemoryReporter = ErrorReporter & {
  readonly reports: { error: unknown; about: ErrorAbout }[];
};

export function memoryReporter(): MemoryReporter {
  const reports: { error: unknown; about: ErrorAbout }[] = [];
  return { reports, report: (error, about) => void reports.push({ error, about }) };
}
