import assert from "node:assert/strict";

import { Decimal, Money } from "@sincpro/client-framework";
import { test } from "vitest";

test("a decimal is exact: 0.1 + 0.2 is 0.3, and every digit and the scale are kept", () => {
  assert.equal(new Decimal("0.1").plus("0.2").toString(), "0.3");
  assert.equal(new Decimal("10.50").toString(), "10.50");
  assert.equal(new Decimal("2.500").times("19.90").toString(), "49.75000");
  assert.equal(new Decimal("10.50").minus("0.75").toString(), "9.75");
  assert.equal(new Decimal("-0.5").toString(), "-0.5");
  assert.equal(new Decimal(".5").toString(), "0.5");
  assert.equal(new Decimal("1e3").toString(), "1000");
  assert.equal(new Decimal("1.5e-3").toString(), "0.0015");
  // A JSON number is taken by its digits.
  assert.equal(new Decimal(0.1).toString(), "0.1");
  assert.equal(new Decimal(12n).toString(), "12");
  assert.equal(JSON.stringify({ qty: new Decimal("2.500") }), '{"qty":"2.500"}');
});

test("only rounding rounds — half up, away from zero, as the backend's ROUND_HALF_UP", () => {
  assert.equal(new Decimal("2.345").rounded(2).toString(), "2.35");
  assert.equal(new Decimal("2.344").rounded(2).toString(), "2.34");
  assert.equal(new Decimal("-2.345").rounded(2).toString(), "-2.35");
  assert.equal(new Decimal("2.5").rounded(0).toString(), "3");
  assert.equal(new Decimal("7").rounded(2).toString(), "7.00");
  assert.equal(new Decimal("10").dividedBy("3", 2).toString(), "3.33");
  assert.equal(new Decimal("20").dividedBy("3", 2).toString(), "6.67");
  assert.equal(new Decimal("-1").dividedBy("8", 2).toString(), "-0.13");
  assert.equal(new Decimal("1.5").dividedBy("0.5", 0).toString(), "3");
  assert.throws(() => new Decimal("1").dividedBy("0", 2), /divided by zero/);
});

test("decimals compare by amount, not by text: 10.5 is 10.50", () => {
  assert.equal(new Decimal("10.5").equals("10.50"), true);
  assert.equal(new Decimal("10.5").compare("10.49"), 1);
  assert.equal(new Decimal("-1").compare("0"), -1);
  assert.equal(new Decimal("0.00").isZero, true);
});

test("what is not a decimal is refused, naming it", () => {
  assert.throws(() => new Decimal("10,50"), /"10,50" is not a decimal/);
  assert.throws(() => new Decimal(""), /is not a decimal/);
  assert.throws(() => new Decimal(Number.NaN), /NaN is not a decimal/);
});

test("a money travels as the backend's: { amount, currency }, the amount as text", () => {
  const price = new Money("19.90", "bob");
  assert.deepEqual(price.toJSON(), { amount: "19.90", currency: "BOB" });
  assert.equal(
    JSON.stringify({ total: price }),
    '{"total":{"amount":"19.90","currency":"BOB"}}',
  );
  assert.equal(Money.fromJSON({ amount: "10.50", currency: "BOB" }).amount, "10.50");
  // A JSON number on the way in is taken by its digits.
  assert.equal(Money.fromJSON({ amount: 10.5, currency: "BOB" }).amount, "10.5");
  assert.throws(() => Money.fromJSON({ amount: "1" }), /without its currency/);
  assert.throws(() => Money.fromJSON("10 BOB"), /is not a money/);
  assert.equal(Money.isMoney({ amount: "1", currency: "BOB" }), true);
  assert.equal(Money.isMoney({ amount: "1" }), false);
});

test("a line adds as the invoice will: exact, rounded once, to the currency's decimals", () => {
  const line = new Money("19.90", "BOB").times("3");
  const discount = line.times("0.15").negated();
  const total = Money.total([line, discount, new Money("5", "BOB")], "BOB");
  assert.equal(line.amount, "59.70");
  assert.equal(total.amount, "55.7450");
  assert.equal(total.rounded().amount, "55.75");
  assert.equal(new Money("1000", "JPY").dividedBy("3").amount, "333");
  assert.equal(new Money("1", "KWD").rounded().amount, "1.000");
  assert.equal(Money.total([], "BOB").amount, "0");
});

test("two currencies never add by accident: total refuses, totals sums each", () => {
  const bob = new Money("10", "BOB");
  const usd = new Money("2", "USD");
  assert.throws(() => bob.plus(usd), /USD cannot be added to BOB/);
  assert.throws(() => Money.total([bob, usd], "BOB"), /cannot be added/);
  const sums = Money.totals([bob, usd, new Money("5", "BOB")]);
  assert.equal(sums["BOB"]?.amount, "15");
  assert.equal(sums["USD"]?.amount, "2");
  assert.equal(bob.equals(new Money("10.00", "BOB")), true);
  assert.equal(bob.equals(new Money("10", "USD")), false);
});

test("zero, negative and positive are read at the currency's decimals, as an accountant reads them", () => {
  assert.equal(new Money("0.004", "BOB").isZero, true);
  assert.equal(new Money("-0.004", "BOB").isNegative, false);
  assert.equal(new Money("0.005", "BOB").isPositive, true);
});

test("any code is read; its decimals are 2 unless the application says so", () => {
  assert.equal(new Money("1", "USDT").decimals, 2);
  Money.decimals["USDT"] = 6;
  try {
    assert.equal(new Money("1", "USDT").rounded().amount, "1.000000");
  } finally {
    delete Money.decimals["USDT"];
  }
  assert.throws(() => new Money("1", "b o b"), /is not a currency code/);
});
