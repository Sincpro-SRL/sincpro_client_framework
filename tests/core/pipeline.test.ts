import assert from "node:assert/strict";

import {
  ApplicationService,
  BoundedContext,
  Command,
  configureProcess,
  DomainEvent,
  type ExecutionCompleted,
  type ExecutionFailed,
  type ExecutionStarted,
  Feature,
} from "@sincpro/client-framework";
import {
  memoryLogger,
  memoryReporter,
  memoryTracer,
} from "@sincpro/client-framework/testing";
import { beforeEach, test } from "vitest";

class NoCredit extends Error {}

class CommandPay extends Command<string> {
  constructor(
    readonly amount: number,
    readonly fail?: Error,
  ) {
    super();
  }
}

class CommandCheckout extends Command<string> {
  constructor(readonly amount: number) {
    super();
  }
}

class Paid extends DomainEvent {
  static readonly eventName = "shop.payment.v1.paid";
}

class Pay extends Feature<CommandPay, string> {
  execute(command: CommandPay): string {
    if (command.fail) throw command.fail;
    return `paid ${command.amount}`;
  }
}

class Checkout extends ApplicationService<CommandCheckout, string> {
  execute(command: CommandCheckout): Promise<string> {
    return this.featureBus.execute(new CommandPay(command.amount));
  }
}

class Thank extends Feature<Paid, string> {
  execute(): string {
    return "thanks";
  }
}

function shop() {
  const context = new BoundedContext("shop");
  context.feature(CommandPay)(Pay);
  context.appService(CommandCheckout)(Checkout);
  context.feature(Paid)(Thank);
  return context;
}

beforeEach(() => configureProcess({ logger: { engine: false } }));

test("an interceptor vetoes inside the run: the failure is observed and answered like any other", async () => {
  const tracer = memoryTracer();
  const reporter = memoryReporter();
  configureProcess({ tracer, reporter, logger: { engine: false } });
  const context = shop();
  context.interceptor(CommandPay)((command, next) => {
    if (command.amount > 100) throw new NoCredit();
    return next(command);
  });
  assert.equal(await context.execute(new CommandPay(10)), "paid 10");
  await assert.rejects(context.execute(new CommandPay(500)), NoCredit);
  assert.equal(tracer.spans[1]?.outcome, "failed");
  assert.equal(reporter.reports.length, 1);
  context.expectErrors(NoCredit).addFeatureErrorHandler(() => "declined");
  assert.equal(await context.execute(new CommandPay(500)), "declined");
  assert.equal(reporter.reports.length, 1);
});

test("interceptors run outermost first, adjust what they pass on, or answer by themselves", async () => {
  const order: string[] = [];
  const context = shop();
  context.interceptor()(async (executable, next) => {
    order.push("outer");
    return next(executable);
  });
  context.interceptor(CommandPay)((command, next) => {
    order.push("inner");
    return next(new CommandPay(command.amount * 2));
  });
  assert.equal(await context.execute(new CommandPay(5)), "paid 10");
  assert.deepEqual(order, ["outer", "inner"]);
  context.interceptor(CommandPay)(() => "cached");
  assert.equal(await context.execute(new CommandPay(5)), "cached");
});

test("an interceptor that passes on another class is refused: the bus routes by class", async () => {
  const context = shop();
  // The two have one shape, so TypeScript cannot tell them apart: the runtime guard does.
  context.interceptor(CommandCheckout)((_command, next) => next(new CommandPay(1)));
  await assert.rejects(
    context.execute(new CommandCheckout(1)),
    /passed on a CommandPay where it received a CommandCheckout/,
  );
});

test("an interceptor sees its run, wraps events too, and stops from the next call", async () => {
  const context = shop();
  const seen: string[] = [];
  const watch = context.interceptor()((executable, next, run) => {
    seen.push(
      `${run.useCase} ${run.layer} ${run.execution.correlationId === run.execution.id}`,
    );
    return next(executable);
  });
  await context.execute(new Paid());
  await context.execute(new CommandCheckout(1));
  assert.deepEqual(seen, [
    "shop.Thank feature true",
    "shop.Checkout application_service true",
    "shop.Pay feature false",
  ]);
  context.withoutInterceptor(watch);
  await context.execute(new Paid());
  assert.equal(seen.length, 3);
});

test("listeners hear each run start and answer, filtered by class; hearing never changes the answer", async () => {
  const context = shop();
  const started: ExecutionStarted[] = [];
  const completed: ExecutionCompleted[] = [];
  context.onStart((heard) => started.push(heard));
  const stop = context.onCompletion((heard) => completed.push(heard), CommandPay);
  context.onCompletion(() => {
    throw new Error("a listener that breaks");
  });
  assert.equal(await context.execute(new CommandCheckout(3)), "paid 3");
  assert.deepEqual(
    started.map((one) => one.execution.useCase),
    ["shop.Checkout", "shop.Pay"],
  );
  assert.deepEqual(
    completed.map((one) => [one.execution.useCase, one.answer]),
    [["shop.Pay", "paid 3"]],
  );
  stop();
  await context.execute(new CommandPay(1));
  assert.equal(completed.length, 1);
});

test("a failure that escapes is heard once, where it failed; one a handler answered is not", async () => {
  const context = shop();
  const failed: ExecutionFailed[] = [];
  context.onFailure((heard) => failed.push(heard));
  const broken = new Error("gateway down");
  await assert.rejects(context.execute(new CommandPay(1, broken)));
  assert.equal(failed.length, 1);
  assert.equal(failed[0]?.error, broken);
  assert.equal(failed[0]?.execution?.useCase, "shop.Pay");
  assert.equal(failed[0]?.outcome, "failed");
  context.addGlobalErrorHandler(() => "recovered");
  assert.equal(await context.execute(new CommandPay(1, broken)), "recovered");
  assert.equal(failed.length, 1);
  class CommandUnknown extends Command<string> {}
  const bare = new BoundedContext("bare");
  bare.onFailure((heard) => failed.push(heard));
  await assert.rejects(bare.execute(new CommandUnknown()));
  assert.equal(failed[1]?.execution, undefined);
});

test("a run joins its flow: children share the correlation, a delivered event continues its envelope's", async () => {
  const tracer = memoryTracer();
  const engine = memoryLogger();
  configureProcess({ tracer, logger: { engine } });
  const context = shop();
  await context.execute(new CommandCheckout(1));
  const [checkout, pay] = tracer.spans;
  assert.equal(
    pay?.attributes["sincpro.correlation_id"],
    checkout?.attributes["sincpro.execution_id"],
  );
  assert.equal(
    pay?.attributes["sincpro.causation_id"],
    checkout?.attributes["sincpro.execution_id"],
  );
  assert.equal(checkout?.attributes["sincpro.causation_id"], undefined);
  await context.execute(new Paid(), { id: "event-1", correlationId: "flow-1" });
  const thank = tracer.spans.at(-1);
  assert.equal(thank?.attributes["sincpro.correlation_id"], "flow-1");
  assert.equal(thank?.attributes["sincpro.causation_id"], "event-1");
  assert.ok(
    engine.records
      .filter((one) => one.useCase === "shop.Thank")
      .every((one) => one.correlationId === "flow-1"),
  );
});

test("extend wires a component in one place, and fresh() keeps what it registered", async () => {
  const heard: string[] = [];
  const auditing = (context: BoundedContext) => {
    context.interceptor()((executable, next, run) => {
      heard.push(`intercepted ${run.useCase}`);
      return next(executable);
    });
    context.onCompletion((done) => heard.push(`completed ${done.execution.useCase}`));
  };
  const context = shop().extend(auditing);
  await context.fresh().execute(new CommandPay(1));
  assert.deepEqual(heard, ["intercepted shop.Pay", "completed shop.Pay"]);
});
