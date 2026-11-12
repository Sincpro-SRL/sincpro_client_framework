import type { Method } from "@sincpro/client-framework/client/domain/transport";

/**
 * A write that may have changed what was read: how it was sent and where.
 *
 * Context: a client keeps what it read — a cache, a list on screen, a record, a name in a cell —
 * and every one of them goes stale the moment a write lands, whoever wrote: a screen's save, a use
 * case's Command, a second panel. Each used to learn it only when the write went through the same
 * object it read through, so a use case writing over its generated client left every screen
 * reading the old answer. A change is the fact every reader can hear instead (`ChangeFeed`). It
 * says only what was written — what that touches (the collections a route names, a record's
 * history) is each reader's to decide, as a cache and a screen decide differently.
 *
 *     { method: "POST", route: "/issues/odoo-acme-7/messages" }
 */
export type Change = {
  readonly method: Method;
  /** As the transport received it: a path under its base, maybe with a query. */
  readonly route: string;
};

/**
 * Who hears what was written: one feed the writers announce to and the readers follow, so neither
 * knows the other.
 *
 *     const stop = processChanges.follow((change) => cache.forget(change.route));
 *     processChanges.announce({ method: "PUT", route: "/projects/odoo-acme/edit" });
 *     stop();
 *
 * Context: a listener that fails is ignored — hearing a write never changes its answer, as
 * tracing and listening never do.
 */
export type ChangeFeed = {
  /** Tells everyone who follows now: this was written. */
  announce(change: Change): void;
  /** `listener` hears every change announced from now on; answers the way to stop. */
  follow(listener: (change: Change) => void): () => void;
};

/**
 * The change a `send` makes, or `undefined` when it writes nothing: a preview (`…/preview`) and a
 * dry run (`dry_run: true`, sincpro_framework's `DryRunnable`) only say what a write WOULD do.
 *
 *     changeOf("POST", "/issues/7/cancel", {})                  ->  { method: "POST", route: "/issues/7/cancel" }
 *     changeOf("POST", "/issues/7/cancel", { dry_run: true })   ->  undefined
 *     changeOf("POST", "/invoices/preview", { lines: [] })      ->  undefined
 */
export function changeOf(method: Method, route: string, body: unknown): Change | undefined {
  if ((route.split("?")[0] ?? route).endsWith("/preview")) return undefined;
  if (typeof body === "object" && body !== null && "dry_run" in body && body.dry_run === true)
    return undefined;
  return { method, route };
}
