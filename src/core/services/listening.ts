import type { Executable } from "@sincpro/client-framework/core/domain/dto";
import type { Listener } from "@sincpro/client-framework/core/domain/pipeline";

/** A class a service, an interceptor or a listener is for. */
export type ExecutableClass = abstract new (...args: never[]) => Executable;

/** An interceptor or a listener, and the classes it is for — every class when it names none. */
export type Hearing<F> = { readonly what: F; readonly dtos: readonly ExecutableClass[] };

/** Whether something registered for `dtos` concerns `executable`: by its exact class. */
export function concerns(dtos: readonly ExecutableClass[], executable: Executable): boolean {
  return dtos.length === 0 || dtos.includes(Object.getPrototypeOf(executable)?.constructor);
}

/** Each listener that hears it, in turn; one that fails is ignored. */
export function announceTo<E extends { executable: Executable }>(
  hearing: ReadonlySet<Hearing<Listener<E>>>,
  heard: E,
): void {
  for (const one of [...hearing]) {
    if (!concerns(one.dtos, heard.executable)) continue;
    try {
      one.what(heard);
    } catch {
      // Hearing never changes the answer, as tracing, reporting and logging never do.
    }
  }
}

/** `listener` added to `hearing` for `dtos`; answers how to stop. */
export function listenIn<E>(
  hearing: Set<Hearing<Listener<E>>>,
  listener: Listener<E>,
  dtos: readonly ExecutableClass[],
): () => void {
  if (typeof listener !== "function") throw new TypeError("A listener is a function");
  const one = { what: listener, dtos };
  hearing.add(one);
  return () => void hearing.delete(one);
}
