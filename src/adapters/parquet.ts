import type { Decoder } from "@sincpro/client-framework/client/transport";
import type { AnyRecord, Count, Dropped, Envelope } from "@sincpro/criteria";
import {
  type FileMetaData,
  parquetMetadata,
  parquetReadObjects,
  type SchemaElement,
} from "hyparquet";

/**
 * A page sincpro_framework answered as Parquet, read into what JSON would have sent — the
 * `[optional]` entry `@sincpro/client-framework/parquet`, over `hyparquet` (an optional peer).
 *
 *     restTransport({ base: "/v1", decoders: [parquetDecoder] })
 *     // a search of two million records: Accept says Parquet is read, the server answers it,
 *     // and the screen gets the same page — records, cursor, count — it gets from JSON
 *
 * Context: a JSON page of millions is the slowest, largest way to send them; a search answers
 * Parquet past its `parquet_above`, only to a caller that says it reads it. This is that
 * reading. Every value comes back as the JSON wire writes it, so nothing above the transport
 * changes: a decimal as its exact text, a day as `"2026-11-01"`, an instant as ISO text, an
 * integer as a number, what the server wrote as JSON text (`json` in the footer) parsed back.
 * The cursor, the count and the model's version travel in the file's footer.
 *
 * One limit, said: hyparquet reads a decimal as a JavaScript number, written back here as text
 * at the column's scale — exact while the unscaled value stays below 2^53 (with two decimals,
 * amounts up to ninety thousand billion).
 */

export const PARQUET = "application/vnd.apache.parquet";

/** What the footer of a sincpro_framework Parquet answer says beside the records. */
export type ParquetFooter = {
  /** The response's field holding the records: `entries`. */
  records: string;
  cursor: string | null;
  count: Count | null;
  model_version: string;
  dropped: Dropped[];
  /** The columns written as JSON text: a value object, a translated text. */
  json?: string[];
};

const ENVELOPE = "sincpro";

const pad = (value: number, size = 2) => String(value).padStart(size, "0");

/** A day as the wire writes it: days since 1970-01-01 → `"2026-11-01"`. */
function dayOf(days: number): string {
  const at = new Date(days * 86_400_000);
  return `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`;
}

/** An instant as the wire writes it, to the microsecond: `"2026-11-06T14:30:00.123456Z"`. */
function instantOf(micros: bigint): string {
  // Floored to the second, so an instant before 1970 keeps its fraction on the right side.
  const fraction = ((micros % 1_000_000n) + 1_000_000n) % 1_000_000n;
  const seconds = (micros - fraction) / 1_000_000n;
  const at = new Date(Number(seconds) * 1000);
  return `${at.toISOString().slice(0, 19)}.${pad(Number(fraction), 6)}Z`;
}

/**
 * Each top-level decimal column: its scale, and whether hyparquet already scaled it — it does
 * for one whose converted type says DECIMAL; one only its logical type says so comes unscaled.
 */
type Decimal = { scale: number; scaled: boolean };

/** The decimal columns at the top of the file's schema. */
function decimalScales(metadata: FileMetaData): Map<string, Decimal> {
  const scales = new Map<string, Decimal>();
  const [root, ...elements] = metadata.schema as SchemaElement[];
  let index = 0;
  const top = root?.num_children ?? 0;
  for (let column = 0; column < top && index < elements.length; column += 1) {
    const element = elements[index]!;
    const converted = element.converted_type === "DECIMAL";
    if (converted || element.logical_type?.type === "DECIMAL") {
      const logical = element.logical_type as { scale?: number } | undefined;
      scales.set(element.name, {
        scale: element.scale ?? logical?.scale ?? 0,
        scaled: converted,
      });
    }
    index += 1 + descendants(elements, index);
  }
  return scales;
}

/** How many schema elements a nested column holds below the one at `at`. */
function descendants(elements: readonly SchemaElement[], at: number): number {
  let count = 0;
  let pending = elements[at]?.num_children ?? 0;
  let next = at + 1;
  while (pending > 0 && next < elements.length) {
    count += 1;
    pending -= 1;
    pending += elements[next]?.num_children ?? 0;
    next += 1;
  }
  return count;
}

/** One value as the JSON wire writes it. */
/** An unscaled decimal (an integer, a bigint) as its exact text at `scale`. */
function scaledText(unscaled: number | bigint, scale: number): string {
  const digits = BigInt(unscaled);
  const negative = digits < 0n;
  const text = (negative ? -digits : digits).toString().padStart(scale + 1, "0");
  const whole = scale === 0 ? text : `${text.slice(0, -scale)}.${text.slice(-scale)}`;
  return negative ? `-${whole}` : whole;
}

/** What the server wrote as JSON text, read back — left as it is when it is no JSON. */
function parsedJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function wireValue(value: unknown, decimal: Decimal | undefined, json: boolean): unknown {
  if (value === null || value === undefined) return null;
  if (decimal !== undefined) {
    if (!decimal.scaled && (typeof value === "number" || typeof value === "bigint"))
      return scaledText(value, decimal.scale);
    if (typeof value === "number") return value.toFixed(decimal.scale);
  }
  if (typeof value === "bigint")
    return value <= BigInt(Number.MAX_SAFE_INTEGER) &&
      value >= BigInt(Number.MIN_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  if (json && typeof value === "string") return parsedJson(value);
  return value;
}

/**
 * The records of a sincpro_framework Parquet file — an answer's body, an export downloaded —
 * each as the JSON wire writes it, and what its footer says.
 *
 *     const { records, footer } = await parquetRecords(await download.blob().then((b) => b.arrayBuffer()));
 */
export async function parquetRecords(
  bytes: ArrayBuffer,
): Promise<{ records: AnyRecord[]; footer: ParquetFooter | null }> {
  const metadata = parquetMetadata(bytes);
  const said = metadata.key_value_metadata?.find((one) => one.key === ENVELOPE)?.value;
  const footer = said ? (JSON.parse(said) as ParquetFooter) : null;
  const scales = decimalScales(metadata);
  const json = new Set(footer?.json ?? []);
  const rows = await parquetReadObjects({
    file: bytes,
    metadata,
    parsers: {
      dateFromDays: dayOf,
      timestampFromMicroseconds: instantOf,
      timestampFromMilliseconds: (millis: bigint) => instantOf(millis * 1000n),
      timestampFromNanoseconds: (nanos: bigint) => instantOf(nanos / 1000n),
    },
  });
  const records = rows.map((row) => {
    const record: AnyRecord = {};
    for (const [name, value] of Object.entries(row))
      record[name] = wireValue(value, scales.get(name), json.has(name));
    return record;
  });
  return { records, footer };
}

/**
 * A Parquet answer read into the envelope a page is built from — what JSON would have sent:
 * the records under the response's own field, the cursor, the count, the model's version.
 */
export async function readParquetAnswer(response: Response): Promise<Envelope & AnyRecord> {
  const { records, footer } = await parquetRecords(await response.arrayBuffer());
  return {
    [footer?.records ?? "records"]: records,
    cursor: footer?.cursor ?? null,
    count: footer?.count ?? null,
    model_version: footer?.model_version ?? "",
    dropped: footer?.dropped ?? [],
  } as Envelope & AnyRecord;
}

/** What `restTransport({ decoders })` takes: the media type it reads, and how. */
export const parquetDecoder: Decoder = { mediaType: PARQUET, decode: readParquetAnswer };
