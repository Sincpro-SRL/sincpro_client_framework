import assert from "node:assert/strict";

import {
  BoundedContext,
  commandOf,
  configureProcess,
  Feature,
  type RemoteCommand,
} from "@sincpro/client-framework";
import { memoryTracer } from "@sincpro/client-framework/testing";
import { beforeEach, test } from "vitest";

/** What the generator writes for a contract exported with `--events`: types, and data. */
type IssueClosed = {
  name: "project.issue.v1.closed";
  issue_id: string;
  closed_by: string;
};
type CommandArchiveIssue = { issue_id: string };
const events = {
  IssueClosed: { name: "project.issue.v1.closed", recorded: true, handled: false },
} as const;
const operations = {
  CommandArchiveIssue: {
    identity: "project.CommandArchiveIssue",
    role: "command",
    query: false,
    entities: ["Issue"],
    targets: { Issue: "issue_id" },
  },
} as const;

/** A use case of a generated event and a generated Command: no class written for either. */
class Archive extends Feature<
  IssueClosed | RemoteCommand<CommandArchiveIssue, string>,
  string
> {
  execute(input: IssueClosed | RemoteCommand<CommandArchiveIssue, string>): string {
    return `archived ${input.issue_id}`;
  }
}

beforeEach(() => configureProcess({ logger: { engine: false } }));

function project() {
  const projectBoundedContext = new BoundedContext("project");
  projectBoundedContext.feature([events.IssueClosed, operations.CommandArchiveIssue])(
    Archive,
  );
  return projectBoundedContext;
}

test("a generated event and a generated Command are registered by their entries and executed as data", async () => {
  const tracer = memoryTracer();
  configureProcess({ tracer, logger: { engine: false } });
  const projectBoundedContext = project();
  const closed: IssueClosed = {
    name: "project.issue.v1.closed",
    issue_id: "i-1",
    closed_by: "ana",
  };
  assert.equal(await projectBoundedContext.execute(closed), "archived i-1");
  const answer: string = await projectBoundedContext.execute(
    commandOf<CommandArchiveIssue, string>(operations.CommandArchiveIssue, {
      issue_id: "i-2",
    }),
  );
  assert.equal(answer, "archived i-2");
  assert.deepEqual(
    tracer.spans.map((span) => [
      span.attributes["sincpro.event"],
      span.attributes["sincpro.command"],
    ]),
    [
      ["project.issue.v1.closed", undefined],
      [undefined, "project.CommandArchiveIssue"],
    ],
  );
  assert.equal(
    projectBoundedContext.eventTypeOf("project.issue.v1.closed"),
    events.IssueClosed,
  );
  assert.equal(
    projectBoundedContext.commandTypeOf("project.CommandArchiveIssue"),
    operations.CommandArchiveIssue,
  );
  assert.equal(projectBoundedContext.handlerOf(events.IssueClosed), Archive);
});

test("a generated DTO nobody here registered fails, as an unknown Command does", async () => {
  const projectBoundedContext = project();
  await assert.rejects(
    projectBoundedContext.execute({ name: "project.issue.v1.reopened" }),
    /No executor registered for project.issue.v1.reopened/,
  );
  await assert.rejects(
    projectBoundedContext.execute(commandOf({ identity: "project.CommandDelete" }, {})),
    /No executor registered for project.CommandDelete/,
  );
});

test("the identity a generated Command carries never travels with its data", () => {
  const command = commandOf(operations.CommandArchiveIssue, { issue_id: "i-3" });
  assert.deepEqual(JSON.parse(JSON.stringify(command)), { issue_id: "i-3" });
  assert.deepEqual({ ...command }, { issue_id: "i-3" });
});

test("an interceptor passes on only the generated DTO it received", async () => {
  const projectBoundedContext = project();
  projectBoundedContext.interceptor(events.IssueClosed)((event, next) =>
    next({ ...event, name: "project.issue.v1.reopened" }),
  );
  await assert.rejects(
    projectBoundedContext.execute({
      name: "project.issue.v1.closed",
      issue_id: "i",
      closed_by: "x",
    }),
    /passed on a project.issue.v1.reopened where it received a project.issue.v1.closed/,
  );
});
