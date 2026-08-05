import { test } from "node:test";
import assert from "node:assert/strict";
import { Quotes } from "../dist/index.js";
import { load, expectCode } from "./helpers.js";

function discountCatalog(constraint) {
  return load(
    "product_sku,price_amount,adjustment_kind,adjustment_type,adjustment_value,adjustment_constraints\n" +
    `.ng,10.00,discount,rate,0.20,"${constraint}"`,
  );
}

test("OR-set: country_code=US;CA", () => {
  const config = discountCatalog("country_code=US;CA");
  const q = new Quotes(config);
  assert.equal(q.quote({ sku: ".ng", quantity: 1, country: "US" }, "USD").unit.sale, 800);
  assert.equal(q.quote({ sku: ".ng", quantity: 1, country: "CA" }, "USD").unit.sale, 800);
  assert.equal(q.quote({ sku: ".ng", quantity: 1, country: "NG" }, "USD").unit.sale, 1000);
});

test("negation: customer_tier=!=free", () => {
  const config = discountCatalog("customer_tier=!=free");
  const q = new Quotes(config);
  const pro = q.quoteCart({ currency: "USD", lines: [{ sku: ".ng", quantity: 1 }], context: { customer_tier: "pro" } });
  assert.equal(pro.lines[0].unit.sale, 800);
  const free = q.quoteCart({ currency: "USD", lines: [{ sku: ".ng", quantity: 1 }], context: { customer_tier: "free" } });
  assert.equal(free.lines[0].unit.sale, 1000);
});

test("inclusive range: quantity=10..49", () => {
  const config = discountCatalog("quantity=10..49");
  const q = new Quotes(config);
  assert.equal(q.quote({ sku: ".ng", quantity: 9 }, "USD").unit.sale, 1000);
  assert.equal(q.quote({ sku: ".ng", quantity: 10 }, "USD").unit.sale, 800);
  assert.equal(q.quote({ sku: ".ng", quantity: 49 }, "USD").unit.sale, 800);
  assert.equal(q.quote({ sku: ".ng", quantity: 50 }, "USD").unit.sale, 1000);
});

test("threshold on line_subtotal (minor units, pre-adjustment)", () => {
  const config = discountCatalog("line_subtotal=>=10000");
  const q = new Quotes(config);
  assert.equal(q.quote({ sku: ".ng", quantity: 99 }, "USD").unit.sale, 800); // 99*1000=99000 >= 10000
  assert.equal(q.quote({ sku: ".ng", quantity: 1 }, "USD").unit.sale, 1000); // 1000 < 10000
});

test("bare value is literal equality", () => {
  const config = discountCatalog("variant=transfer");
  const q = new Quotes(config);
  assert.equal(q.quote({ sku: ".ng", quantity: 1, variant: "transfer" }, "USD").unit.sale, 800);
  assert.equal(q.quote({ sku: ".ng", quantity: 1, variant: "create" }, "USD").unit.sale, 1000);
});

test("AND across keys", () => {
  const config = discountCatalog("country_code=US;CA & quantity=>=10");
  const q = new Quotes(config);
  assert.equal(q.quote({ sku: ".ng", quantity: 10, country: "US" }, "USD").unit.sale, 800);
  assert.equal(q.quote({ sku: ".ng", quantity: 1, country: "US" }, "USD").unit.sale, 1000);
  assert.equal(q.quote({ sku: ".ng", quantity: 10, country: "NG" }, "USD").unit.sale, 1000);
});

test("relational operator on a string field is a load error", () => {
  expectCode(() => discountCatalog("country_code=>=US"), "ERR_CONSTRAINT_SYNTAX");
});

test("unknown constraint field errors with a suggestion", () => {
  try {
    discountCatalog("contry_code=NG");
    assert.fail("expected an error");
  } catch (e) {
    const issue = e.issues.find((i) => i.code === "ERR_CONSTRAINT_UNKNOWN_FIELD");
    assert.ok(issue, JSON.stringify(e.issues));
    assert.match(issue.suggestion, /country_code/);
  }
});

test("cart-scoped keys are rejected", () => {
  expectCode(() => discountCatalog("cart_subtotal=>=10000"), "ERR_CONSTRAINT_CART_SCOPE");
});

test("a known field absent from the query fails the constraint without throwing", () => {
  const config = discountCatalog("customer_tier=!=free");
  const q = new Quotes(config);
  // no context supplied at all -> customer_tier is absent -> constraint fails, base price applies
  const r = q.quoteCart({ currency: "USD", lines: [{ sku: ".ng", quantity: 1 }] });
  assert.equal(r.lines[0].unit.sale, 1000);
});
