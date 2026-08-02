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
  assert.equal(r.salePrice, 1199);
});

test("charm table: USD to9 p0 12.34 -> 12.29 (tie resolves down)", () => {
  const config = catalogFrom([{ product_sku: ".ng", price_amount: "12.34", charm: "to9", charm_position: "0" }]);
  const q = new Quotes(config);
  const r = q.quote({ sku: ".ng", quantity: 1 }, "USD");
  assert.equal(r.salePrice, 1229);
});

test("charm table: USD to4 p1 12.34 -> 12.49", () => {
  const config = catalogFrom([{ product_sku: ".ng", price_amount: "12.34", charm: "to4", charm_position: "1" }]);
  const q = new Quotes(config);
  const r = q.quote({ sku: ".ng", quantity: 1 }, "USD");
  assert.equal(r.salePrice, 1249);
});

test("charm table: USD to9 p1 12.00 -> 11.99", () => {
  const config = catalogFrom([{ product_sku: ".ng", price_amount: "12.00", charm: "to9", charm_position: "1" }]);
  const q = new Quotes(config);
  const r = q.quote({ sku: ".ng", quantity: 1 }, "USD");
  assert.equal(r.salePrice, 1199);
});

// NGN is sometimes assumed to have no minor unit, but ISO 4217 / Intl give it an exponent of 2
// (kobo). JPY is a real exponent-0 currency, so it's what we exercise here.
test("charm table: exponent-0 currency (JPY) to9 p2 15943 -> 15999", () => {
  const config = catalogFrom([{ product_sku: ".ng", price_amount: "15943", currency: "JPY", charm: "to9", charm_position: "2" }]);
  const q = new Quotes(config);
  const r = q.quote({ sku: ".ng", quantity: 1 }, "JPY");
  assert.equal(r.salePrice, 15999);
});

test("charm underflow: $0.02 to9 p1 is a load error", () => {
  assert.throws(
    () => catalogFrom([{ product_sku: ".ng", price_amount: "0.02", charm: "to9", charm_position: "1" }]),
    (e) => e.issues?.[0].code === "ERR_CHARM_UNDERFLOW",
  );
});

test("reconciliation: salePrice x quantity === extendedSalePrice across quantities and charm modes", () => {
  for (const charm of ["none", "to4", "to9"]) {
    const config = catalogFrom([{ product_sku: ".ng", price_amount: "12.34", charm, charm_position: charm === "none" ? "0" : "1" }]);
    const q = new Quotes(config);
    for (let qty = 1; qty <= 5; qty++) {
      const r = q.quote({ sku: ".ng", quantity: qty }, "USD");
      assert.equal(r.salePrice * qty, r.extendedSalePrice, `qty=${qty} charm=${charm}`);
      assert.equal(r.unitPrice * qty, r.extendedUnitPrice, `qty=${qty} charm=${charm}`);
    }
  }
});

test("quantization modes: floor vs ceil differ under a discount", () => {
  const floorCfg = catalogFrom([{ product_sku: ".ng", price_amount: "10.00", quantization: "floor", adjustment_kind: "discount", adjustment_type: "rate", adjustment_value: "0.333333" }]);
  const ceilCfg = catalogFrom([{ product_sku: ".ng", price_amount: "10.00", quantization: "ceil", adjustment_kind: "discount", adjustment_type: "rate", adjustment_value: "0.333333" }]);
  const floorUnit = new Quotes(floorCfg).quote({ sku: ".ng", quantity: 1 }, "USD").salePrice;
  const ceilUnit = new Quotes(ceilCfg).quote({ sku: ".ng", quantity: 1 }, "USD").salePrice;
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
  assert.equal(r.salePrice % 5, 0, "discounted unit should also land on the 0.05 grid");
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
  const a = new Quotes(two5).quote({ sku: ".ng", quantity: 1 }, "USD").salePrice;
  const b = new Quotes(one10).quote({ sku: ".ng", quantity: 1 }, "USD").salePrice;
  assert.equal(a, b);
});

test("markup is applied first and folded into unitPrice; discount then applies on top of it", () => {
  const config = catalogFrom([
    { product_sku: ".ng", price_amount: "12.34", adjustment_kind: "markup", adjustment_type: "rate", adjustment_value: "0.20", adjustment_id: "m" },
    { product_sku: ".ng", price_amount: "12.34", adjustment_kind: "discount", adjustment_type: "rate", adjustment_value: "0.10", adjustment_id: "d" },
  ]);
  const r = new Quotes(config).quote({ sku: ".ng", quantity: 1 }, "USD");
  // stage 1: cost 1234 * 1.2 = 1480.8 -> unitPrice 1481 (markup folded in, never itemized)
  assert.equal(r.unitPrice, 1481);
  assert.equal(r.discounts.length, 1);
  assert.equal(r.fees.length, 0);
  // stage 2: discount applies to unitPrice, not the raw catalog cost: 1481 * 0.9 = 1332.9 -> 1333
  assert.equal(r.salePrice, 1333);
});

test("charm after markup only: 20% markup on 12.34 to9 p1 -> 14.99", () => {
  const config = catalogFrom([{ product_sku: ".ng", price_amount: "12.34", charm: "to9", charm_position: "1", adjustment_kind: "markup", adjustment_type: "rate", adjustment_value: "0.20" }]);
  const r = new Quotes(config).quote({ sku: ".ng", quantity: 1 }, "USD");
  assert.equal(r.salePrice, 1499);
});

test("100% discount -> total exactly zero, no error", () => {
  const config = catalogFrom([{ product_sku: ".ng", price_amount: "10.00", adjustment_kind: "discount", adjustment_type: "rate", adjustment_value: "1.0" }]);
  const r = new Quotes(config).quote({ sku: ".ng", quantity: 1 }, "USD");
  assert.equal(r.salePrice, 0);
  assert.equal(r.total, 0);
});

test("discount rate of 1.01 is a load error", () => {
  assert.throws(() => catalogFrom([{ product_sku: ".ng", price_amount: "10.00", adjustment_kind: "discount", adjustment_type: "rate", adjustment_value: "1.01" }]));
});

test("inclusive tax with discount: not itemized in taxes, but visible in debug", () => {
  const config = catalogFrom([
    { product_sku: ".ng", price_amount: "11.99", tax_rate: "0.075", tax_behavior: "inclusive", adjustment_kind: "discount", adjustment_type: "rate", adjustment_value: "0.10" },
  ]);
  const plain = new Quotes(config).quote({ sku: ".ng", quantity: 1 }, "USD");
  assert.equal(plain.taxes.length, 0, "inclusive tax adds nothing to the bill, so it's not a line item");
  assert.equal(plain.tax, 0);
  assert.equal(plain.total, plain.extendedSalePrice);
  assert.equal(plain.debug, undefined);

  const withDebug = new Quotes(config, { debug: true }).quote({ sku: ".ng", quantity: 1 }, "USD");
  assert.equal(withDebug.debug.inclusiveTaxes.length, 1);
  assert.ok(withDebug.debug.taxLiability > 0, "the tax is still really owed, just baked into the price");
});

test("half-cent rounding: 79.8 x 0.075 corrects float error before rounding", () => {
  const config = catalogFrom([{ product_sku: ".ng", price_amount: "79.80", tax_rate: "0.075", tax_behavior: "exclusive" }]);
  const r = new Quotes(config).quote({ sku: ".ng", quantity: 1 }, "USD");
  // 79.80 * 100 = 7980 minor units; 7980 * 0.075 = 598.5 exactly -> rounds away from zero to 599
  assert.equal(r.tax, 599);
});

test("compound tax: second tax computed on base + first", () => {
  const config = catalogFrom([
    { product_sku: ".ng", price_amount: "100.00", tax_id: "gst", tax_rate: "0.05", tax_behavior: "exclusive", tax_compound: "false" },
    { product_sku: ".ng", price_amount: "100.00", tax_id: "qst", tax_rate: "0.09975", tax_behavior: "exclusive", tax_compound: "true" },
  ]);
  const r = new Quotes(config).quote({ sku: ".ng", quantity: 1 }, "USD");
  const gst = r.taxes.find((t) => t.id === "gst");
  const qst = r.taxes.find((t) => t.id === "qst");
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
  assert.equal(r.salePrice, 0);
  assert.equal(r.total, 150);
});

test("discounts and fees are returned as separate arrays, markup in neither", () => {
  const config = catalogFrom([
    { product_sku: ".ng", price_amount: "10.00", adjustment_kind: "markup", adjustment_type: "rate", adjustment_value: "0.20", adjustment_id: "m" },
    { product_sku: ".ng", price_amount: "10.00", adjustment_kind: "discount", adjustment_type: "rate", adjustment_value: "0.10", adjustment_id: "d" },
    { product_sku: ".ng", price_amount: "10.00", adjustment_kind: "fee", adjustment_type: "amount", adjustment_value: "1.50", adjustment_basis: "line", adjustment_id: "f" },
  ]);
  const r = new Quotes(config).quote({ sku: ".ng", quantity: 1 }, "USD");
  assert.equal(r.discounts.length, 1);
  assert.equal(r.discounts[0].id, "d");
  assert.equal(r.fees.length, 1);
  assert.equal(r.fees[0].id, "f");
  assert.equal(r.debug, undefined, "debug is only populated when explicitly enabled");
});

test("debug mode: markup, cost price and inclusive tax are hidden from the plain quote", () => {
  const config = catalogFrom([
    { product_sku: ".ng", price_amount: "10.00", adjustment_kind: "markup", adjustment_type: "rate", adjustment_value: "0.20", adjustment_id: "m", tax_rate: "0.10", tax_behavior: "inclusive" },
  ]);
  const plain = new Quotes(config).quote({ sku: ".ng", quantity: 1 }, "USD");
  assert.equal(plain.unitPrice, 1200, "cost 1000 * 1.2 markup, folded into unitPrice");
  assert.equal(plain.salePrice, 1200, "no discount/fee on top");
  assert.equal(plain.extendedSalePrice, 1200);
  assert.equal(plain.total, 1200, "inclusive tax adds nothing on top");
  assert.equal(plain.taxes.length, 0);
  assert.equal(plain.tax, 0);
  assert.equal(plain.debug, undefined);

  const withDebug = new Quotes(config, { debug: true }).quote({ sku: ".ng", quantity: 1 }, "USD");
  assert.equal(withDebug.debug.costPrice, 1000, "raw catalog price, before markup");
  assert.equal(withDebug.debug.unitPrice, 1200);
  assert.equal(withDebug.debug.markup.length, 1);
  assert.equal(withDebug.debug.markup[0].amount, 200);
  assert.equal(withDebug.debug.inclusiveTaxes.length, 1);
  assert.equal(withDebug.debug.inclusiveTaxes[0].amount, 109, "1200 - round(1200/1.1)");
  assert.equal(withDebug.debug.taxLiability, 109, "the tax really owed, even though nothing shows in `taxes`");
});
