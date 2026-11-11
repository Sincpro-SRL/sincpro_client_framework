import assert from "node:assert/strict";

import {
  BoundedContext,
  Command,
  configureProcess,
  DomainEvent,
  type DtoKey,
  Feature,
} from "@sincpro/client-framework";
import { memoryTracer } from "@sincpro/client-framework/testing";
import { beforeEach, describe, test } from "vitest";

import { registerClass, type RegistrationStyle } from "../support/core-registration";

class CommandPrintImage extends Command<string> {
  static readonly commandName = "common.CommandPrintImage";
  constructor(readonly image: string) {
    super();
  }
}

class PrintImageRequested extends DomainEvent {
  static readonly eventName = "common.print.v1.requested";
  constructor(readonly image: string) {
    super();
  }
}

class CommandReprint extends Command<string> {
  constructor(readonly image: string) {
    super();
  }
}

/** One use case, executed by a screen (the Command) or by the queue (the event). */
class PrintImage extends Feature<
  CommandPrintImage | PrintImageRequested | CommandReprint,
  string
> {
  static instances = 0;
  constructor() {
    super();
    PrintImage.instances++;
  }
  execute(input: CommandPrintImage | PrintImageRequested | CommandReprint): string {
    return `printed ${input.image}`;
  }
}

beforeEach(() => {
  PrintImage.instances = 0;
  configureProcess({ logger: { engine: false } });
});

for (const style of [
  "function",
  "decorator",
  "legacy-decorator",
] as const satisfies readonly RegistrationStyle[]) {
  describe(`registered as a ${style}`, () => {
    test("one service takes N DTOs — Commands and events —, one instance, and its spans say which ran it", async () => {
      const tracer = memoryTracer();
      configureProcess({ tracer, logger: { engine: false } });
      const commonBoundedContext = new BoundedContext("common");
      const Registered = registerClass(
        style,
        PrintImage,
        commonBoundedContext.feature([
          CommandPrintImage,
          PrintImageRequested,
          CommandReprint,
        ]),
      );
      assert.equal(
        await commonBoundedContext.execute(new CommandPrintImage("a")),
        "printed a",
      );
      assert.equal(
        await commonBoundedContext.execute(new PrintImageRequested("b")),
        "printed b",
      );
      assert.equal(await commonBoundedContext.execute(new CommandReprint("c")), "printed c");
      assert.equal(PrintImage.instances, 1);
      for (const dto of [CommandPrintImage, PrintImageRequested, CommandReprint])
        assert.equal(commonBoundedContext.handlerOf(dto), Registered);
      assert.deepEqual(
        tracer.spans.map((span) => [
          span.name,
          span.attributes["sincpro.command"],
          span.attributes["sincpro.event"],
        ]),
        [
          ["common/PrintImage", "common.CommandPrintImage", undefined],
          ["common/PrintImage", undefined, "common.print.v1.requested"],
          ["common/PrintImage", undefined, undefined],
        ],
      );
      assert.equal(
        commonBoundedContext.commandTypeOf("common.CommandPrintImage"),
        CommandPrintImage,
      );
      assert.equal(
        commonBoundedContext.eventTypeOf("common.print.v1.requested"),
        PrintImageRequested,
      );
    });
  });
}

test("a replacement takes every DTO listed; a DTO it does not have refuses it", () => {
  class PrintOnBixolon extends PrintImage {}
  const commonBoundedContext = new BoundedContext("common");
  commonBoundedContext.feature([CommandPrintImage, PrintImageRequested])(PrintImage);
  assert.throws(
    () =>
      commonBoundedContext.feature([CommandPrintImage, CommandReprint], {
        replaces: PrintImage,
      })(PrintOnBixolon),
    /does not match/,
  );
  commonBoundedContext.feature([CommandPrintImage, PrintImageRequested], {
    replaces: PrintImage,
  })(PrintOnBixolon);
  assert.equal(commonBoundedContext.handlerOf(CommandPrintImage), PrintOnBixolon);
  assert.equal(commonBoundedContext.handlerOf(PrintImageRequested), PrintOnBixolon);
});

test("a DTO still has one service, an identity or a wire name means one DTO, and a list is not empty", () => {
  class Other extends Feature<CommandPrintImage, string> {
    execute() {
      return "";
    }
  }
  class SameIdentity extends Command<string> {
    static readonly commandName = "common.CommandPrintImage";
  }
  const commonBoundedContext = new BoundedContext("common");
  commonBoundedContext.feature([CommandPrintImage, PrintImageRequested])(PrintImage);
  assert.throws(
    () => commonBoundedContext.feature(CommandPrintImage)(Other),
    /already registered/,
  );
  assert.throws(
    () => commonBoundedContext.feature(SameIdentity)(Other),
    /Command identity already registered: common.CommandPrintImage/,
  );
  const none: DtoKey[] = [];
  assert.throws(() => commonBoundedContext.feature(none)(Other), /one DTO at least/);
});

test("an interceptor and a listener for one DTO of the list see only that one", async () => {
  const commonBoundedContext = new BoundedContext("common");
  commonBoundedContext.feature([CommandPrintImage, PrintImageRequested])(PrintImage);
  const seen: string[] = [];
  commonBoundedContext.interceptor(PrintImageRequested)(async (event, next) => {
    seen.push(`intercepted ${event.image}`);
    return next(event);
  });
  commonBoundedContext.onCompletion(
    (done) => seen.push(`completed ${String(done.answer)}`),
    PrintImageRequested,
  );
  await commonBoundedContext.execute(new CommandPrintImage("a"));
  await commonBoundedContext.execute(new PrintImageRequested("b"));
  assert.deepEqual(seen, ["intercepted b", "completed printed b"]);
});
