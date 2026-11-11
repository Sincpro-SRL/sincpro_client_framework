import assert from "node:assert/strict";

import {
  ApplicationService,
  BoundedContext,
  Command,
  configureProcess,
  Feature,
} from "@sincpro/client-framework";
import { memoryTracer } from "@sincpro/client-framework/testing";
import { beforeEach, describe, test } from "vitest";

import { registerClass, type RegistrationStyle } from "../support/core-registration";

class CommandPrint extends Command<string> {
  constructor(readonly text: string) {
    super();
  }
}

/** A core service meant to be replaced by a subclass widens its name to `string`. */
class Print extends Feature<CommandPrint, string> {
  execute(command: CommandPrint): string {
    return `core ${command.text}`;
  }
}

/** What an application ships instead: a subclass of the core's, or a class of its own. */
class PrintOnBixolon extends Print {
  override execute(command: CommandPrint): string {
    return `bixolon ${command.text}`;
  }
}

class CommandCheckout extends Command<string> {}

class Checkout extends ApplicationService<CommandCheckout, string> {
  execute(): Promise<string> {
    return this.featureBus.execute(new CommandPrint("receipt"));
  }
}

class CheckoutOffline extends ApplicationService<CommandCheckout, string> {
  execute(): string {
    return "queued";
  }
}

function printing() {
  const context = new BoundedContext("printing");
  context.feature(CommandPrint)(Print);
  context.appService(CommandCheckout)(Checkout);
  return context;
}

beforeEach(() => configureProcess({ logger: { engine: false } }));

for (const style of [
  "function",
  "decorator",
  "legacy-decorator",
] satisfies RegistrationStyle[]) {
  describe(`${style} replacement`, () => {
    test("a service takes the place of the one registered, and its spans say which", async () => {
      const tracer = memoryTracer();
      configureProcess({ tracer, logger: { engine: false } });
      const context = printing();
      const Replacing = registerClass(
        style,
        PrintOnBixolon,
        context.feature(CommandPrint, { replaces: Print }),
      );
      assert.equal(context.handlerOf(CommandPrint), Replacing);
      assert.equal(await context.execute(new CommandCheckout()), "bixolon receipt");
      const printed = tracer.spans.find((span) => span.name === "printing/PrintOnBixolon");
      assert.equal(printed?.attributes["sincpro.replaces"], "Print");
    });
  });
}

test("an ApplicationService is replaced the same way; a running call keeps its generation", async () => {
  const context = printing();
  context.appService(CommandCheckoutAgain)(CheckoutAgain);
  assert.equal(await context.execute(new CommandCheckout()), "core receipt");
  context.appService(CommandCheckout, { replaces: Checkout })(CheckoutOffline);
  assert.equal(await context.execute(new CommandCheckout()), "queued");
  assert.equal(context.handlerOf(CommandCheckout), CheckoutOffline);
});

class CommandCheckoutAgain extends Command<string> {}
class CheckoutAgain extends ApplicationService<CommandCheckoutAgain, string> {
  execute(): string {
    return "again";
  }
}

test("a replacement names what is registered, or it is refused", () => {
  const context = printing();
  assert.throws(
    () => context.feature(CommandPrint, { replaces: PrintOnBixolon })(PrintOnBixolon),
    /Replacement does not match the registration: PrintOnBixolon/,
  );
  class CommandUnregistered extends Command<string> {}
  class Unregistered extends Feature<CommandUnregistered, string> {
    execute() {
      return "";
    }
  }
  assert.throws(
    () => context.feature(CommandUnregistered, { replaces: Print })(Unregistered),
    /does not match/,
  );
  assert.throws(() => context.feature(CommandPrint)(PrintOnBixolon), /already registered/);
});

test("fresh() keeps the replacement", async () => {
  const context = printing();
  context.feature(CommandPrint, { replaces: Print })(PrintOnBixolon);
  assert.equal(await context.fresh().execute(new CommandPrint("x")), "bixolon x");
});
