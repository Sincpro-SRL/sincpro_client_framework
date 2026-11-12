import assert from "node:assert/strict";

import {
  BoundedContext,
  Command,
  configureProcess,
  Feature,
  type RemoteOperation,
} from "@sincpro/client-framework";
import { memoryTracer } from "@sincpro/client-framework/testing";
import { beforeEach, test } from "vitest";

beforeEach(() => configureProcess());

/** An Odoo client: its own state and methods, and a `call` that is not an OperationTransport's. */
class OdooLikeClient {
  url = "";
  readonly sent: { input: unknown; headers?: Record<string, string> }[] = [];
  get isConfigured(): boolean {
    return this.url !== "";
  }
  setServer(server: string): void {
    this.url = `https://${server}/jsonrpc`;
  }
  async call<T>(
    _operation: RemoteOperation | string,
    input: unknown,
    options?: { headers?: Record<string, string> },
  ): Promise<T> {
    this.sent.push({ input, ...(options?.headers ? { headers: options.headers } : {}) });
    return undefined as T;
  }
}

class CommandSaveServer extends Command<boolean> {
  constructor(readonly server: string) {
    super();
  }
}

test("a run binds a dependency without taking away what it is — tracing on, as on a phone", async () => {
  const client = new OdooLikeClient();
  const odooBoundedContext = new BoundedContext<{ odoo: OdooLikeClient }>("odoo");
  odooBoundedContext.addDependency("odoo", client);
  odooBoundedContext.feature(CommandSaveServer)(
    class SaveServer extends Feature<CommandSaveServer, boolean> {
      async execute(command: CommandSaveServer): Promise<boolean> {
        const odoo = (this as unknown as { odoo: OdooLikeClient }).odoo;
        odoo.setServer(command.server);
        await odoo.call("execute_kw", { model: "res.partner" });
        return odoo.isConfigured;
      }
    },
  );
  // A tracer gives the run a trace to carry: the case that stripped the client.
  configureProcess({ tracer: memoryTracer() });

  assert.equal(
    await odooBoundedContext.execute(new CommandSaveServer("demo.sincpro.dev")),
    true,
  );
  assert.equal(client.url, "https://demo.sincpro.dev/jsonrpc", "the app's client was set");
  assert.match(
    client.sent[0]?.headers?.traceparent ?? "",
    /^00-[0-9a-f]{32}-/,
    "the call carries the run",
  );
});
