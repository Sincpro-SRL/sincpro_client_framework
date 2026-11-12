import { restOperations, restTransport } from "@sincpro/client-framework";
import type { BoundedContext } from "@sincpro/client-framework/core";

import { clientOf } from "../../forge-contract/project/adapters/generated/client";

/** Who is signed in, as the services of «project» ask it. */
export type Session = { readonly user: string | null; require(): void };

/** Where «project» leaves what it tells people. A plain object: handed to a run as it is. */
export type Outbox = { readonly sent: string[] };

/** What every service of «project» can count on: `this.client`, `this.session`, `this.outbox`. */
export interface ProjectDependencies {
  client: ReturnType<typeof clientOf>;
  session: Session;
  outbox: Outbox;
}

/** What «project» runs with besides what it is given: `this.context.tenant_id`, … */
export interface ProjectContext {
  tenant_id: string;
  company_id: number;
}

export function signedIn(user: string | null): Session {
  return {
    user,
    require() {
      if (user === null) throw new Error("sign in first");
    },
  };
}

/** A server that cancels whatever it is asked to. */
const cancelling: typeof fetch = (async () =>
  new Response(JSON.stringify({ issue_id: "acme-3", resolution: "cancelled" }), {
    status: 200,
  })) as typeof fetch;

export function registerDependencies(
  bc: BoundedContext<ProjectDependencies, ProjectContext>,
) {
  bc.addDependency(
    "client",
    clientOf(restOperations(restTransport({ document: null, fetch: cancelling }))),
  );
  bc.addDependency("session", signedIn("ana"));
  bc.addDependency("outbox", { sent: [] });
  return bc;
}
