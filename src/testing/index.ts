/**
 * `@sincpro/client-framework/testing`: the observability ports in memory, so a use case is
 * proven in Node with nothing of a platform. Not part of what an application runs.
 */
export {
  type MemoryLogger,
  memoryLogger,
  type MemoryReporter,
  memoryReporter,
  type MemoryTracer,
  memoryTracer,
  type RecordedSpan,
} from "@sincpro/client-framework/observability/adapters/memory";
