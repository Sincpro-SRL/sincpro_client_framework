/**
 * A day and an instant, as the server sends them — and the two conversions every client needs:
 * the server's instant to the wall clock of a zone, and back.
 *
 *     installTimeZone("America/La_Paz");                       once, for the company in use
 *     wallTimeOf("2026-03-12T14:30:00Z", timeZoneNow())   →  "2026-03-12T10:30"
 *     instantOf("2026-03-12T10:30", timeZoneNow())        →  "2026-03-12T14:30:00.000Z"
 *
 * Context: sincpro_framework sends a `datetime` as an instant (`2026-03-12T14:30:00Z`) and a
 * `date` as a day of the calendar (`2026-03-12`). A person reads and types the wall clock of
 * where the business is (10:30 in La Paz), on a browser or on a phone alike, so the conversion
 * is this package's and every platform draws with it. Which zone belongs to whoever is above the
 * screens — the application, the company the user works in — so it is installed once and every
 * instant follows it; without it, the platform's own. A day is never converted: turned into an
 * instant it lands on the day before west of Greenwich.
 *
 * Only `Intl.DateTimeFormat` with time zones is asked of the platform: browsers, Node and
 * Hermes (React Native) have it.
 */

let installed: string | undefined;

/** Install the time zone dates and times are read and written in (IANA: `"America/La_Paz"`);
 *  `undefined` goes back to the platform's. */
export function installTimeZone(timeZone: string | undefined): void {
  installed = timeZone;
}

/** The time zone in use. */
export function timeZoneNow(): string {
  return installed ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
}

const clocks = new Map<string, Intl.DateTimeFormat>();

/** One formatter per zone, kept: building one costs far more than using it. */
function clockOf(timeZone: string): Intl.DateTimeFormat {
  let clock = clocks.get(timeZone);
  if (clock === undefined) {
    clock = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    clocks.set(timeZone, clock);
  }
  return clock;
}

/** The wall clock of `timeZone` at `at` (ms), as the fields of a UTC date: what to compare. */
function wallAt(at: number, timeZone: string): number {
  const parts = Object.fromEntries(
    clockOf(timeZone)
      .formatToParts(new Date(at))
      .map((part) => [part.type, part.value]),
  );
  return Date.UTC(
    Number(parts["year"]),
    Number(parts["month"]) - 1,
    Number(parts["day"]),
    Number(parts["hour"]),
    Number(parts["minute"]),
    Number(parts["second"]),
  );
}

const pad = (n: number) => String(n).padStart(2, "0");

/** `"2026-03-12T14:30:00Z"` → `"2026-03-12T10:30"` in `America/La_Paz`: the wall clock there,
 *  as a date-and-time control reads it. `null` when it is not an instant. */
export function wallTimeOf(instant: string, timeZone: string): string | null {
  // A day alone is not an instant: `Date` would read it as midnight in UTC, the day before here.
  if (!/T\d{2}:\d{2}/.test(instant)) return null;
  const at = Date.parse(instant);
  if (Number.isNaN(at)) return null;
  const wall = new Date(wallAt(at, timeZone));
  return (
    `${wall.getUTCFullYear()}-${pad(wall.getUTCMonth() + 1)}-${pad(wall.getUTCDate())}` +
    `T${pad(wall.getUTCHours())}:${pad(wall.getUTCMinutes())}`
  );
}

/**
 * `"2026-03-12T10:30"` on the wall clock of `timeZone` → the instant, `"2026-03-12T14:30:00.000Z"`.
 * `null` when it is not a wall time.
 *
 * Context: the offset depends on the instant (daylight saving), so it is asked twice: at the
 * first guess, and again at the answer when the guess fell on the other side of a change.
 */
export function instantOf(wall: string, timeZone: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(wall);
  if (match === null) return null;
  const [, year, month, day, hour, minute] = match.map(Number) as number[];
  const guess = Date.UTC(year!, month! - 1, day!, hour!, minute!);
  const first = guess - (wallAt(guess, timeZone) - guess);
  const second = guess - (wallAt(first, timeZone) - first);
  return new Date(second).toISOString();
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A day of the calendar as the server writes it: `"2026-03-12"` — never an instant, never a day
 *  the calendar does not have (`"2026-02-30"`, which `Date` would roll into March). */
export function isDay(text: string): boolean {
  if (!DAY.test(text)) return false;
  const at = Date.parse(`${text}T00:00:00Z`);
  return !Number.isNaN(at) && new Date(at).toISOString().slice(0, 10) === text;
}

/** The day it is at `instant` on the wall clock of `timeZone`: what «today» means for a company.
 *  `null` when it is not an instant. */
export function dayOf(instant: string, timeZone: string): string | null {
  return wallTimeOf(instant, timeZone)?.slice(0, 10) ?? null;
}
