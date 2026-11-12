import {
  type CallOptions,
  type Decoder,
  type Download,
  type Draft,
  type Method,
  type One,
  type SendOptions,
  type Transport,
  TransportError,
} from "@sincpro/client-framework/client/domain/transport";
import {
  definitionOf,
  type DiscoveryDocument,
  modelAt,
} from "@sincpro/client-framework/client/services/discovery";
import { bindableTransport } from "@sincpro/client-framework/client/services/propagation";
import { type Criteria, type Dropped, type Meta, readProblem } from "@sincpro/criteria";
import { RestError, restSource } from "@sincpro/criteria/rest";

/**
 * The REST wire of sincpro_framework (`FastApiGateway`).
 *
 * Context: a list is criteria's `restSource` (0.3.1 sends the criteria as plain JSON and joins
 * a route that carries its own query, `/projects?tenant_id=acme` — the two things forge's
 * console found wrong in 0.3.0, fixed there). What this adds is what criteria does not know:
 * one record (`one()`), a write (`send()`, with its `Idempotency-Key`), and its refusals as a
 * `TransportError`, the one error every screen explains.
 *
 * The definition of each model — what a list, a form and a select are built from — is read
 * from the bounded context's discovery document (`document`, `/openapi.json` by default), once,
 * and read again only when an answer says another version of its model (`model_version`); the
 * document is revalidated with its `ETag`, so an unchanged one costs a `304`.
 *
 *     const transport = restTransport({
 *       base: "/v1",
 *       headers: () => ({ Authorization: `Bearer ${session.secret}` }),
 *     });
 */
export type RestOptions = {
  /** Prepended to every route: `"/v1"`, `"https://forge.sincpro.com.bo/v1"`. */
  base?: string;
  /** Sent with every request. A function is called fresh each time — a token that rotates. */
  headers?: Record<string, string> | (() => Record<string, string>);
  /** Defaults to the global `fetch`. Inject one for tests. */
  fetch?: typeof fetch;
  /**
   * The formats besides JSON this transport reads a page in — `[parquetDecoder]` from
   * `@sincpro/client-framework/parquet`. Each is said in `Accept`, so a search that answers its
   * large pages as Parquet does so only to a client that reads it.
   */
  decoders?: readonly Decoder[];
  /** Where the bounded context's discovery document is: `"/openapi.json"` by default, at the
   *  origin of `base`. `null`: none is read, and the definitions come only from `metas`. */
  document?: string | null;
  /**
   * The version of each model the application was written against — the snapshot it was
   * generated from (`versionsOf(contract)`). With it, an answer of another version is told to
   * `onVersionDrift`: the server moved, the generated code did not.
   */
  snapshot?: Readonly<Record<string, string>>;
  /** Called once per model and version the server answers that the snapshot does not hold —
   *  never an error: the screen keeps working on the live definition. */
  onVersionDrift?: (drift: VersionDrift) => void;
};

/** A model the server answers at another version than the snapshot the code came from. */
export type VersionDrift = { model: string; snapshot: string; live: string };

/** The keys of an answer that are not the record: what is left is the record's own field. */
const ENVELOPE = new Set(["cursor", "count", "model_version", "dropped", "draft", "missing"]);

/**
 * The name a `Content-Disposition` says to save a file as; `""` when it says none. The encoded
 * form (`filename*=UTF-8'es'informe%20final.parquet`, RFC 5987) wins, its charset and language
 * dropped and its bytes decoded; the plain one (`filename="report 100%.csv"`) is taken as it is.
 */
function filenameOf(disposition: string | null): string {
  const said = disposition ?? "";
  const encoded = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(said);
  if (encoded?.[2] !== undefined) {
    try {
      return decodeURIComponent(encoded[2].trim().replace(/^"|"$/g, ""));
    } catch {
      return encoded[2].trim();
    }
  }
  const plain = /filename\s*=\s*("([^"]*)"|[^;]+)/i.exec(said);
  return (plain?.[2] ?? plain?.[1] ?? "").trim();
}

export function urlOf<T>(base: string, route: string, criteria?: Criteria<T>): string {
  const url = `${base}${route}`;
  if (criteria === undefined) return url;
  const joiner = url.includes("?") ? "&" : "?";
  return `${url}${joiner}criteria=${encodeURIComponent(JSON.stringify(criteria))}`;
}

/** The path a route is asked at, without its query: what a document path is matched with. */
function pathOf(url: string): string {
  const path = url.split("?")[0] ?? url;
  return /^https?:\/\//.test(path) ? new URL(path).pathname : path;
}

/** Where the document is: `document` as given when absolute, else at the origin of `base`. */
function documentUrl(base: string, document: string): string {
  if (/^https?:\/\//.test(document) || !/^https?:\/\//.test(base)) return document;
  return new URL(document, base).toString();
}

export function restTransport(options: RestOptions = {}): Transport {
  const base = options.base ?? "";
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));

  const decoders = options.decoders ?? [];
  const accept: Record<string, string> =
    decoders.length === 0
      ? {}
      : { Accept: ["application/json", ...decoders.map((one) => one.mediaType)].join(", ") };
  const own = (): Record<string, string> =>
    typeof options.headers === "function" ? options.headers() : (options.headers ?? {});
  /** A body in a format a decoder reads, read by it; anything else left to JSON. */
  const decode = async (response: Response) => {
    const type = (response.headers.get("content-type") ?? "").split(";")[0]?.trim();
    const decoder = decoders.find((one) => one.mediaType === type);
    return decoder === undefined ? undefined : decoder.decode(response);
  };

  // The discovery document, read once; asked again — with its ETag — when an answer says a
  // version of its model the document did not.
  const located = options.document === null ? null : (options.document ?? "/openapi.json");
  let held: Promise<DiscoveryDocument | null> | undefined;
  let tag: string | null = null;

  function documentRead(fresh: boolean): Promise<DiscoveryDocument | null> {
    if (located === null) return Promise.resolve(null);
    if (held !== undefined && !fresh) return held;
    const before = held;
    held = (async () => {
      try {
        const response = await doFetch(documentUrl(base, located), {
          headers: { ...own(), ...(tag === null ? {} : { "If-None-Match": tag }) },
        });
        if (response.status === 304 && before !== undefined) return await before;
        if (!response.ok) return null;
        tag = response.headers.get("etag");
        return (await response.json()) as DiscoveryDocument;
      } catch {
        return null;
      }
    })();
    return held;
  }

  /** The definition of the model `url` answers; read again when `version` is not the one held. */
  // Each drift is told once: a list read every few seconds would say it on every page.
  const told = new Set<string>();
  function noticeDrift(model: string, live: string | null | undefined): void {
    const snapshot = options.snapshot?.[model];
    if (snapshot === undefined || !live || live === snapshot) return;
    const key = `${model}\u0000${live}`;
    if (told.has(key)) return;
    told.add(key);
    options.onVersionDrift?.({ model, snapshot, live });
  }

  async function definitionAt(
    url: string,
    method: string,
    version: string | null | undefined,
  ): Promise<Meta | null> {
    const published = await documentRead(false);
    if (published === null) return null;
    const name = modelAt(published, pathOf(url), method);
    if (name === undefined) return null;
    noticeDrift(name, version);
    const known = definitionOf(published, name);
    if (known === undefined || !version || known.version === version)
      return known?.meta ?? null;
    const again = await documentRead(true);
    return (again === null ? undefined : definitionOf(again, name))?.meta ?? known.meta;
  }

  async function get(
    route: string,
    url: string,
    signal?: AbortSignal,
    write?: { method: Method; body: unknown; key?: string | undefined },
    call?: CallOptions,
  ): Promise<unknown> {
    const headers = write
      ? {
          ...own(),
          ...call?.headers,
          "Content-Type": "application/json",
          ...(write.key === undefined ? {} : { "Idempotency-Key": write.key }),
        }
      : { ...own(), ...call?.headers };
    const response = await doFetch(url, {
      headers,
      ...(write ? { method: write.method, body: JSON.stringify(write.body) } : {}),
      ...(signal ? { signal } : {}),
    });
    const text = await response.text();
    if (!response.ok)
      throw new TransportError(route, response.status, readProblem(text), undefined);
    return text ? JSON.parse(text) : null;
  }

  return bindableTransport({
    async list(route, criteria, signal, call) {
      const source = restSource<never>(`${base}${route}`, {
        // Only a page may come in another format: the decoders are said here, and nowhere else.
        headers: () => ({ ...accept, ...own(), ...call?.headers }),
        fetch: doFetch,
        ...(decoders.length === 0 ? {} : { decode }),
      });
      try {
        const page = await source.read(criteria as never, signal);
        return {
          ...page,
          meta: page.meta ?? (await definitionAt(`${base}${route}`, "get", page.version)),
        };
      } catch (error) {
        if (error instanceof RestError)
          throw new TransportError(route, error.status, error.problem, undefined);
        throw error;
      }
    },

    async read<T>(route: string, signal?: AbortSignal, call?: CallOptions): Promise<T> {
      return (await get(route, urlOf(base, route), signal, undefined, call)) as T;
    },

    async download(
      route: string,
      signal?: AbortSignal,
      call?: CallOptions,
    ): Promise<Download> {
      const response = await doFetch(urlOf(base, route), {
        headers: { ...own(), ...call?.headers },
        ...(signal ? { signal } : {}),
      });
      if (!response.ok)
        throw new TransportError(
          route,
          response.status,
          readProblem(await response.text()),
          undefined,
        );
      return {
        mediaType: (response.headers.get("content-type") ?? "").split(";")[0]?.trim() ?? "",
        filename: filenameOf(response.headers.get("content-disposition")),
        body: response.body,
        blob: () => response.blob(),
      };
    },

    async one<T>(route: string, signal?: AbortSignal, call?: CallOptions): Promise<One<T>> {
      const answer = (await get(
        route,
        urlOf(base, route),
        signal,
        undefined,
        call,
      )) as Record<string, unknown>;
      const own = Object.keys(answer).filter((key) => !ENVELOPE.has(key));
      const [key] = own;
      if (own.length !== 1 || key === undefined)
        throw new TransportError(
          route,
          200,
          null,
          `${route} answered ${own.length} fields of its own (${own.join(", ")}); a record answers one`,
        );
      return {
        record: answer[key] as T,
        meta: await definitionAt(
          urlOf(base, route),
          "get",
          answer["model_version"] as string | undefined,
        ),
        dropped: (answer["dropped"] as Dropped[] | undefined) ?? [],
        draft: (answer["draft"] as Draft | undefined) ?? null,
      };
    },

    async send<T>(
      method: Method,
      route: string,
      body: unknown,
      signal?: AbortSignal,
      sending?: SendOptions,
    ) {
      return (await get(
        route,
        urlOf(base, route),
        signal,
        { method, body, key: sending?.idempotencyKey },
        sending,
      )) as T;
    },
  });
}
