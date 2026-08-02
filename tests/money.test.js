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
  assert.equal(r.unitMinor, 1199);
});

test("charm table: USD to9 p0 12.34 -> 12.29 (tie resolves down)", () => {
  const config = catalogFrom([{ product_sku: ".ng", price_amount: "12.34", charm: "to9", charm_position: "0" }]);
  const q = new Quotes(config);
  const r = q.quote({ sku: ".ng", quantity: 1 }, "USD");
  assert.equal(r.unitMinor, 1229);
});

test("charm table: USD to4 p1 12.34 -> 12.49", () => {
  const config = catalogFrom([{ product_sku: ".ng", price_amount: "12.34", charm: "to4", charm_position: "1" }]);
  const q = new Quotes(config);
  const r = q.quote({ sku: ".ng", quantity: 1 }, "USD");
  assert.equal(r.unitMinor, 1249);
});

test("charm table: USD to9 p1 12.00 -> 11.99", () => {
  const config = catalogFrom([{ product_sku: ".ng", price_amount: "12.00", charm: "to9", charm_position: "1" }]);
  const q = new Quotes(config);
  const r = q.quote({ sku: ".ng", quantity: 1 }, "USD");
  assert.equal(r.unitMinor, 1199);
});

// The design doc's worked table labels this case "NGN (exp 0)", but ISO 4217 / Intl gives NGN
// an exponent of 2 (kobo); the doc's example is a stand-in for "a currency with no minor unit"
// (like JPY). We exercise the exponent-0 case against JPY, which Intl agrees has exponent 0.
test("charm table: exponent-0 currency (JPY) to9 p2 15943 -> 15999", () => {
  const config = catalogFrom([{ product_sku: ".ng", price_amount: "15943", currency: "JPY", charm: "to9", charm_position: "2" }]);
  const q = new Quotes(config);
  const r = q.quote({ sku: ".ng", quantity: 1 }, "JPY");
  assert.equal(r.unitMinor, 15999);
});

test("charm underflow: $0.02 to9 p1 is a load error", () => {
  assert.throws(
    () => catalogFrom([{ product_sku: ".ng", price_amount: "0.02", charm: "to9", charm_position: "1" }]),
    (e) => e.issues?.[0].code === "ERR_CHARM_UNDERFLOW",
  );
});

test("reconciliation: unitMinor x quantity === subtotal across quantities and charm modes", () => {
  for (const charm of ["none", "to4", "to9"]) {
    const config = catalogFrom([{ product_sku: ".ng", price_amount: "12.34", charm, charm_position: charm === "none" ? "0" : "1" }]);
    const q = new Quotes(config);
    for (let qty = 1; qty <= 5; qty++) {
      const r = q.quote({ sku: ".ng", quantity: qty }, "USD");
      assert.equal(r.unitMinor * qty, r.subtotalMinor, `qty=${qty} charm=${charm}`);
    }
  }
});

test("quantization modes: floor vs ceil differ under a discount", () => {
  const floorCfg = catalogFrom([{ product_sku: ".ng", price_amount: "10.00", quantization: "floor", adjustment_kind: "discount", adjustment_type: "rate", adjustment_value: "0.333333" }]);
  const ceilCfg = catalogFrom([{ product_sku: ".ng", price_amount: "10.00", quantization: "ceil", adjustment_kind: "discount", adjustment_type: "rate", adjustment_value: "0.333333" }]);
  const floorUnit = new Quotes(floorCfg).quote({ sku: ".ng", quantity: 1 }, "USD").unitMinor;
  const ceilUnit = new Quotes(ceilCfg).quote({ sku: ".ng", quantity: 1 }, "USD").unitMinor;
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
  assert.equal(r.unitMinor % 5, 0, "discounted unit should also land on the 0.05 grid");
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
  const a = new Quotes(two5).quote({ sku: ".ng", quantity: 1 }, "USD").unitMinor;
  const b = new Quotes(one10).quote({ sku: ".ng", quantity: 1 }, "USD").unitMinor;
  assert.equal(a, b);
});

test("markup then discount === discount then markup (common base, commutative)", () => {
  const config = catalogFrom([
    { product_sku: ".ng", price_amount: "12.34", adjustment_kind: "markup", adjustment_type: "rate", adjustment_value: "0.20", adjustment_id: "m" },
    { product_sku: ".ng", price_amount: "12.34", adjustment_kind: "discount", adjustment_type: "rate", adjustment_value: "0.10", adjustment_id: "d" },
  ]);
  const r = new Quotes(config).quote({ sku: ".ng", quantity: 1 }, "USD");
  // base*(1+0.2-0.1) = 12.34*1.1 = 13.574 -> round 1357 (no charm)
  assert.equal(r.unitMinor, 1357);
});

test("charm after markup only: 20% markup on 12.34 to9 p1 -> 14.99", () => {
  const config = catalogFrom([{ product_sku: ".ng", price_amount: "12.34", charm: "to9", charm_position: "1", adjustment_kind: "markup", adjustment_type: "rate", adjustment_value: "0.20" }]);
  const r = new Quotes(config).quote({ sku: ".ng", quantity: 1 }, "USD");
  assert.equal(r.unitMinor, 1499);
});

test("100% discount -> total exactly zero, no error", () => {
  const config = catalogFrom([{ product_sku: ".ng", price_amount: "10.00", adjustment_kind: "discount", adjustment_type: "rate", adjustment_value: "1.0" }]);
  const r = new Quotes(config).quote({ sku: ".ng", quantity: 1 }, "USD");
  assert.equal(r.unitMinor, 0);
  assert.equal(r.totalMinor, 0);
});

test("discount rate of 1.01 is a load error", () => {
  assert.throws(() => catalogFrom([{ product_sku: ".ng", price_amount: "10.00", adjustment_kind: "discount", adjustment_type: "rate", adjustment_value: "1.01" }]));
});

test("inclusive tax with discount: tax charged non-zero, tax added zero", () => {
  const config = catalogFrom([
    { product_sku: ".ng", price_amount: "11.99", tax_rate: "0.075", tax_behavior: "inclusive", adjustment_kind: "discount", adjustment_type: "rate", adjustment_value: "0.10" },
  ]);
  const r = new Quotes(config).quote({ sku: ".ng", quantity: 1 }, "USD");
  assert.ok(r.taxChargedMinor > 0);
  assert.equal(r.taxAddedMinor, 0);
  assert.equal(r.totalMinor, r.subtotalMinor);
});

test("half-cent rounding: 79.8 x 0.075 corrects float error before rounding", () => {
  const config = catalogFrom([{ product_sku: ".ng", price_amount: "79.80", tax_rate: "0.075", tax_behavior: "exclusive" }]);
  const r = new Quotes(config).quote({ sku: ".ng", quantity: 1 }, "USD");
  // 79.80 * 100 = 7980 minor units; 7980 * 0.075 = 598.5 exactly -> rounds away from zero to 599
  assert.equal(r.taxChargedMinor, 599);
});

test("compound tax: second tax computed on base + first", () => {
  const config = catalogFrom([
    { product_sku: ".ng", price_amount: "100.00", tax_id: "gst", tax_rate: "0.05", tax_behavior: "exclusive", tax_compound: "false" },
    { product_sku: ".ng", price_amount: "100.00", tax_id: "qst", tax_rate: "0.09975", tax_behavior: "exclusive", tax_compound: "true" },
  ]);
  const r = new Quotes(config).quote({ sku: ".ng", quantity: 1 }, "USD");
  const gst = r.taxes.find((t) => t.id === "gst");
  const qst = r.taxes.find((t) => t.id === "qst");
  assert.equal(gst.chargedMinor, 500);
  // QST compounds on 10000 + 500 = 10500 -> 10500*0.09975 = 1047.375 -> round 1047
  assert.equal(qst.chargedMinor, 1047);
});

test("fee survives a discount that zeroes the subtotal; total stays non-negative", () => {
  const config = catalogFrom([
    { product_sku: ".ng", price_amount: "10.00", adjustment_kind: "discount", adjustment_type: "rate", adjustment_value: "1.0", adjustment_id: "d" },
    { product_sku: ".ng", price_amount: "10.00", adjustment_kind: "fee", adjustment_type: "amount", adjustment_value: "1.50", adjustment_basis: "line", adjustment_id: "f" },
  ]);
  const r = new Quotes(config).quote({ sku: ".ng", quantity: 1 }, "USD");
  assert.equal(r.unitMinor, 0);
  assert.equal(r.totalMinor, 150);
});
