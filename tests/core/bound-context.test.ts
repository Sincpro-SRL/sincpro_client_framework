import assert from "node:assert/strict";

import {
  BoundedContext,
  Command,
  configureProcess,
  Feature,
} from "@sincpro/client-framework";
import { memoryReporter, memoryTracer } from "@sincpro/client-framework/testing";
import { beforeEach, test } from "vitest";

class CommandReserveStock extends Command<string> {
  constructor(
    readonly sku: string,
    readonly fail?: Error,
  ) {
    super();
  }
}

class CommandConfirmOrder extends Command<string> {
  constructor(
    readonly sku: string,
    readonly fail?: Error,
  ) {
    super();
  }
}

const signals: (AbortSignal | undefined)[] = [];

class ReserveStock extends Feature<CommandReserveStock, string> {
  static readonly serviceName = "ReserveStock";
  async execute(command: CommandReserveStock): Promise<string> {
    if (command.fail) throw command.fail;
    signals.push(this.signal);
    if (this.signal) await new Promise((resolve) => setTimeout(resolve, 50));
    return `${command.sku} reserved for ${String(this.context.tenant_id)}`;
  }
}

type SalesDependencies = { stockBoundedContext: BoundedContext };

class ConfirmOrder extends Feature<CommandConfirmOrder, string> {
  static readonly serviceName = "ConfirmOrder";
  declare readonly stockBoundedContext: BoundedContext;
  execute(command: CommandConfirmOrder): Promise<string> {
    return this.stockBoundedContext.execute(
      new CommandReserveStock(command.sku, command.fail),
    );
  }
}

function contexts() {
  const stockBoundedContext = new BoundedContext("stock");
  stockBoundedContext.feature(CommandReserveStock)(ReserveStock);
  stockBoundedContext.context.set({ tenant_id: "stock-tenant" });
  const salesBoundedContext = new BoundedContext<SalesDependencies>("sales");
  salesBoundedContext.addDependency("stockBoundedContext", stockBoundedContext);
  salesBoundedContext.feature(CommandConfirmOrder)(ConfirmOrder);
  salesBoundedContext.context.set({ tenant_id: "sales-tenant" });
  return { stockBoundedContext, salesBoundedContext };
}

beforeEach(() => configureProcess({ logger: { engine: false } }));

test("a bounded context injected into a run executes as its child, with its own context", async () => {
  const tracer = memoryTracer();
  configureProcess({ tracer, logger: { engine: false } });
  const { salesBoundedContext } = contexts();
  assert.equal(
    await salesBoundedContext.execute(new CommandConfirmOrder("sku-1")),
    "sku-1 reserved for stock-tenant",
  );
  const [order, stock] = tracer.spans;
  assert.deepEqual(
    tracer.spans.map((span) => span.name),
    ["sales/ConfirmOrder", "stock/ReserveStock"],
  );
  assert.equal(stock?.parentSpanId, order?.spanId);
  assert.equal(
    stock?.attributes["sincpro.correlation_id"],
    order?.attributes["sincpro.correlation_id"],
  );
  assert.equal(
    stock?.attributes["sincpro.causation_id"],
    order?.attributes["sincpro.execution_id"],
  );
});

test("a failure along two bounded contexts is reported once; the caller's signal cancels both", async () => {
  const reporter = memoryReporter();
  configureProcess({ reporter, logger: { engine: false } });
  const { salesBoundedContext } = contexts();
  await assert.rejects(
    salesBoundedContext.execute(new CommandConfirmOrder("sku-2", new Error("disk"))),
    /disk/,
  );
  assert.equal(reporter.reports.length, 1);
  assert.equal(reporter.reports[0]?.about.useCase, "stock.ReserveStock");

  const controller = new AbortController();
  const running = salesBoundedContext.execute(new CommandConfirmOrder("sku-3"), {
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(running, { name: "AbortError" });
  assert.equal(signals.at(-1), controller.signal);
  assert.equal(reporter.reports.length, 1);
});

test("outside a run a bounded context is itself: a root of its own flow", async () => {
  const tracer = memoryTracer();
  configureProcess({ tracer, logger: { engine: false } });
  const { stockBoundedContext } = contexts();
  await stockBoundedContext.execute(new CommandReserveStock("sku-4"));
  assert.equal(tracer.spans[0]?.parentSpanId, undefined);
  assert.equal(stockBoundedContext.name, "stock");
});
