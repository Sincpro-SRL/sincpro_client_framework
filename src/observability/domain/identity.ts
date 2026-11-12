/**
 * Who is running — sincpro_framework's identity, the same text on every signal: a span, a log
 * line, a report.
 *
 *     identityOf("sincpro-mobile-tickets:0.3.0")
 *       → { release: "sincpro-mobile-tickets:0.3.0",
 *           serviceName: "sincpro-mobile-tickets", serviceVersion: "0.3.0" }
 *     identityOf("registry.io/team/app:1.2@sha256:ab…")   → serviceName "app", serviceVersion "1.2"
 *     identityOf("app@1.2.3")                             → "app", "1.2.3"
 *     identityOf("registry.local:5000/team/app")          → "app", ""   (a port, no tag)
 *
 * Context: the release is the backend's `APP_RELEASE`, used verbatim; the name and the version
 * are read out of it with the backend's rules (`ObservabilityIdentity._split`), so GlitchTip's
 * release, Tempo's `service.name` and the logs' `service_name` never drift apart. The tenant is
 * the deployment's, when it serves one; a run's own comes from its context (`tenantOf`).
 */
export type ProcessIdentity = {
  /** `<name>:<version>` as deployed — GlitchTip's release and every signal's `release`. */
  readonly release: string;
  /** The name, without its registry or its version: `service.name`. */
  readonly serviceName: string;
  /** The version out of the release; empty when it names none. */
  readonly serviceVersion: string;
  /** The tenant the deployment serves, when it serves one. */
  readonly tenant?: string;
  /** The context keys a run's tenant is read from, first found wins: `tenant`, `tenant_id`. */
  readonly tenantKeys: readonly string[];
  /** The context keys a run's user is read from: `user_id`. */
  readonly userKeys: readonly string[];
};

/**
 * Which keys of a run's context say its tenant and its user — optional both: an application
 * that calls its tenant `company_id` names it here, one without tenants or users names nothing
 * and nothing is sent.
 */
export type IdentityKeys = {
  readonly tenant?: string | readonly string[];
  readonly user?: string | readonly string[];
};

/** The key the release goes by on a span, a log line and a report. */
export const RELEASE = "release";

/** The key the tenant goes by on a span, a log line and a report. */
export const TENANT = "tenant";

/** The key the user goes by on a span, a log line and a report — GlitchTip's user. */
export const USER_ID = "user_id";

/** Where a run's tenant and user are read from when the application names no keys. */
const DEFAULT_TENANT_KEYS: readonly string[] = [TENANT, "tenant_id"];
const DEFAULT_USER_KEYS: readonly string[] = [USER_ID];

const keysOf = (
  named: string | readonly string[] | undefined,
  fallback: readonly string[],
) => (named === undefined ? fallback : typeof named === "string" ? [named] : [...named]);

/**
 * Who is running, out of its release — the deployment's tenant, when there is one, and the
 * context keys its runs say their tenant and user under.
 */
export function identityOf(
  release: string,
  tenant?: string,
  keys: IdentityKeys = {},
): ProcessIdentity {
  const verbatim = release.trim();
  const [artifact, version] = split(verbatim);
  const deployed = tenant?.trim();
  return {
    release: verbatim,
    serviceName: artifact.slice(artifact.lastIndexOf("/") + 1),
    serviceVersion: version,
    ...(deployed ? { tenant: deployed } : {}),
    tenantKeys: keysOf(keys.tenant, DEFAULT_TENANT_KEYS),
    userKeys: keysOf(keys.user, DEFAULT_USER_KEYS),
  };
}

/**
 * The tenant of a run: its context's, under the keys the application named (`tenant`, else
 * `tenant_id`, by default), else the deployment's. Undefined when neither says one — most phones
 * serve whoever opens the app.
 */
export function tenantOf(
  context: Readonly<Record<string, unknown>>,
  identity: ProcessIdentity | undefined,
): string | undefined {
  return valueOf(context, identity?.tenantKeys ?? DEFAULT_TENANT_KEYS) ?? identity?.tenant;
}

/** The user of a run: its context's, under the keys the application named (`user_id`). */
export function userOf(
  context: Readonly<Record<string, unknown>>,
  identity?: ProcessIdentity,
): string | undefined {
  return valueOf(context, identity?.userKeys ?? DEFAULT_USER_KEYS);
}

/** The first key the context says, as text; a list of them (`tenant_ids`) is said as one. */
function valueOf(
  context: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = context[key];
    if (typeof value === "string" && value !== "") return value;
    if (typeof value === "number") return String(value);
    if (Array.isArray(value) && value.length > 0) return value.map(String).join(",");
  }
  return undefined;
}

/**
 * Name and version out of a release, read as an image reference or `name@version`:
 * 1. `@`: a digest (`@sha256:…`) is dropped; anything else after it is the version.
 * 2. `:` after the last `/` is the tag; one before it is a registry's port.
 * Final: no version when neither says one.
 */
function split(release: string): [string, string] {
  let artifact = release;
  const at = artifact.lastIndexOf("@");
  if (at >= 0) {
    const after = artifact.slice(at + 1);
    artifact = artifact.slice(0, at);
    if (!after.includes(":")) return [artifact, after];
  }
  const colon = artifact.lastIndexOf(":");
  if (colon > artifact.lastIndexOf("/")) {
    return [artifact.slice(0, colon), artifact.slice(colon + 1)];
  }
  return [artifact, ""];
}
