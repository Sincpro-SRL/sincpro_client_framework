import assert from "node:assert/strict";

import {
  configureProcess,
  type ContextStore,
  type ContextValues,
  memoryContexts,
  processContext,
} from "@sincpro/client-framework";
import { beforeEach, test } from "vitest";

import { project } from "../support/project";
import { RunningWith } from "../support/project/domain";

beforeEach(() => configureProcess());

test("the memory store keeps values by key, counts each change, and says who changed", () => {
  const store = memoryContexts();
  const heard: string[] = [];
  const stop = store.watch?.("process", () => heard.push("process"));
  assert.equal(store.load("process"), undefined);
  assert.equal(store.version("process"), 0);
  const given = { tenant_id: "acme" };
  store.save("process", given);
  given.tenant_id = "changed after";
  // A copy: whoever handed the values may keep changing their object.
  assert.deepEqual(store.load("process"), { tenant_id: "acme" });
  assert.equal(store.version("process"), 1);
  store.save("bounded_context:project", { company_id: 2 });
  store.delete("process");
  store.delete("process"); // nothing there: no change
  assert.equal(store.load("process"), undefined);
  assert.equal(store.version("process"), 2);
  stop?.();
  store.save("process", {});
  assert.deepEqual(heard, ["process", "process"]);
});

test("a level adds, replaces and clears names, and its values are one object per change", () => {
  processContext.set({ tenant_id: "acme", company_id: 1 });
  const first = processContext.values;
  assert.equal(processContext.values, first);
  processContext.set({ company_id: 2 });
  assert.notEqual(processContext.values, first);
  assert.deepEqual(processContext.values, { tenant_id: "acme", company_id: 2 });
  assert.equal(processContext.get("tenant_id"), "acme");
  processContext.clear("company_id");
  assert.deepEqual(processContext.values, { tenant_id: "acme" });
  processContext.clear();
  assert.deepEqual(processContext.values, {});
});

test("a screen hears a change: `watch` is bound, and stops when asked", () => {
  const { watch } = processContext;
  let heard = 0;
  const stop = watch(() => (heard += 1));
  processContext.set({ tenant_id: "acme" });
  project.context.set({ company_id: 2 }); // another level: not this one's listeners
  stop();
  processContext.set({ tenant_id: "beta" });
  assert.equal(heard, 1);
});

/** A store that parses what it keeps — a new object on every read — and cannot say it changed. */
function parsingStore(): ContextStore {
  const held = new Map<string, string>();
  const versions = new Map<string, number>();
  const moved = (key: string) => versions.set(key, (versions.get(key) ?? 0) + 1);
  return {
    load: (key) => {
      const text = held.get(key);
      return text === undefined ? undefined : (JSON.parse(text) as ContextValues);
    },
    save(key, values) {
      held.set(key, JSON.stringify(values));
      moved(key);
    },
    delete(key) {
      held.delete(key);
      moved(key);
    },
    version: (key) => versions.get(key) ?? 0,
  };
}

test("a platform's store plugs in: a new object per read is still one per change, and changes made here are heard", () => {
  configureProcess({ context: parsingStore() });
  let heard = 0;
  const stop = processContext.watch(() => (heard += 1));
  processContext.set({ tenant_id: "acme" });
  assert.equal(processContext.values, processContext.values);
  assert.deepEqual(processContext.values, { tenant_id: "acme" });
  processContext.clear();
  stop();
  assert.equal(heard, 2);
});

test("a screen that listens keeps listening when the process is configured after it started", () => {
  let heard = 0;
  const stop = processContext.watch(() => (heard += 1));
  configureProcess(); // another store: other values — said
  assert.equal(heard, 1);
  processContext.set({ tenant_id: "acme" }); // heard from the new store, not the old one
  assert.equal(heard, 2);
  stop();
  configureProcess();
  processContext.set({ tenant_id: "beta" });
  assert.equal(heard, 2);
});

test("configuring the process again starts from its own store: a test never sees another's context", async () => {
  processContext.set({ tenant_id: "acme" });
  project.context.set({ company_id: 2 });
  configureProcess();
  assert.deepEqual(processContext.values, {});
  assert.deepEqual(project.context.values, {});
  assert.deepEqual(await project.execute(new RunningWith()), {});
});
