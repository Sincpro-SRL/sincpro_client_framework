import assert from "node:assert/strict";

import {
  dayOf,
  installTimeZone,
  instantOf,
  isDay,
  momentOf,
  newEntityId,
  timeZoneNow,
  wallTimeOf,
} from "@sincpro/client-framework";
import { afterEach, test } from "vitest";

afterEach(() => installTimeZone(undefined));

test("an instant reads on the wall clock of the zone, and a wall time goes back to it", () => {
  // La Paz is UTC−4 all year.
  assert.equal(wallTimeOf("2026-03-12T14:30:00Z", "America/La_Paz"), "2026-03-12T10:30");
  assert.equal(instantOf("2026-03-12T10:30", "America/La_Paz"), "2026-03-12T14:30:00.000Z");
  // Past midnight on the wall clock is the day before in UTC, and back.
  assert.equal(wallTimeOf("2026-03-13T02:00:00Z", "America/La_Paz"), "2026-03-12T22:00");
  assert.equal(instantOf("2026-03-12T22:00", "America/La_Paz"), "2026-03-13T02:00:00.000Z");
});

test("the offset is the one of THAT day: daylight saving on either side of the change", () => {
  // New York: UTC−5 in winter, UTC−4 from 8 March 2026.
  assert.equal(instantOf("2026-03-07T09:00", "America/New_York"), "2026-03-07T14:00:00.000Z");
  assert.equal(instantOf("2026-03-09T09:00", "America/New_York"), "2026-03-09T13:00:00.000Z");
  assert.equal(wallTimeOf("2026-07-01T13:00:00Z", "America/New_York"), "2026-07-01T09:00");
});

test("what is not an instant or a wall time is nothing, never an error", () => {
  assert.equal(wallTimeOf("tomorrow", "America/La_Paz"), null);
  assert.equal(instantOf("10:30", "America/La_Paz"), null);
  assert.equal(dayOf("tomorrow", "America/La_Paz"), null);
});

test("the zone in use is the one installed, else the platform's", () => {
  installTimeZone("America/La_Paz");
  assert.equal(timeZoneNow(), "America/La_Paz");
  installTimeZone(undefined);
  assert.equal(timeZoneNow(), Intl.DateTimeFormat().resolvedOptions().timeZone);
});

test("a day is a day of the calendar: «today» depends on the company's zone, never the UTC date", () => {
  assert.equal(isDay("2026-03-12"), true);
  assert.equal(isDay("2026-03-12T00:00:00Z"), false);
  assert.equal(isDay("2026-13-40"), false);
  // 02:00 UTC on the 13th is still the 12th in La Paz.
  assert.equal(dayOf("2026-03-13T02:00:00Z", "America/La_Paz"), "2026-03-12");
  assert.equal(dayOf("2026-03-13T02:00:00Z", "Europe/Madrid"), "2026-03-13");
});

test("an id says when it was minted, as sincpro_framework's moment_of; another key says nothing", () => {
  // Far ahead of any id minted before it, so the clock that never runs backwards keeps it.
  const at = Date.UTC(2099, 9, 2, 7, 53, 21, 153);
  const id = newEntityId(at);
  assert.equal(momentOf(id), "2099-10-02T07:53:21.153Z");
  // With hyphens too — how other libraries write a UUID v7.
  const hyphened = id.replace(/^(.{8})(.{4})(.{4})(.{4})/, "$1-$2-$3-$4-");
  assert.equal(momentOf(hyphened), "2099-10-02T07:53:21.153Z");
  assert.equal(momentOf("acme-3"), null);
  assert.equal(momentOf("f47ac10b58cc4372a5670e02b2c3d479"), null); // a UUID v4
});
