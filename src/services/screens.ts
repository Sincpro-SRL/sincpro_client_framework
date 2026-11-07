import type {
  CallOptions,
  Download,
  One,
  SendOptions,
  Transport,
} from "@sincpro/client-framework/client/transport";
import { UseBoundedContext } from "@sincpro/client-framework/services/bounded-context";
import { Feature } from "@sincpro/client-framework/services/feature";
import type { Criteria, Page } from "@sincpro/criteria";

type Through = { transport: Transport };

/**
 * What a screen reads of an entity — a page, a record, a read of its own: sincpro_framework's
 * built-in `EntityReads`, on the client.
 */
class EntityReads extends Feature<Through> {
  list<T>(route: string, criteria: Criteria<T>, signal?: AbortSignal, options?: CallOptions) {
    this.span.set({ "http.route": route });
    return this.transport.list<T>(route, criteria, signal, options);
  }

  one<T>(route: string, signal?: AbortSignal, options?: CallOptions): Promise<One<T>> {
    this.span.set({ "http.route": route });
    return this.transport.one<T>(route, signal, options);
  }

  read<T>(route: string, signal?: AbortSignal, options?: CallOptions): Promise<T> {
    this.span.set({ "http.route": route });
    const read = this.transport.read;
    if (read === undefined)
      return Promise.reject(
        new Error(`this transport cannot read ${route}: it has no read()`),
      );
    return read.call(this.transport, route, signal, options) as Promise<T>;
  }

  download(route: string, signal?: AbortSignal, options?: CallOptions): Promise<Download> {
    this.span.set({ "http.route": route });
    const download = this.transport.download;
    if (download === undefined)
      return Promise.reject(
        new Error(`this transport cannot download ${route}: it has no download()`),
      );
    return download.call(this.transport, route, signal, options);
  }
}

/** What a screen writes — a save, a draft, a preview, a Command: each request a use case. */
class EntityWrites extends Feature<Through> {
  send<T>(
    method: Parameters<Transport["send"]>[0],
    route: string,
    body: unknown,
    signal?: AbortSignal,
    options?: SendOptions,
  ): Promise<T> {
    this.span.set({ "http.method": method, "http.route": route });
    return this.transport.send<T>(method, route, body, signal, options);
  }
}

/**
 * The transport, every call a use case of a bounded context of its own — `screens` unless named:
 * what a platform hands the screens it draws.
 *
 *     const screens = screensTransport(restTransport({ base: "/v1" }));
 *     await screens.list("/facturas", criteria);   // span screens/EntityReads.list
 *
 * Context: a use case is traced, carries its context and reports what nobody expected; a list a
 * screen reads through the transport was none of that — no span, no `traceparent` (the backend's
 * trace started there, with no client in it), no company, and a 500 reported to nobody. Here
 * each read and write runs as a use case of `screens` — `EntityReads.list`, `.one`, `.read`,
 * `.download`, `EntityWrites.send` —, so it gets all three the way any other does: the span (its route said
 * on it), the trace and the process's context on the request, and a report only when it failed
 * (a 4xx the server explained is the screen's to show). A bounded context's own dependencies are
 * never given this: there its use case is the one that runs.
 */
/** The transports this made: given one again, it is answered as it is — wrapped twice, each
 *  request would be two unrelated use cases, and the server would see only the outer's trace. */
const MADE = new WeakSet<Transport>();

export function screensTransport(transport: Transport, name = "screens"): Transport {
  if (MADE.has(transport)) return transport;
  const screens = new UseBoundedContext<Through>(name)
    .addDependency("transport", transport)
    .register({ features: { EntityReads, EntityWrites } });
  const reads = screens.EntityReads;
  const writes = screens.EntityWrites;
  const through: Transport = {
    list: <T>(
      route: string,
      criteria: Criteria<T>,
      signal?: AbortSignal,
      options?: CallOptions,
    ) => reads.list<T>(route, criteria, signal, options) as Promise<Page<T>>,
    one: <T>(route: string, signal?: AbortSignal, options?: CallOptions) =>
      reads.one<T>(route, signal, options),
    send: <T>(
      method: Parameters<Transport["send"]>[0],
      route: string,
      body: unknown,
      signal?: AbortSignal,
      options?: SendOptions,
    ) => writes.send<T>(method, route, body, signal, options),
  };
  if (transport.read !== undefined)
    through.read = <T>(route: string, signal?: AbortSignal, options?: CallOptions) =>
      reads.read<T>(route, signal, options);
  if (transport.download !== undefined)
    through.download = (route: string, signal?: AbortSignal, options?: CallOptions) =>
      reads.download(route, signal, options);
  MADE.add(through);
  return through;
}
