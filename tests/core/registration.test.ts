import assert from "node:assert/strict";

import { configureProcess } from "@sincpro/client-framework";
import { BoundedContext, Feature } from "@sincpro/client-framework/core";
import { memoryReporter, memoryTracer } from "@sincpro/client-framework/testing";
import { beforeEach, describe, test } from "vitest";

import {
  CancelIssue,
  CommandCancelIssue,
  CommandRequestCancellation,
  type ProjectDependencies,
  RequestCancellation,
  ResponseCancelIssue,
} from "../support/core";
import { registerClass, type RegistrationStyle } from "../support/core-registration";

function contextOf() {
  const calls: string[] = [];
  const client: ProjectDependencies["client"] = {
    async cancelIssue(dto) {
      calls.push(dto.issue_id);
      return { issue_id: dto.issue_id, resolution: "cancelled" };
    },
    async sendIssue(dto) {
      return { issue_id: dto.issue_id, run_id: "r-1", status: dto.message };
    },
  };
  const context = new BoundedContext<ProjectDependencies>("project");
  context.addDependency("client", client);
  context.addDependency("access", {
    requireCancellation() {
      calls.push("authorized");
    },
  });
  return { context, client, calls };
}

beforeEach(() => configureProcess());

for (const style of [
  "function",
  "decorator",
  "legacy-decorator",
] satisfies RegistrationStyle[]) {
  describe(`${style} registration contract`, () => {
    test("executes a Feature with injected dependencies and a class Response", async () => {
      const { context, calls } = contextOf();
      registerClass(style, CancelIssue, context.feature(CommandCancelIssue));
      const response = await context.execute(new CommandCancelIssue("x"));
      assert.ok(response instanceof ResponseCancelIssue);
      assert.equal(response.resolution, "cancelled");
      assert.deepEqual(calls, ["x"]);
    });

    test("composes an ApplicationService with the same tracing and dependency contract", async () => {
      const tracer = memoryTracer();
      configureProcess({ tracer });
      const { context, calls } = contextOf();
      registerClass(style, CancelIssue, context.feature(CommandCancelIssue));
      registerClass(
        style,
        RequestCancellation,
        context.appService(CommandRequestCancellation),
      );
      const response = await context.execute(new CommandRequestCancellation("x"));
      assert.equal(response.resolution, "cancelled");
      assert.deepEqual(calls, ["authorized", "x"]);
      assert.deepEqual(
        tracer.spans.map((span) => span.name),
        ["project/RequestCancellation", "project/CancelIssue"],
      );
      assert.equal(tracer.spans[1]?.parentSpanId, tracer.spans[0]?.spanId);
      assert.equal(tracer.spans[1]?.traceId, tracer.spans[0]?.traceId);
    });

    test("rejects duplicate DTO registrations across execution layers", () => {
      const { context } = contextOf();
      registerClass(style, CancelIssue, context.feature(CommandCancelIssue));
      assert.throws(
        () =>
          registerClass(style, RequestCancellation, context.appService(CommandCancelIssue)),
        /already registered/,
      );
    });

    test("rejects the wrong execution layer", () => {
      const { context } = contextOf();
      assert.throws(
        () =>
          registerClass(
            style,
            RequestCancellation,
            context.feature(CommandRequestCancellation),
          ),
        /not an feature/,
      );
    });

    test("propagates failures and reports once across both service layers", async () => {
      const tracer = memoryTracer();
      const reporter = memoryReporter();
      configureProcess({ tracer, reporter });
      const { context, client } = contextOf();
      const failure = new Error("backend unavailable");
      context.addDependency(
        "client",
        {
          ...client,
          async cancelIssue() {
            throw failure;
          },
        },
        { replaces: client },
      );
      registerClass(style, CancelIssue, context.feature(CommandCancelIssue));
      registerClass(
        style,
        RequestCancellation,
        context.appService(CommandRequestCancellation),
      );
      await assert.rejects(
        context.execute(new CommandRequestCancellation("x")),
        (error) => error === failure,
      );
      assert.equal(reporter.reports.length, 1);
      assert.ok(tracer.spans.every((span) => span.outcome === "failed"));
    });

    test("late registration rebuilds the next generation", async () => {
      const { context, client } = contextOf();
      registerClass(style, CancelIssue, context.feature(CommandCancelIssue));
      await context.execute(new CommandCancelIssue("first"));
      registerClass(
        style,
        RequestCancellation,
        context.appService(CommandRequestCancellation),
      );
      context.addDependency(
        "client",
        {
          ...client,
          async cancelIssue(dto) {
            return { issue_id: dto.issue_id, resolution: "new" };
          },
        },
        { replaces: client },
      );
      assert.equal(
        (await context.execute(new CommandRequestCancellation("next"))).resolution,
        "new",
      );
    });

    test("the service's name is the framework's to take at registration: its class's, as written", async () => {
      const tracer = memoryTracer();
      configureProcess({ tracer, logger: { engine: false } });
      class CancelForGood extends Feature<CommandCancelIssue, ResponseCancelIssue> {
        execute(dto: CommandCancelIssue) {
          return new ResponseCancelIssue(dto.issue_id, "cancelled");
        }
      }
      const context = new BoundedContext("project");
      registerClass(style, CancelForGood, context.feature(CommandCancelIssue));
      await context.execute(new CommandCancelIssue("i-1"));
      assert.equal(tracer.spans[0]?.name, "project/CancelForGood");
      const Anonymous = (() =>
        class extends Feature<CommandCancelIssue, ResponseCancelIssue> {
          execute(dto: CommandCancelIssue) {
            return new ResponseCancelIssue(dto.issue_id, "cancelled");
          }
        })();
      if (style === "function")
        assert.throws(
          () => new BoundedContext("other").feature(CommandCancelIssue)(Anonymous),
          /named class/,
        );
    });
  });
}
