import assert from "node:assert/strict";

import {
  configureProcess,
  dayOf,
  installTimeZone,
  instantOf,
  isDay,
  momentOf,
  newEntityId,
  timeZoneNow,
  timeZoneOf,
  wallTimeOf,
} from "@sincpro/client-framework";
import { afterEach, test } from "vitest";

afterEach(() => {
  installTimeZone(undefined);
  configureProcess();
});

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
  // A day the calendar does not have, which `Date` would roll into the next month.
  assert.equal(isDay("2026-02-30"), false);
  assert.equal(isDay("2026-02-29"), false);
  assert.equal(isDay("2028-02-29"), true);
  // A day alone is not an instant: never read as midnight in UTC, the day before here.
  assert.equal(dayOf("2026-11-07", "America/La_Paz"), null);
  assert.equal(wallTimeOf("2026-11-07", "America/La_Paz"), null);
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

test("a run reads its time zone from its context, under time_zone by default", () => {
  installTimeZone("Europe/Madrid");
  assert.equal(timeZoneOf({ time_zone: "America/La_Paz" }), "America/La_Paz");
  // An execution is read through its context.
  assert.equal(
    timeZoneOf({ useCase: "sales.Close", context: { time_zone: "America/La_Paz" } }),
    "America/La_Paz",
  );
});

test("without a zone in its context, a run reads the process's", () => {
  installTimeZone("Europe/Madrid");
  assert.equal(timeZoneOf({}), "Europe/Madrid");
  assert.equal(timeZoneOf({ time_zone: "  " }), "Europe/Madrid");
  installTimeZone(undefined);
  assert.equal(timeZoneOf({}), Intl.DateTimeFormat().resolvedOptions().timeZone);
});

test("the application names the key its zone is kept under; the first found wins", () => {
  configureProcess({ timeZone: { keys: "company_zone" } });
  assert.equal(
    timeZoneOf({ company_zone: "America/La_Paz", time_zone: "Europe/Madrid" }),
    "America/La_Paz",
  );
  // The default key no longer counts once another is named.
  installTimeZone("Europe/Madrid");
  assert.equal(timeZoneOf({ time_zone: "America/La_Paz" }), "Europe/Madrid");

  configureProcess({ timeZone: { keys: ["zone", "company_zone"] } });
  assert.equal(timeZoneOf({ company_zone: "America/La_Paz" }), "America/La_Paz");
  assert.equal(
    timeZoneOf({ zone: "Asia/Tokyo", company_zone: "America/La_Paz" }),
    "Asia/Tokyo",
  );

  // configureProcess replaces everything: without keys, the default comes back.
  configureProcess();
  assert.equal(timeZoneOf({ time_zone: "America/La_Paz" }), "America/La_Paz");
});

test("two runs with different zones cut «today» differently", () => {
  // 02:00 UTC on 12 March: still the 11th in La Paz, already the 12th in Madrid.
  const instant = "2026-03-12T02:00:00Z";
  const laPaz = { useCase: "sales.Close", context: { time_zone: "America/La_Paz" } };
  const madrid = { useCase: "sales.Close", context: { time_zone: "Europe/Madrid" } };
  assert.equal(dayOf(instant, timeZoneOf(laPaz)), "2026-03-11");
  assert.equal(dayOf(instant, timeZoneOf(madrid)), "2026-03-12");
});
