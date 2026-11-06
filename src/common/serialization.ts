/**
 * Any value as JSON values and back — what every message a client sends is written with, as
 * sincpro_framework's `common/serialization` (`values_of`, `read_values`, `rebuilt`, `pack`,
 * `unpack`).
 *
 *     valuesOf({ total: new Money("12.50", "BOB"), qty: new Decimal("2.500") })
 *       →  { total: { amount: "12.50", currency: "BOB" }, qty: "2.500" }
 *     valuesOf(new Uint8Array([104, 105]))          →  { $bytes: "aGk=" }
 *     readValues('{"photo":{"$bytes":"aGk="}}')      →  { photo: Uint8Array [104, 105] }
 *     unpack(text, Money)                           →  a Money, or a TypeError naming what is wrong
 *
 * Context: the wire has one set of rules, the backend's, and every platform writes and reads it
 * the same — that is why it lives here and not in each client:
 *
 * - a decimal is text (`"10.50"`): a `Decimal`, a `Money`'s amount, a `bigint` — never a float;
 * - a day is text (`"2026-10-02"`) and stays text: a `Date` is always an instant, written as one;
 * - an instant is ISO text (`Date` → `toISOString()`);
 * - bytes are `{"$bytes": "<base64>"}`, so binary is never mistaken for text;
 * - a value that says how it travels (`toJSON`) is written that way: `Money`, `Decimal`, `Date`;
 * - a map is an object with text keys; a set or a list, a list.
 *
 * Not restrictive, like the backend: reading keeps every key it finds — what a reader does not
 * know it ignores, never refuses — and a typed read is asked for, never imposed (`rebuilt(values,
 * Money)`). What JSON cannot write (a function, `NaN`, a cycle) is refused at once, naming where,
 * rather than sent as `null`.
 */

/** A value JSON writes as it is. */
export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** The tag bytes travel under. */
export const BYTES = "$bytes";

/** What `rebuilt` reads values as: a class with `fromJSON` (`Money`), or a function. */
export type Rebuild<T> = { fromJSON(values: unknown): T } | ((values: unknown) => T);

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Base64 by hand: `btoa` is not on every platform this runs on. */
function base64Of(bytes: Uint8Array): string {
  let text = "";
  for (let at = 0; at < bytes.length; at += 3) {
    const [a = 0, b = 0, c = 0] = [bytes[at], bytes[at + 1], bytes[at + 2]];
    const triple = (a << 16) | (b << 8) | c;
    const letter = (shift: number) => ALPHABET.charAt((triple >> shift) & 63);
    text += letter(18) + letter(12);
    text += at + 1 < bytes.length ? letter(6) : "=";
    text += at + 2 < bytes.length ? letter(0) : "=";
  }
  return text;
}

function bytesOf(text: string): Uint8Array {
  const clean = text.replace(/[^A-Za-z0-9+/]/g, "");
  const bytes = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let filled = 0;
  for (let at = 0; at < clean.length; at += 4) {
    const [a = 0, b = 0, c = 0, d = 0] = [0, 1, 2, 3].map((one) =>
      ALPHABET.indexOf(clean[at + one] ?? "A"),
    );
    const triple = (a << 18) | (b << 12) | (c << 6) | d;
    for (const shift of [16, 8, 0])
      if (filled < bytes.length) bytes[filled++] = (triple >> shift) & 255;
  }
  return bytes;
}

function isBytes(value: unknown): value is ArrayBufferView | ArrayBuffer {
  return value instanceof ArrayBuffer || ArrayBuffer.isView(value);
}

/** Any binary — a `Uint8Array`, another typed array, a `DataView`, a buffer — as its bytes. */
function asBytes(value: ArrayBufferView | ArrayBuffer): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

function written(value: unknown, where: string, seen: Set<object>): JsonValue | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (value === undefined) return undefined;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError(`${where}: ${value} cannot travel as JSON`);
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol")
    throw new TypeError(`${where}: a ${typeof value} cannot travel as JSON`);
  if (isBytes(value)) return { [BYTES]: base64Of(asBytes(value)) };
  const object = value as object;
  if (seen.has(object)) throw new TypeError(`${where}: a cycle cannot travel as JSON`);
  seen.add(object);
  try {
    const own = (object as { toJSON?: unknown }).toJSON;
    if (typeof own === "function") {
      const said: unknown = own.call(object);
      // A `toJSON` that answers the object itself says nothing new: it is written as an object.
      // Still in `seen` while what it said is written: `{ self: this }` is a cycle, not a loop.
      if (said !== object) return written(said, where, seen);
    }
    if (object instanceof Map)
      return Object.fromEntries(
        [...object].flatMap(([key, one]) => {
          const done = written(one, `${where}.${String(key)}`, seen);
          return done === undefined ? [] : [[String(key), done]];
        }),
      );
    if (object instanceof Set || Array.isArray(object))
      return [...(object as Iterable<unknown>)].map(
        (one, at) => written(one, `${where}[${at}]`, seen) ?? null,
      );
    const entries: [string, JsonValue][] = [];
    for (const [key, one] of Object.entries(object)) {
      // Its own way to travel is not a value of it.
      if (key === "toJSON" && typeof one === "function") continue;
      const done = written(one, `${where}.${key}`, seen);
      if (done !== undefined) entries.push([key, done]);
    }
    return Object.fromEntries(entries);
  } finally {
    seen.delete(object);
  }
}

/**
 * `value` as JSON values, by the wire's rules. `undefined` is left out of an object and written
 * `null` in a list, as JSON does.
 */
export function valuesOf(value: unknown): JsonValue {
  return written(value, "value", new Set()) ?? null;
}

/** One JSON object back as what it stood for: a lone `$bytes` tag is its bytes. */
function restored(object: Record<string, unknown>): unknown {
  const keys = Object.keys(object);
  if (keys.length === 1 && keys[0] === BYTES && typeof object[BYTES] === "string")
    return bytesOf(object[BYTES]);
  return object;
}

function walked(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(walked);
  if (value !== null && typeof value === "object")
    return restored(
      Object.fromEntries(Object.entries(value).map(([key, one]) => [key, walked(one)])),
    );
  return value;
}

/**
 * What `valuesOf` wrote, from JSON text or already parsed — each tagged bytes back as bytes. A
 * string is JSON text: to read values that were written but never sent, go through `pack`
 * (`readValues(pack(value))`), as the in-memory transport does.
 */
export function readValues(text: string | unknown): unknown {
  if (typeof text === "string")
    return JSON.parse(text, (_key, value: unknown) =>
      value !== null && typeof value === "object" && !Array.isArray(value)
        ? restored(value as Record<string, unknown>)
        : value,
    );
  return walked(text);
}

/** `values` read as `of` — `Money`, a DTO's own reader — or as they are without one. */
export function rebuilt<T = unknown>(values: unknown, of?: Rebuild<T>): T {
  if (of === undefined) return values as T;
  // A class is a function too: one that says how to read itself is read that way.
  const reader = (of as { fromJSON?: unknown }).fromJSON;
  if (typeof reader === "function")
    return (reader as (values: unknown) => T).call(of, values);
  return (of as (values: unknown) => T)(values);
}

/** `value` as JSON text — see `valuesOf`. */
export function pack(value: unknown): string {
  return JSON.stringify(valuesOf(value));
}

/** What `pack` wrote, read as `of` — see `rebuilt`. */
export function unpack<T = unknown>(text: string, of?: Rebuild<T>): T {
  return rebuilt(readValues(text), of);
}
