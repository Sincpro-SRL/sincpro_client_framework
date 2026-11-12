import assert from "node:assert/strict";

import {
  bindableOperations,
  BoundedContext,
  Command,
  configureProcess,
  Feature,
  type OperationTransport,
  type RemoteOperation,
} from "@sincpro/client-framework";
import { memoryTracer } from "@sincpro/client-framework/testing";
import { beforeEach, test } from "vitest";

beforeEach(() => configureProcess());

/** An Odoo client: its own state and methods, and a `call` that is not an OperationTransport's. */
class OdooLikeClient {
  url = "";
  readonly calls: unknown[][] = [];
  get isConfigured(): boolean {
    return this.url !== "";
  }
  setServer(server: string): void {
    this.url = `https://${server}/jsonrpc`;
  }
  async call(service: string, method: string, args: unknown[]): Promise<void> {
    this.calls.push([service, method, args]);
  }
}

class CommandSaveServer extends Command<boolean> {
  constructor(readonly server: string) {
    super();
  }
}

test("an app's object with a `call` is the app's: never taken for a transport, never rewritten", async () => {
  const client = new OdooLikeClient();
  const odooBoundedContext = new BoundedContext<{ odoo: OdooLikeClient }>("odoo");
  odooBoundedContext.addDependency("odoo", client);
  odooBoundedContext.feature(CommandSaveServer)(
    class SaveServer extends Feature<CommandSaveServer, boolean> {
      async execute(command: CommandSaveServer): Promise<boolean> {
        const odoo = (this as unknown as { odoo: OdooLikeClient }).odoo;
        odoo.setServer(command.server);
        await odoo.call("object", "execute_kw", [
          "db",
          2,
          "pass",
          "res.partner",
          "read",
          [[1]],
        ]);
        return odoo.isConfigured;
      }
    },
  );
  // With a trace to carry — what a phone has, and what stripped the client before.
  configureProcess({ tracer: memoryTracer() });

  assert.equal(
    await odooBoundedContext.execute(new CommandSaveServer("demo.sincpro.dev")),
    true,
  );
  assert.equal(
    client.url,
    "https://demo.sincpro.dev/jsonrpc",
    "setServer set the app's client",
  );
  assert.deepEqual(client.calls, [
    ["object", "execute_kw", ["db", 2, "pass", "res.partner", "read", [[1]]]],
  ]);
});

test("an OperationTransport that says it can be bound carries the run, and keeps what it is", async () => {
  const sent: { headers?: Record<string, string> }[] = [];
  const operations = bindableOperations(
    Object.assign(
      {
        async call<T>(
          _operation: RemoteOperation,
          _input: unknown,
          options?: { headers?: Record<string, string> },
        ) {
          sent.push({ ...(options?.headers ? { headers: options.headers } : {}) });
          return undefined as T;
        },
      } satisfies OperationTransport,
      { channel: "grpc://backend" },
    ),
  );
  const boundedContext = new BoundedContext<{ operations: typeof operations }>("sales");
  boundedContext.addDependency("operations", operations);
  class CommandQuote extends Command<string> {}
  boundedContext.feature(CommandQuote)(
    class Quote extends Feature<CommandQuote, string> {
      async execute(): Promise<string> {
        const wire = (this as unknown as { operations: typeof operations }).operations;
        await wire.call({ identity: "sales.Quote" } as RemoteOperation, {});
        return wire.channel;
      }
    },
  );
  configureProcess({ tracer: memoryTracer() });

  assert.equal(await boundedContext.execute(new CommandQuote()), "grpc://backend");
  assert.match(sent[0]?.headers?.traceparent ?? "", /^00-[0-9a-f]{32}-/);
});
