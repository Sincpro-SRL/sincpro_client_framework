/**
 * A new record's key, minted where the record is born: a UUID v7 as 32 hex characters —
 * sincpro_framework's `new_entity_id`.
 *
 * Context: sincpro_framework's `Edit` creates a new record under the id the CLIENT names («a
 * UUID v7 it mints»), and the draft and the stored record share it from the first draft save.
 * A form that waited for the server to name it could neither keep a draft of a new record nor
 * reach the edit route at all (`PUT /invoices/{id}/edit` needs the id in its path). The layout
 * is the backend's (RFC 9562): 48 bits of unix milliseconds, the version, a 12-bit counter
 * within the millisecond, the variant and 62 random bits — so ids minted here sort by when
 * they were minted, like the server's, and ordering by `id` is still ordering by creation.
 *
 *     newEntityId()   // "019a4c2e7f1074a8b13fa739ccbdcd53"
 */

const COUNTER_MAX = 0xfff;

let lastMillis = -1;
let counter = 0;

function randomBytes(count: number): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(count));
}

function hex(value: number, digits: number): string {
  return value.toString(16).padStart(digits, "0");
}

export function newEntityId(now: number = Date.now()): string {
  // The clock never runs backwards for these ids: the same millisecond (or an earlier one, a
  // clock moved back) counts up; a full counter borrows the next millisecond.
  let millis = now;
  if (millis <= lastMillis) {
    millis = lastMillis;
    counter += 1;
    if (counter > COUNTER_MAX) {
      millis += 1;
      counter = 0;
    }
  } else {
    // A fresh millisecond starts the counter at a random point of its lower half: room to count.
    const [high = 0, low = 0] = randomBytes(2);
    counter = ((high << 8) | low) & 0x7ff;
  }
  lastMillis = millis;
  const tail = randomBytes(8);
  tail[0] = ((tail[0] ?? 0) & 0x3f) | 0x80; // the variant, `10`
  return (
    hex(millis, 12) +
    "7" + // the version
    hex(counter, 3) +
    Array.from(tail, (byte) => hex(byte, 2)).join("")
  );
}

/** A key that is a UUID v7 as sincpro_framework writes it: 32 hex, version 7, variant `10`. */
export function isEntityId(text: string): boolean {
  return /^[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$/.test(text);
}

/**
 * When a UUID v7 was minted, read off its leading 48 bits — sincpro_framework's `moment_of`;
 * `null` for a key that is not one (a project's own format, a UUID v4).
 *
 *     momentOf(newEntityId())   →  "2026-11-06T22:41:07.512Z", the moment it was minted
 */
export function momentOf(identity: string): string | null {
  const hex = identity.replaceAll("-", "").toLowerCase();
  if (!isEntityId(hex)) return null;
  return new Date(Number.parseInt(hex.slice(0, 12), 16)).toISOString();
}
