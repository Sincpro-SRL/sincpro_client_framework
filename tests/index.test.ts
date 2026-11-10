import assert from "node:assert/strict";

import * as entry from "@sincpro/client-framework";
import * as core from "@sincpro/client-framework/core";
import { test } from "vitest";

/**
 * What the package offers at runtime, named once: adding or removing a public value is a
 * decision, made here on purpose, never a side effect of moving a file.
 */
const PUBLIC = [
  "ApplicationService",
  "BIND",
  "BYTES",
  "BoundedContext",
  "CONTEXT_HEADER",
  "Command",
  "DataTransferObject",
  "Decimal",
  "Feature",
  "FeatureBus",
  "Money",
  "NEW_PARAM",
  "NO_TRACER",
  "PICK_PARAM",
  "QUERY_PARAM",
  "Response",
  "SCOPE_PARAM",
  "TRAIL_PARAM",
  "TransportError",
  "WITH_PARAM",
  "bindTransport",
  "bindable",
  "bodyFor",
  "collectionOf",
  "combineLoggers",
  "completeMeta",
  "configureLogger",
  "configureProcess",
  "dayOf",
  "defineMeta",
  "downloadRoute",
  "entity",
  "entityKeyOf",
  "exportRoute",
  "field",
  "headersOf",
  "installTimeZone",
  "instantOf",
  "isCollection",
  "isDay",
  "isEntityId",
  "isPartial",
  "kindOf",
  "listRoute",
  "logger",
  "loggerAdapter",
  "memoryContexts",
  "memoryTransport",
  "metaFromSchema",
  "metaStore",
  "metasOf",
  "momentOf",
  "newEntityId",
  "outcomeOf",
  "pack",
  "pathFor",
  "plainCodec",
  "processContext",
  "readRoute",
  "readValues",
  "rebuilt",
  "relatedCriteria",
  "reportError",
  "restTransport",
  "retryKeys",
  "scopeOfRef",
  "screensTransport",
  "startingValuesOf",
  "timeZoneNow",
  "totalOf",
  "travelling",
  "travels",
  "unanswered",
  "unpack",
  "urlOf",
  "valuesOf",
  "versionsOf",
  "wallTimeOf",
  "writeRoute",
];

test("the package entry loads in Node, with no browser and no React, and offers what it names", () => {
  assert.deepEqual(Object.keys(entry).sort(), [...PUBLIC].sort());
});

test("./core is the application layer and the process it runs in, and the same values", () => {
  assert.deepEqual(Object.keys(core).sort(), [
    "ApplicationService",
    "BoundedContext",
    "Command",
    "DataTransferObject",
    "Feature",
    "FeatureBus",
    "Response",
    "configureLogger",
    "configureProcess",
    "screensTransport",
  ]);
  for (const [name, value] of Object.entries(core))
    assert.equal(entry[name as keyof typeof entry], value);
});
