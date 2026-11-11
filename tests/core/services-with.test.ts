import assert from "node:assert/strict";

import {
  BoundedContext,
  Command,
  configureProcess,
  servicesWith,
} from "@sincpro/client-framework";
import { beforeEach, test } from "vitest";

/** The context's dependencies, once — the backend's `DependencyContextType`. */
interface SalesDependencies {
  prices: { of(sku: string): number };
  taxRate: number;
}

/** The context's bases — the backend's `class Feature(_Feature, DependencyContextType)`. */
const { Feature, ApplicationService } = servicesWith<SalesDependencies>();

class CommandPrice extends Command<number> {
  constructor(readonly sku: string) {
    super();
  }
}

class CommandQuote extends Command<number> {
  constructor(
    readonly sku: string,
    readonly quantity: number,
  ) {
    super();
  }
}

/** Uses its dependencies, typed, and declares none of them. */
class Price extends Feature<CommandPrice, number> {
  execute(command: CommandPrice): number {
    return this.prices.of(command.sku) * (1 + this.taxRate);
  }
}

class Quote extends ApplicationService<CommandQuote, number> {
  async execute(command: CommandQuote): Promise<number> {
    this.logger.info("Quoting");
    return (await this.featureBus.execute(new CommandPrice(command.sku))) * command.quantity;
  }
}

beforeEach(() => configureProcess({ logger: { engine: false } }));

test("a service finds every dependency of its context on `this`, typed, without declaring one", async () => {
  const salesBoundedContext = new BoundedContext<SalesDependencies>("sales");
  salesBoundedContext.addDependency("prices", { of: () => 10 });
  salesBoundedContext.addDependency("taxRate", 0.5);
  salesBoundedContext.feature(CommandPrice)(Price);
  salesBoundedContext.appService(CommandQuote)(Quote);
  assert.equal(await salesBoundedContext.execute(new CommandQuote("a1", 2)), 30);
  assert.ok(new Price() instanceof Price);
});

test("a dependency the context never supplied fails explicitly, as before", async () => {
  const salesBoundedContext = new BoundedContext<SalesDependencies>("sales");
  salesBoundedContext.addDependency("prices", { of: () => 10 });
  salesBoundedContext.feature(CommandPrice)(Price);
  await assert.rejects(
    salesBoundedContext.execute(new CommandPrice("a1")),
    /dependency or member is not registered: taxRate/,
  );
});

test("the typed bases are the framework's own classes: no other runtime behaviour", () => {
  const typed = servicesWith<SalesDependencies>();
  assert.equal(Object.getPrototypeOf(Price), typed.Feature);
  assert.equal(Object.getPrototypeOf(Quote), typed.ApplicationService);
});

export function typesOnly(): void {
  class Wrong extends Feature<CommandPrice, number> {
    execute(): number {
      // @ts-expect-error A dependency the context does not declare does not exist.
      return this.discount;
    }
  }
  void Wrong;
  // @ts-expect-error A service still implements execute.
  class Empty extends Feature<CommandPrice, number> {}
  void Empty;
}
