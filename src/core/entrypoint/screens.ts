import type {
  CallOptions,
  Download,
  Method,
  One,
  SendOptions,
  Transport,
} from "@sincpro/client-framework/client/domain/transport";
import { Command } from "@sincpro/client-framework/core/domain/dto";
import { Feature } from "@sincpro/client-framework/core/domain/services";
import { BoundedContext } from "@sincpro/client-framework/core/entrypoint/bounded-context";
import type { Criteria, Page } from "@sincpro/criteria";

class List<T> extends Command<Page<T>> {
  constructor(
    readonly route: string,
    readonly criteria: Criteria<T>,
    readonly signal?: AbortSignal,
    readonly options?: CallOptions,
  ) {
    super();
  }
}

class Get<T> extends Command<One<T>> {
  constructor(
    readonly route: string,
    readonly signal?: AbortSignal,
    readonly options?: CallOptions,
  ) {
    super();
  }
}

class Read<T> extends Command<T> {
  constructor(
    readonly route: string,
    readonly signal?: AbortSignal,
    readonly options?: CallOptions,
  ) {
    super();
  }
}

class Export extends Command<Download> {
  constructor(
    readonly route: string,
    readonly signal?: AbortSignal,
    readonly options?: CallOptions,
  ) {
    super();
  }
}

class Send<T> extends Command<T> {
  constructor(
    readonly method: Method,
    readonly route: string,
    readonly body: unknown,
    readonly signal?: AbortSignal,
    readonly options?: SendOptions,
  ) {
    super();
  }
}

class EntityList extends Feature<List<unknown>, Page<unknown>> {
  declare readonly transport: Transport;
  execute<T>(dto: List<T>): Promise<Page<T>> {
    this.span.set({ "http.route": dto.route });
    return this.transport.list<T>(dto.route, dto.criteria, dto.signal, dto.options);
  }
}

class EntityGet extends Feature<Get<unknown>, One<unknown>> {
  declare readonly transport: Transport;
  execute<T>(dto: Get<T>): Promise<One<T>> {
    this.span.set({ "http.route": dto.route });
    return this.transport.one<T>(dto.route, dto.signal, dto.options);
  }
}

class EntityRead extends Feature<Read<unknown>, unknown> {
  declare readonly transport: Transport;
  execute<T>(dto: Read<T>): Promise<T> {
    this.span.set({ "http.route": dto.route });
    const transport = this.transport;
    if (!transport.read) {
      return Promise.reject(
        new Error(`this transport cannot read ${dto.route}: it has no read()`),
      );
    }
    return transport.read<T>(dto.route, dto.signal, dto.options);
  }
}

class EntityExport extends Feature<Export, Download> {
  declare readonly transport: Transport;
  execute(dto: Export): Promise<Download> {
    this.span.set({ "http.route": dto.route });
    const transport = this.transport;
    if (!transport.download) {
      return Promise.reject(
        new Error(`this transport cannot download ${dto.route}: it has no download()`),
      );
    }
    return transport.download(dto.route, dto.signal, dto.options);
  }
}

class EntitySend extends Feature<Send<unknown>, unknown> {
  declare readonly transport: Transport;
  execute<T>(dto: Send<T>): Promise<T> {
    this.span.set({ "http.method": dto.method, "http.route": dto.route });
    return this.transport.send<T>(dto.method, dto.route, dto.body, dto.signal, dto.options);
  }
}

const MADE = new WeakSet<Transport>();

/**
 * Screen requests enter the same command pipeline as application services. A generated
 * client injected into a Feature uses its raw transport instead, continuing that execution.
 */
export function screensTransport(transport: Transport, name = "screens"): Transport {
  if (MADE.has(transport)) return transport;
  const screens = new BoundedContext<{ transport: Transport }>(name);
  screens.addDependency("transport", transport);
  screens.feature(List)(EntityList);
  screens.feature(Get)(EntityGet);
  screens.feature(Read)(EntityRead);
  screens.feature(Export)(EntityExport);
  screens.feature(Send)(EntitySend);
  const through: Transport = {
    list: <T>(
      route: string,
      criteria: Criteria<T>,
      signal?: AbortSignal,
      options?: CallOptions,
    ) => screens.execute(new List(route, criteria, signal, options)),
    one: <T>(route: string, signal?: AbortSignal, options?: CallOptions) =>
      screens.execute(new Get<T>(route, signal, options)),
    send: <T>(
      method: Method,
      route: string,
      body: unknown,
      signal?: AbortSignal,
      options?: SendOptions,
    ) => screens.execute(new Send<T>(method, route, body, signal, options)),
  };
  if (transport.read) {
    through.read = <T>(route: string, signal?: AbortSignal, options?: CallOptions) =>
      screens.execute(new Read<T>(route, signal, options));
  }
  if (transport.download) {
    through.download = (route, signal, options) =>
      screens.execute(new Export(route, signal, options));
  }
  MADE.add(through);
  return through;
}
