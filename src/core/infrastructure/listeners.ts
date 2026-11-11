import type { DtoKey } from "@sincpro/client-framework/core/domain/dto";
import type {
  ExecutionCompleted,
  ExecutionFailed,
  ExecutionStarted,
  Listener,
} from "@sincpro/client-framework/core/domain/pipeline";
import { type Hearing, listenIn } from "@sincpro/client-framework/core/services/listening";

/**
 * Who hears every bounded context of this process — the backend's process listeners: an
 * activity indicator, a toast, an audit that must not be wired into each context.
 *
 *     const stop = processListeners.onFailure((failed) => toast(failed.execution?.useCase));
 *
 * Context: a bounded context's own listeners (`projectBoundedContext.onStart`) hear it alone; these hear all of
 * them, after its own. They live as long as the process — `configureProcess` does not clear
 * them —, so whoever adds one keeps the function that stops it.
 */
const hearing = {
  started: new Set<Hearing<Listener<ExecutionStarted>>>(),
  completed: new Set<Hearing<Listener<ExecutionCompleted>>>(),
  failed: new Set<Hearing<Listener<ExecutionFailed>>>(),
};

/** @internal — what the bounded contexts announce to, besides their own listeners. */
export function processHearing(): typeof hearing {
  return hearing;
}

export const processListeners = {
  /** Hears every run of every bounded context begin. Answers how to stop. */
  onStart(listener: Listener<ExecutionStarted>, ...dtos: DtoKey[]): () => void {
    return listenIn(hearing.started, listener, dtos);
  },
  /** Hears every service that answered, in every bounded context. */
  onCompletion(listener: Listener<ExecutionCompleted>, ...dtos: DtoKey[]): () => void {
    return listenIn(hearing.completed, listener, dtos);
  },
  /** Hears every failure that escapes a call, once, where it failed. */
  onFailure(listener: Listener<ExecutionFailed>, ...dtos: DtoKey[]): () => void {
    return listenIn(hearing.failed, listener, dtos);
  },
};
