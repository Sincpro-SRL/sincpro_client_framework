/**
 * The client contract of a bounded context, as sincpro_framework exports it
 * (`export_client_contract`, PRD_33): its metamodel — models, the definitions they share, every
 * operation a client may call — and how each wire reaches each operation (`bindings`). A bare
 * metamodel (`export_metamodel`) is the same without `format` and `bindings`.
 *
 * Context: only what the generator reads is typed here. The file is the server's, written with
 * its keys sorted, so the same code writes the same bytes; a key this does not name is kept in
 * the snapshot and ignored by the generator.
 */
export type Schema = {
  type?: string | readonly string[];
  format?: string;
  enum?: readonly unknown[];
  const?: unknown;
  items?: Schema;
  $ref?: string;
  anyOf?: readonly Schema[];
  oneOf?: readonly Schema[];
  properties?: Readonly<Record<string, Schema>>;
  required?: readonly string[];
  additionalProperties?: boolean | Schema;
  title?: string;
  description?: string;
  "x-sincpro"?: {
    type?: string;
    relation?: string | null;
    identity?: string;
    /** A to-many whose records are other aggregates: listed and searched, never edited as lines. */
    reference?: boolean;
  };
  /** An answer that is bytes as they are produced (an export): the media types it may be. */
  "x-sincpro-streamed"?: readonly string[];
};

export type Operation = {
  /** What it is for its entity: `search`, `get`, `edit`, `command`… */
  role: string;
  /** It writes nothing: retrying or caching it is safe. */
  query: boolean;
  entities: readonly string[];
  /** The field of `input` that names the record of each entity it runs on. */
  targets: Readonly<Record<string, string>>;
  dry_run: boolean;
  description?: string | null;
  input: Schema;
  /** What it answers; `null` when the server declares nothing. */
  output: Schema | null;
  /** The entity's own operation of its role, when it has several (`@entity_tags(own=True)`). */
  own?: boolean;
  deprecated?: boolean;
  /** The day it stops being served, `YYYY-MM-DD`. */
  sunset?: string | null;
  /** The operation that replaces it, by identity. */
  replacement?: string | null;
};

/** How REST reaches an operation: its method and its whole path, `{field}` where a field goes. */
export type RestBinding = {
  method: string;
  path: string;
  /** The fields of the input the path carries. */
  path_fields: readonly string[];
};

export type Bindings = {
  rest?: Readonly<Record<string, RestBinding>>;
  rpc?: Readonly<Record<string, { method: string }>>;
  grpc?: Readonly<Record<string, { method: string }>>;
  mcp?: Readonly<Record<string, { tool: string }>>;
};

export type Metamodel = {
  /** `sincpro.client-contract/1` for an exported client contract. */
  format?: string;
  /** The bounded context's own name: what every operation's identity starts with. */
  bounded_context?: string;
  /** The name the gateways publish it under (`FastApiGateway({"project": …})`): what a client
   *  names the context by. */
  alias?: string;
  /** The bounded context's name, as sincpro_framework 3.32 wrote it before `bounded_context`. */
  context?: string;
  version: string;
  /** Every shape the contract names: an entity (it has an `identity`) or a value it holds. */
  models: Readonly<Record<string, Schema>>;
  /** By the Command's identity, `"<bounded_context>.<Class>"`. */
  operations: Readonly<Record<string, Operation>>;
  $defs?: Readonly<Record<string, Schema>>;
  /** By wire, then by the Command's identity. */
  bindings?: Bindings;
};
