import { test } from "node:test";
import assert from "node:assert/strict";
import { loadCatalog, Quotes } from "../dist/index.js";

function catalogFrom(rows, defaults = {}) {
  const header = Object.keys(rows[0]);
  const lines = [header.join(",")];
  for (const r of rows) lines.push(header.map((h) => r[h] ?? "").join(","));
  return loadCatalog(lines.join("\n"), defaults);
}

test("charm table: USD to9 p1 12.34 -> 11.99", () => {
  const config = catalogFrom([{ product_sku: ".ng", price_amount: "12.34", charm: "to9", charm_position: "1" }]);
  const q = new Quotes(config);
  const r = q.quote({ sku: ".ng", quantity: 1 }, "USD");
  assert.equal(r.unit.sale, 1199);
});

test("charm table: USD to9 p0 12.34 -> 12.29 (tie resolves down)", () => {
  const config = catalogFrom([{ product_sku: ".ng", price_amount: "12.34", charm: "to9", charm_position: "0" }]);
  const q = new Quotes(config);
  const r = q.quote({ sku: ".ng", quantity: 1 }, "USD");
  assert.equal(r.unit.sale, 1229);
});

test("charm table: USD to4 p1 12.34 -> 12.49", () => {
  const config = catalogFrom([{ product_sku: ".ng", price_amount: "12.34", charm: "to4", charm_position: "1" }]);
  const q = new Quotes(config);
  const r = q.quote({ sku: ".ng", quantity: 1 }, "USD");
  assert.equal(r.unit.sale, 1249);
});

test("charm table: USD to9 p1 12.00 -> 11.99", () => {
  const config = catalogFrom([{ product_sku: ".ng", price_amount: "12.00", charm: "to9", charm_position: "1" }]);
  const q = new Quotes(config);
  const r = q.quote({ sku: ".ng", quantity: 1 }, "USD");
  assert.equal(r.unit.sale, 1199);
});

// NGN is sometimes assumed to have no minor unit, but ISO 4217 / Intl give it an exponent of 2
// (kobo). JPY is a real exponent-0 currency, so it's what we exercise here.
test("charm table: exponent-0 currency (JPY) to9 p2 15943 -> 15999", () => {
  const config = catalogFrom([{ product_sku: ".ng", price_amount: "15943", currency: "JPY", charm: "to9", charm_position: "2" }]);
  const q = new Quotes(config);
  const r = q.quote({ sku: ".ng", quantity: 1 }, "JPY");
  assert.equal(r.unit.sale, 15999);
});

test("charm underflow: $0.02 to9 p1 is a load error", () => {
  assert.throws(
    () => catalogFrom([{ product_sku: ".ng", price_amount: "0.02", charm: "to9", charm_position: "1" }]),
    (e) => e.issues?.[0].code === "ERR_CHARM_UNDERFLOW",
  );
});

test("charm fill: JPY to9 p1 zeros 15943 -> 15990", () => {
  const config = catalogFrom([{ product_sku: ".ng", price_amount: "15943", currency: "JPY", charm: "to9", charm_position: "1", charm_fill: "zeros" }]);
  const q = new Quotes(config);
  const r = q.quote({ sku: ".ng", quantity: 1 }, "JPY");
  assert.equal(r.unit.sale, 15990);
});

test("charm fill: JPY to9 p2 zeros 15943 -> 15900", () => {
  const config = catalogFrom([{ product_sku: ".ng", price_amount: "15943", currency: "JPY", charm: "to9", charm_position: "2", charm_fill: "zeros" }]);
  const q = new Quotes(config);
  const r = q.quote({ sku: ".ng", quantity: 1 }, "JPY");
  assert.equal(r.unit.sale, 15900);
});

test("charm fill: explicit \"nines\" matches the default (unchanged) behavior", () => {
  const config = catalogFrom([{ product_sku: ".ng", price_amount: "12.34", charm: "to9", charm_position: "1", charm_fill: "nines" }]);
  const q = new Quotes(config);
  const r = q.quote({ sku: ".ng", quantity: 1 }, "USD");
  assert.equal(r.unit.sale, 1199);
});

test("reconciliation: unit.sale x quantity === extended.sale across quantities and charm modes", () => {
  for (const charm of ["none", "to4", "to9"]) {
    const config = catalogFrom([{ product_sku: ".ng", price_amount: "12.34", charm, charm_position: charm === "none" ? "0" : "1" }]);
    const q = new Quotes(config);
    for (let qty = 1; qty <= 5; qty++) {
      const r = q.quote({ sku: ".ng", quantity: qty }, "USD");
      assert.equal(r.unit.sale * qty, r.extended.sale, `qty=${qty} charm=${charm}`);
      assert.equal(r.unit.list * qty, r.extended.list, `qty=${qty} charm=${charm}`);
    }
  }
});

test("quantization modes: floor vs ceil differ under a discount", () => {
  const floorCfg = catalogFrom([{ product_sku: ".ng", price_amount: "10.00", quantization: "floor", adjustment_kind: "discount", adjustment_type: "rate", adjustment_value: "0.333333" }]);
  const ceilCfg = catalogFrom([{ product_sku: ".ng", price_amount: "10.00", quantization: "ceil", adjustment_kind: "discount", adjustment_type: "rate", adjustment_value: "0.333333" }]);
  const floorUnit = new Quotes(floorCfg).quote({ sku: ".ng", quantity: 1 }, "USD").unit.sale;
  const ceilUnit = new Quotes(ceilCfg).quote({ sku: ".ng", quantity: 1 }, "USD").unit.sale;
  assert.ok(floorUnit < ceilUnit, `expected floor(${floorUnit}) < ceil(${ceilUnit})`);
});

const CHF_DEFAULTS = { currencies: { CHF: { increment: 5 } } };

test("CHF rounding increment snaps to 0.05 at load and after a discount", () => {
  const config = catalogFrom(
    [{ product_sku: ".ng", price_amount: "12.34", currency: "CHF", adjustment_kind: "discount", adjustment_type: "rate", adjustment_value: "0.10" }],
    CHF_DEFAULTS,
  );
  const price = config.prices[0];
  assert.equal(price.baseUnitMinor % 5, 0, "base should land on a 0.05 grid (5 minor units)");
  const q = new Quotes(config);
  const r = q.quote({ sku: ".ng", quantity: 1 }, "CHF");
  assert.equal(r.unit.sale % 5, 0, "discounted unit should also land on the 0.05 grid");
});

test("currency_rounding column: NGN rounds to whole naira, ceil, including tax and total", () => {
  const config = catalogFrom([{
    product_sku: ".ng", price_amount: "6999.59", currency: "NGN",
    currency_rounding: "1", currency_rounding_mode: "ceil",
    tax_rate: "0.075", tax_behavior: "exclusive",
  }]);
  const meta = config.currencies.get("NGN");
  assert.equal(meta.increment, 100, "1 naira == 100 kobo at NGN's exponent 2");
  assert.equal(meta.roundingMode, "ceil");

  const r = new Quotes(config).quote({ sku: ".ng", quantity: 1 }, "NGN");
  assert.equal(r.unit.sale % 100, 0, "unit.sale must land on a whole-naira grid");
  assert.equal(r.tax.amount % 100, 0, "tax must land on a whole-naira grid too, not just the price");
  assert.equal(r.total % 100, 0, "total (price + tax) must have no kobo remainder");
});

test("currency_rounding column: a currency's rows must agree, else ERR_CURRENCY_ROUNDING_CONFLICT", () => {
  assert.throws(
    () => catalogFrom([
      { product_sku: ".ng", price_amount: "10.00", currency: "NGN", product_variant: "create", currency_rounding: "1" },
      { product_sku: ".ng", price_amount: "10.00", currency: "NGN", product_variant: "renew", currency_rounding: "5" },
    ]),
    (e) => e.issues?.[0].code === "ERR_CURRENCY_ROUNDING_CONFLICT",
  );
});

test("currency_rounding_mode column: an invalid mode is ERR_BAD_ROUNDING_MODE", () => {
  assert.throws(
    () => catalogFrom([{ product_sku: ".ng", price_amount: "10.00", currency: "NGN", currency_rounding: "1", currency_rounding_mode: "up" }]),
    (e) => e.issues?.[0].code === "ERR_BAD_ROUNDING_MODE",
  );
});

test("defaults.currencies still wins over the catalog's currency_rounding column", () => {
  const config = catalogFrom(
    [{ product_sku: ".ng", price_amount: "10.00", currency: "NGN", currency_rounding: "1", currency_rounding_mode: "ceil" }],
    { currencies: { NGN: { increment: 50, roundingMode: "floor" } } },
  );
  const meta = config.currencies.get("NGN");
  assert.equal(meta.increment, 50);
  assert.equal(meta.roundingMode, "floor");
});

test("ERR_CHARM_INCREMENT_CONFLICT: CHF with charm to9", () => {
  assert.throws(
    () => catalogFrom([{ product_sku: ".ng", price_amount: "12.34", currency: "CHF", charm: "to9" }], CHF_DEFAULTS),
    (e) => e.issues?.[0].code === "ERR_CHARM_INCREMENT_CONFLICT",
  );
});

test("order-independence: two stackable 5% discounts equal one 10% discount", () => {
  const two5 = catalogFrom([
    { product_sku: ".ng", price_amount: "9.99", adjustment_kind: "discount", adjustment_type: "rate", adjustment_value: "0.05", adjustment_stackable: "true", adjustment_id: "d1" },
    { product_sku: ".ng", price_amount: "9.99", adjustment_kind: "discount", adjustment_type: "rate", adjustment_value: "0.05", adjustment_stackable: "true", adjustment_id: "d2" },
  ]);
  const one10 = catalogFrom([{ product_sku: ".ng", price_amount: "9.99", adjustment_kind: "discount", adjustment_type: "rate", adjustment_value: "0.10" }]);
  const a = new Quotes(two5).quote({ sku: ".ng", quantity: 1 }, "USD").unit.sale;
  const b = new Quotes(one10).quote({ sku: ".ng", quantity: 1 }, "USD").unit.sale;
  assert.equal(a, b);
});

test("markup is applied first and folded into unit.list; discount then applies on top of it", () => {
  const config = catalogFrom([
    { product_sku: ".ng", price_amount: "12.34", adjustment_kind: "markup", adjustment_type: "rate", adjustment_value: "0.20", adjustment_id: "m" },
    { product_sku: ".ng", price_amount: "12.34", adjustment_kind: "discount", adjustment_type: "rate", adjustment_value: "0.10", adjustment_id: "d" },
  ]);
  const r = new Quotes(config).quote({ sku: ".ng", quantity: 1 }, "USD");
  // stage 1: cost 1234 * 1.2 = 1480.8 -> unit.list 1481 (markup folded in, never itemized)
  assert.equal(r.unit.list, 1481);
  assert.equal(r.adjustments.discounts.length, 1);
  assert.equal(r.adjustments.fees.length, 0);
  // stage 2: discount applies to unit.list, not the raw catalog cost: 1481 * 0.9 = 1332.9 -> 1333
  assert.equal(r.unit.sale, 1333);
});

test("charm after markup only: 20% markup on 12.34 to9 p1 -> 14.99", () => {
  const config = catalogFrom([{ product_sku: ".ng", price_amount: "12.34", charm: "to9", charm_position: "1", adjustment_kind: "markup", adjustment_type: "rate", adjustment_value: "0.20" }]);
  const r = new Quotes(config).quote({ sku: ".ng", quantity: 1 }, "USD");
  assert.equal(r.unit.sale, 1499);
});

test("100% discount -> total exactly zero, no error", () => {
  const config = catalogFrom([{ product_sku: ".ng", price_amount: "10.00", adjustment_kind: "discount", adjustment_type: "rate", adjustment_value: "1.0" }]);
  const r = new Quotes(config).quote({ sku: ".ng", quantity: 1 }, "USD");
  assert.equal(r.unit.sale, 0);
  assert.equal(r.total, 0);
});

test("discount rate of 1.01 is a load error", () => {
  assert.throws(() => catalogFrom([{ product_sku: ".ng", price_amount: "10.00", adjustment_kind: "discount", adjustment_type: "rate", adjustment_value: "1.01" }]));
});

test("inclusive tax with discount: not itemized in tax.charges, but visible in debug", () => {
  const config = catalogFrom([
    { product_sku: ".ng", price_amount: "11.99", tax_rate: "0.075", tax_behavior: "inclusive", adjustment_kind: "discount", adjustment_type: "rate", adjustment_value: "0.10" },
  ]);
  const plain = new Quotes(config).quote({ sku: ".ng", quantity: 1 }, "USD");
  assert.equal(plain.tax.charges.length, 0, "inclusive tax adds nothing to the bill, so it's not a line item");
  assert.equal(plain.tax.amount, 0);
  assert.equal(plain.total, plain.extended.sale);
  assert.equal(plain.debug, undefined);

  const withDebug = new Quotes(config, { debug: true }).quote({ sku: ".ng", quantity: 1 }, "USD");
  assert.equal(withDebug.debug.tax.inclusive.length, 1);
  assert.ok(withDebug.debug.tax.liability > 0, "the tax is still really owed, just baked into the price");
});

test("half-cent rounding: 79.8 x 0.075 corrects float error before rounding", () => {
  const config = catalogFrom([{ product_sku: ".ng", price_amount: "79.80", tax_rate: "0.075", tax_behavior: "exclusive" }]);
  const r = new Quotes(config).quote({ sku: ".ng", quantity: 1 }, "USD");
  // 79.80 * 100 = 7980 minor units; 7980 * 0.075 = 598.5 exactly -> rounds away from zero to 599
  assert.equal(r.tax.amount, 599);
});

test("compound tax: second tax computed on base + first", () => {
  const config = catalogFrom([
    { product_sku: ".ng", price_amount: "100.00", tax_id: "gst", tax_rate: "0.05", tax_behavior: "exclusive", tax_compound: "false" },
    { product_sku: ".ng", price_amount: "100.00", tax_id: "qst", tax_rate: "0.09975", tax_behavior: "exclusive", tax_compound: "true" },
  ]);
  const r = new Quotes(config).quote({ sku: ".ng", quantity: 1 }, "USD");
  const gst = r.tax.charges.find((t) => t.id === "gst");
  const qst = r.tax.charges.find((t) => t.id === "qst");
  assert.equal(gst.amount, 500);
  // QST compounds on 10000 + 500 = 10500 -> 10500*0.09975 = 1047.375 -> round 1047
  assert.equal(qst.amount, 1047);
});

test("fee survives a discount that zeroes the extended sale price; total stays non-negative", () => {
  const config = catalogFrom([
    { product_sku: ".ng", price_amount: "10.00", adjustment_kind: "discount", adjustment_type: "rate", adjustment_value: "1.0", adjustment_id: "d" },
    { product_sku: ".ng", price_amount: "10.00", adjustment_kind: "fee", adjustment_type: "amount", adjustment_value: "1.50", adjustment_basis: "line", adjustment_id: "f" },
  ]);
  const r = new Quotes(config).quote({ sku: ".ng", quantity: 1 }, "USD");
  assert.equal(r.unit.sale, 0);
  assert.equal(r.total, 150);
});

test("discounts and fees are returned as separate arrays, markup in neither", () => {
  const config = catalogFrom([
    { product_sku: ".ng", price_amount: "10.00", adjustment_kind: "markup", adjustment_type: "rate", adjustment_value: "0.20", adjustment_id: "m" },
    { product_sku: ".ng", price_amount: "10.00", adjustment_kind: "discount", adjustment_type: "rate", adjustment_value: "0.10", adjustment_id: "d" },
    { product_sku: ".ng", price_amount: "10.00", adjustment_kind: "fee", adjustment_type: "amount", adjustment_value: "1.50", adjustment_basis: "line", adjustment_id: "f" },
  ]);
  const r = new Quotes(config).quote({ sku: ".ng", quantity: 1 }, "USD");
  assert.equal(r.adjustments.discounts.length, 1);
  assert.equal(r.adjustments.discounts[0].id, "d");
  assert.equal(r.adjustments.fees.length, 0, "the fee is line-basis, so it belongs in lineFees, not fees");
  assert.equal(r.adjustments.lineFees.length, 1);
  assert.equal(r.adjustments.lineFees[0].id, "f");
  assert.equal(r.debug, undefined, "debug is only populated when explicitly enabled");
});

test("debug mode: markup, cost and inclusive tax are hidden from the plain quote", () => {
  const config = catalogFrom([
    { product_sku: ".ng", price_amount: "10.00", adjustment_kind: "markup", adjustment_type: "rate", adjustment_value: "0.20", adjustment_id: "m", tax_rate: "0.10", tax_behavior: "inclusive" },
  ]);
  const plain = new Quotes(config).quote({ sku: ".ng", quantity: 1 }, "USD");
  assert.equal(plain.unit.list, 1200, "cost 1000 * 1.2 markup, folded into unit.list");
  assert.equal(plain.unit.sale, 1200, "no discount/fee on top");
  assert.equal(plain.extended.sale, 1200);
  assert.equal(plain.total, 1200, "inclusive tax adds nothing on top");
  assert.equal(plain.tax.charges.length, 0);
  assert.equal(plain.tax.amount, 0);
  assert.equal(plain.debug, undefined);

  const withDebug = new Quotes(config, { debug: true }).quote({ sku: ".ng", quantity: 1 }, "USD");
  assert.equal(withDebug.debug.cost, 1000, "raw catalog price, before markup");
  assert.equal(withDebug.debug.markup.length, 1);
  assert.equal(withDebug.debug.markup[0].amount, 200);
  assert.equal(withDebug.debug.tax.inclusive.length, 1);
  assert.equal(withDebug.debug.tax.inclusive[0].amount, 109, "1200 - round(1200/1.1)");
  assert.equal(withDebug.debug.tax.liability, 109, "the tax really owed, even though nothing shows in `tax.charges`");
});

test("markup with explicit adjustment_basis: line is a load error", () => {
  assert.throws(
    () => catalogFrom([{ product_sku: ".ng", price_amount: "10.00", adjustment_kind: "markup", adjustment_type: "amount", adjustment_value: "2.00", adjustment_basis: "line" }]),
    (e) => e.issues?.[0].code === "ERR_MARKUP_BASIS",
  );
});

test("markup with blank adjustment_basis defaults to unit, not the catalog's line default", () => {
  const config = catalogFrom([{ product_sku: ".ng", price_amount: "10.00", adjustment_kind: "markup", adjustment_type: "amount", adjustment_value: "2.00" }]);
  const r = new Quotes(config).quote({ sku: ".ng", quantity: 2 }, "USD");
  // $2 markup applied per unit, not once to the line: unit.list = 1000 + 200 = 1200
  assert.equal(r.unit.list, 1200);
  assert.equal(r.extended.list, 2400);
});

test("invariant chain holds across unit/line adjustments and exclusive tax", () => {
  const config = catalogFrom([
    { product_sku: ".ng", price_amount: "10.00", adjustment_kind: "markup", adjustment_type: "amount", adjustment_value: "2.00", adjustment_id: "m" },
    { product_sku: ".ng", price_amount: "10.00", adjustment_kind: "fee", adjustment_type: "amount", adjustment_value: "1.50", adjustment_basis: "line", adjustment_id: "f", tax_rate: "0.075", tax_behavior: "exclusive" },
  ]);
  const r = new Quotes(config).quote({ sku: ".ng", quantity: 4 }, "USD");
  assert.equal(r.extended.list, r.unit.list * 4);
  assert.equal(r.extended.sale, r.unit.sale * 4);
  assert.equal(r.tax.base, r.extended.sale + r.adjustments.lineNet);
  assert.equal(r.total, r.tax.base + r.tax.amount);
});
