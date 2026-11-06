import { Decimal, type DecimalLike } from "@sincpro/client-framework/common/decimal";

/**
 * An amount and its currency, as sincpro_framework's `Money` travels: `{"amount": "10.50",
 * "currency": "BOB"}`.
 *
 *     const line = new Money("19.90", "BOB").times("3");            →  59.70 BOB
 *     const total = Money.total([line, delivery], "BOB");
 *     total.rounded().toJSON()                                       →  { amount: "69.70", currency: "BOB" }
 *     Money.fromJSON(answer.total)                                   ←  what the server sent
 *
 * Context: an amount never travels without its currency, never as a float and never rounds by
 * accident — the backend's three rules, kept here so a cart, a POS line or a portal's quote adds
 * the way the invoice will. Adding two currencies is refused; `total` sums one, `totals` each.
 * The arithmetic is `Decimal`'s, exact; `rounded()` rounds to the currency's decimals (ISO 4217:
 * `BOB` 2, `JPY` 0, `KWD` 3), and `isZero` / `isNegative` read it at those decimals, as an
 * accountant does.
 *
 * Not restrictive: any code is read (a crypto, a loyalty point), and its decimals are 2 unless
 * `Money.decimals` says otherwise — an application adds its own (`Money.decimals["USDT"] = 6`).
 * Showing it to a person is the platform's (`Intl.NumberFormat` with `style: "currency"`).
 */
export class Money {
  /** Decimals by currency where they are not 2: ISO 4217's, and what an application adds. */
  static readonly decimals: Record<string, number> = {
    BHD: 3,
    BIF: 0,
    BTC: 8,
    CLF: 4,
    CLP: 0,
    DJF: 0,
    GNF: 0,
    IQD: 3,
    ISK: 0,
    JOD: 3,
    JPY: 0,
    KMF: 0,
    KRW: 0,
    KWD: 3,
    LYD: 3,
    OMR: 3,
    PYG: 0,
    RWF: 0,
    TND: 3,
    UGX: 0,
    UYI: 0,
    VND: 0,
    VUV: 0,
    XAF: 0,
    XOF: 0,
    XPF: 0,
  };

  /** The amount as the wire carries it: every digit, the scale kept (`"10.50"`). */
  readonly amount: string;
  /** The currency's code, upper case (`"BOB"`). */
  readonly currency: string;

  constructor(amount: DecimalLike, currency: string) {
    const code = currency.trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9]{1,9}$/.test(code))
      throw new TypeError(`"${currency}" is not a currency code`);
    this.amount = Decimal.of(amount).toString();
    this.currency = code;
  }

  /**
   * What the server sent — `{ amount, currency }`, the amount as text or as a JSON number taken
   * by its digits. Anything else is refused, naming what is wrong.
   */
  static fromJSON(value: unknown): Money {
    if (value instanceof Money) return value;
    if (value === null || typeof value !== "object")
      throw new TypeError(`${JSON.stringify(value)} is not a money: { amount, currency }`);
    const { amount, currency } = value as { amount?: unknown; currency?: unknown };
    if (typeof currency !== "string")
      throw new TypeError(`a money without its currency: ${JSON.stringify(value)}`);
    if (typeof amount !== "string" && typeof amount !== "number")
      throw new TypeError(`a money without its amount: ${JSON.stringify(value)}`);
    return new Money(amount, currency);
  }

  /** Whether `value` has the shape of a money on the wire: `{ amount, currency }`. */
  static isMoney(value: unknown): value is { amount: string | number; currency: string } {
    if (value instanceof Money) return true;
    if (value === null || typeof value !== "object") return false;
    const { amount, currency } = value as { amount?: unknown; currency?: unknown };
    return (
      typeof currency === "string" &&
      (typeof amount === "string" || typeof amount === "number")
    );
  }

  /** The decimals `currency` is counted in: 2 unless `Money.decimals` says otherwise. */
  static decimalsOf(currency: string): number {
    return Money.decimals[currency.toUpperCase()] ?? 2;
  }

  /** The sum of `items`, all in `currency` — zero when there are none. Another currency is refused. */
  static total(items: Iterable<Money>, currency: string): Money {
    let sum = new Money("0", currency);
    for (const item of items) sum = sum.plus(item);
    return sum;
  }

  /** The sums by currency, each currency's own. */
  static totals(items: Iterable<Money>): Readonly<Record<string, Money>> {
    const sums: Record<string, Money> = {};
    for (const item of items) {
      const held = sums[item.currency];
      sums[item.currency] = held === undefined ? item : held.plus(item);
    }
    return sums;
  }

  /** The amount as an exact decimal. */
  get value(): Decimal {
    return new Decimal(this.amount);
  }

  /** The decimals this currency is counted in. */
  get decimals(): number {
    return Money.decimalsOf(this.currency);
  }

  private same(other: Money): Money {
    if (other.currency !== this.currency)
      throw new TypeError(
        `${other.currency} cannot be added to ${this.currency} — sum each currency apart (Money.totals)`,
      );
    return other;
  }

  plus(other: Money): Money {
    return new Money(this.value.plus(this.same(other).amount), this.currency);
  }

  minus(other: Money): Money {
    return new Money(this.value.minus(this.same(other).amount), this.currency);
  }

  /** Times a quantity, a rate or a percentage as a fraction: exact, never rounded. */
  times(factor: DecimalLike): Money {
    return new Money(this.value.times(factor), this.currency);
  }

  /** Over `divisor`, rounded half up to the currency's decimals (or `decimals`). */
  dividedBy(divisor: DecimalLike, decimals: number = this.decimals): Money {
    return new Money(this.value.dividedBy(divisor, decimals), this.currency);
  }

  /** Rounded half up to the currency's decimals (or `decimals`): what an invoice shows. */
  rounded(decimals: number = this.decimals): Money {
    return new Money(this.value.rounded(decimals), this.currency);
  }

  negated(): Money {
    return new Money(this.value.negated(), this.currency);
  }

  /** `-1`, `0` or `1`, in the same currency. */
  compare(other: Money): -1 | 0 | 1 {
    return this.value.compare(this.same(other).amount);
  }

  /** The same currency and the same amount: `10.5 BOB` equals `10.50 BOB`. */
  equals(other: Money): boolean {
    return other.currency === this.currency && this.value.equals(other.amount);
  }

  /** Zero at the currency's decimals: `0.004 BOB` is. */
  get isZero(): boolean {
    return this.rounded().value.isZero;
  }

  get isNegative(): boolean {
    return this.rounded().value.isNegative;
  }

  get isPositive(): boolean {
    return this.rounded().value.isPositive;
  }

  toJSON(): { amount: string; currency: string } {
    return { amount: this.amount, currency: this.currency };
  }

  /** `"10.50 BOB"` — for a log or a test; a person reads it through `Intl.NumberFormat`. */
  toString(): string {
    return `${this.amount} ${this.currency}`;
  }
}
