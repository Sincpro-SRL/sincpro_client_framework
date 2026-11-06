/**
 * An exact decimal — what sincpro_framework's `Decimal` is on the wire: text, every digit kept.
 *
 *     new Decimal("10.50").plus("0.25")             →  10.75
 *     new Decimal("2.500").times("19.90")           →  49.75000
 *     new Decimal("10").dividedBy("3", 2)           →  3.33        half up, as the backend rounds
 *     JSON.stringify({ qty: new Decimal("2.500") })  →  {"qty":"2.500"}
 *
 * Context: the backend sends a decimal as text (`"10.50"`) so no client reads it as a float —
 * `0.1 + 0.2` is `0.30000000000000004` in every JavaScript engine, and an invoice cannot be. A
 * client that adds, multiplies or rounds an amount (a cart, a line, a discount) does it here,
 * on `BigInt`, which browsers, Node and Hermes have; it depends on nothing. It never rounds by
 * accident: `plus`, `minus` and `times` are exact, and only `rounded` and `dividedBy` round —
 * half up, away from zero, the backend's `ROUND_HALF_UP`. Formatting it for a person is the
 * platform's (`Intl.NumberFormat`), never this.
 */

export type DecimalLike = Decimal | string | number | bigint;

const NUMBER = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d{1,4}))?$/;

const TEN = 10n;

function pow10(exponent: number): bigint {
  return TEN ** BigInt(exponent);
}

/** `units / divisor` rounded half up, away from zero. */
function halfUp(units: bigint, divisor: bigint): bigint {
  const quotient = units / divisor;
  const rest = units % divisor;
  const twice = (rest < 0n ? -rest : rest) * 2n;
  const whole = divisor < 0n ? -divisor : divisor;
  if (twice < whole) return quotient;
  return units < 0n !== divisor < 0n ? quotient - 1n : quotient + 1n;
}

export class Decimal {
  /** The digits, as an integer: `10.50` is `1050n` at scale 2. */
  readonly units: bigint;
  /** How many of the digits are after the point. */
  readonly scale: number;

  /**
   * A decimal from its text (`"10.50"`, `"-0.5"`, `"1e3"`), a number — taken by its digits,
   * `0.1` is `"0.1"` — or a whole `bigint`. Anything else is refused, naming it.
   */
  constructor(value: DecimalLike) {
    if (value instanceof Decimal) {
      this.units = value.units;
      this.scale = value.scale;
      return;
    }
    if (typeof value === "bigint") {
      this.units = value;
      this.scale = 0;
      return;
    }
    if (typeof value === "number" && !Number.isFinite(value))
      throw new TypeError(`${value} is not a decimal`);
    const text = typeof value === "number" ? String(value) : String(value).trim();
    const match = NUMBER.exec(text);
    const [, sign = "", whole = "", fraction = "", exponent = "0"] = match ?? [];
    if (match === null || whole + fraction === "")
      throw new TypeError(`"${text}" is not a decimal`);
    let digits = whole + fraction;
    let scale = fraction.length - Number(exponent);
    if (scale < 0) {
      digits += "0".repeat(-scale);
      scale = 0;
    }
    this.units = BigInt(digits) * (sign === "-" ? -1n : 1n);
    this.scale = scale;
  }

  static of(value: DecimalLike): Decimal {
    return value instanceof Decimal ? value : new Decimal(value);
  }

  private static at(units: bigint, scale: number): Decimal {
    const made = Object.create(Decimal.prototype) as { units: bigint; scale: number };
    made.units = units;
    made.scale = scale;
    return made as Decimal;
  }

  /** Both at the larger scale, so their units compare and add. */
  private static aligned(one: Decimal, other: Decimal): [bigint, bigint, number] {
    const scale = Math.max(one.scale, other.scale);
    return [
      one.units * pow10(scale - one.scale),
      other.units * pow10(scale - other.scale),
      scale,
    ];
  }

  plus(other: DecimalLike): Decimal {
    const [one, two, scale] = Decimal.aligned(this, Decimal.of(other));
    return Decimal.at(one + two, scale);
  }

  minus(other: DecimalLike): Decimal {
    const [one, two, scale] = Decimal.aligned(this, Decimal.of(other));
    return Decimal.at(one - two, scale);
  }

  times(factor: DecimalLike): Decimal {
    const by = Decimal.of(factor);
    return Decimal.at(this.units * by.units, this.scale + by.scale);
  }

  /** This over `divisor`, with `decimals` digits after the point, rounded half up. */
  dividedBy(divisor: DecimalLike, decimals: number): Decimal {
    const by = Decimal.of(divisor);
    if (by.units === 0n) throw new RangeError("a decimal divided by zero");
    const numerator = this.units * pow10(by.scale + decimals);
    const denominator = by.units * pow10(this.scale);
    return Decimal.at(halfUp(numerator, denominator), decimals);
  }

  /** With `decimals` digits after the point: rounded half up when it had more, padded when fewer. */
  rounded(decimals: number): Decimal {
    if (decimals >= this.scale)
      return Decimal.at(this.units * pow10(decimals - this.scale), decimals);
    return Decimal.at(halfUp(this.units, pow10(this.scale - decimals)), decimals);
  }

  negated(): Decimal {
    return Decimal.at(-this.units, this.scale);
  }

  /** `-1`, `0` or `1`: `10.5` and `10.50` are the same amount. */
  compare(other: DecimalLike): -1 | 0 | 1 {
    const [one, two] = Decimal.aligned(this, Decimal.of(other));
    return one < two ? -1 : one > two ? 1 : 0;
  }

  equals(other: DecimalLike): boolean {
    return this.compare(other) === 0;
  }

  get isZero(): boolean {
    return this.units === 0n;
  }

  get isNegative(): boolean {
    return this.units < 0n;
  }

  get isPositive(): boolean {
    return this.units > 0n;
  }

  /** The text the wire carries: every digit, the scale kept (`"10.50"`, never `"10.5"`). */
  toString(): string {
    const negative = this.units < 0n;
    const digits = (negative ? -this.units : this.units)
      .toString()
      .padStart(this.scale + 1, "0");
    const whole = digits.slice(0, digits.length - this.scale);
    const fraction = digits.slice(digits.length - this.scale);
    return `${negative ? "-" : ""}${whole}${this.scale > 0 ? `.${fraction}` : ""}`;
  }

  toJSON(): string {
    return this.toString();
  }
}
