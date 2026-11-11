import type { DtoKey, Executable } from "@sincpro/client-framework/core/domain/dto";
import type { Listener } from "@sincpro/client-framework/core/domain/pipeline";
import { matches } from "@sincpro/client-framework/core/services/dto-keys";

/** An interceptor or a listener, and the DTOs it is for — every one when it names none. */
export type Hearing<F> = { readonly what: F; readonly dtos: readonly DtoKey[] };

/** Whether something registered for `dtos` concerns `executable`: its exact class, or its generated identity. */
export function concerns(dtos: readonly DtoKey[], executable: Executable): boolean {
  return dtos.length === 0 || dtos.some((dto) => matches(dto, executable));
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
  dtos: readonly DtoKey[],
): () => void {
  if (typeof listener !== "function") throw new TypeError("A listener is a function");
  const one = { what: listener, dtos };
  hearing.add(one);
  return () => void hearing.delete(one);
}
