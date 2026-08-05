import { test } from "node:test";
import assert from "node:assert/strict";
import { Quotes } from "../dist/index.js";
import { load, expectCode } from "./helpers.js";

// ---- Scenario catalog ----

test("Scenario 1: minimal two-column CSV prices with defaults", () => {
  const config = load("product_sku,price_amount\n.ng,10.00");
  const r = new Quotes(config).quote({ sku: ".ng", quantity: 1 }, "USD");
  assert.equal(r.unit.sale, 1000);
});

test("Scenario 2: variant override dominates the wildcard", () => {
  const config = load("product_sku,product_variant,price_amount\n.ng,,10.00\n.ng,transfer,8.00");
  const q = new Quotes(config);
  assert.equal(q.quote({ sku: ".ng", quantity: 1, variant: "transfer" }, "USD").unit.sale, 800);
  assert.equal(q.quote({ sku: ".ng", quantity: 1, variant: "create" }, "USD").unit.sale, 1000);
  assert.equal(q.quote({ sku: ".ng", quantity: 1 }, "USD").unit.sale, 1000);
});

test("Scenario 3: quantity tiers and the boundary", () => {
  const config = load("product_sku,min_quantity,max_quantity,price_amount\n.ng,1,1,16.00\n.ng,2,,15.00");
  const q = new Quotes(config);
  assert.equal(q.quote({ sku: ".ng", quantity: 1 }, "USD").unit.sale, 1600);
  assert.equal(q.quote({ sku: ".ng", quantity: 2 }, "USD").unit.sale, 1500);
  assert.equal(q.quote({ sku: ".ng", quantity: 3 }, "USD").unit.sale, 1500);
});

test("Scenario 4: multi-currency without FX, cart in an uncataloged currency errors", () => {
  const config = load("product_sku,currency,price_amount,charm,charm_position\n.ng,USD,12.34,to9,1\n.ng,JPY,15943,to9,2");
  const q = new Quotes(config);
  assert.equal(q.quote({ sku: ".ng", quantity: 1 }, "USD").unit.sale, 1199);
  assert.equal(q.quote({ sku: ".ng", quantity: 1 }, "JPY").unit.sale, 15999);
  assert.throws(() => q.quote({ sku: ".ng", quantity: 1 }, "EUR"), (e) => e.code === "ERR_CURRENCY_NOT_IN_CATALOG");
});

test("Scenario 5: country-specific price with wildcard fallback", () => {
  const config = load("product_sku,country_code,price_amount\n.ng,,10.00\n.ng,NG,8.00");
  const q = new Quotes(config);
  assert.equal(q.quote({ sku: ".ng", quantity: 1, country: "NG" }, "USD").unit.sale, 800);
  assert.equal(q.quote({ sku: ".ng", quantity: 1, country: "US" }, "USD").unit.sale, 1000);
});

test("Scenario 6: effective-window rollover, exclusive end", () => {
  const config = load(
    "product_sku,price_effective_start,price_effective_end,price_amount\n" +
    ".ng,,2026-01-01,10.00\n.ng,2026-01-01,,12.00",
  );
  const q = new Quotes(config);
  assert.equal(q.quote({ sku: ".ng", quantity: 1 }, "USD", new Date("2026-01-01T00:00:00Z")).unit.sale, 1200);
  assert.equal(q.quote({ sku: ".ng", quantity: 1 }, "USD", new Date("2025-12-31T23:59:59Z")).unit.sale, 1000);
});

test("Scenario 7: bundles via variant axis, features are descriptive only", () => {
  const config = load(
    "product_sku,product_variant,price_amount,product_features\n" +
    ".ng,,10.00,privacy=no\n.ng,with-privacy,13.00,privacy=yes",
  );
  const q = new Quotes(config);
  assert.equal(q.quote({ sku: ".ng", quantity: 1 }, "USD").unit.sale, 1000);
  assert.equal(q.quote({ sku: ".ng", quantity: 1, variant: "with-privacy" }, "USD").unit.sale, 1300);
  const product = config.products.find((p) => p.sku === ".ng");
  assert.equal(product.features.privacy, "yes"); // last row wins in our union; descriptive only
});

test("Scenario 11: free tier is a legal zero total, not an error", () => {
  const config = load("product_sku,price_amount,charm\n.ng,0.00,none");
  const r = new Quotes(config).quote({ sku: ".ng", quantity: 1 }, "USD");
  assert.equal(r.unit.sale, 0);
  assert.equal(r.total, 0);
});

test("Scenario 12: mixed frequency in one cart, each line keeps its own frequency, amountDue sums both", () => {
  const config = load(
    "product_sku,frequency,frequency_interval,price_amount\n" +
    "registration,one-time,,10.00\nsubscription,recurring,month,5.00",
  );
  const q = new Quotes(config);
  const quote = q.quoteCart({
    currency: "USD",
    lines: [
      { sku: "registration", quantity: 1 },
      { sku: "subscription", quantity: 1, frequency: "recurring", interval: "month" },
    ],
  });
  assert.equal(quote.lines[0].frequency, "one-time");
  assert.equal(quote.lines[1].frequency, "recurring");
  assert.equal(quote.lines[1].interval, "month");
  assert.equal(quote.amountDue, 1500);
});

test("Scenario 15: one price, several adjustments merged from two rows (positive + negative controls)", () => {
  const config = load(
    "product_sku,price_amount,adjustment_kind,adjustment_type,adjustment_value,adjustment_label\n" +
    ".ng,10.00,discount,rate,0.10,Launch offer\n.ng,10.00,fee,amount,1.50,ICANN fee",
  );
  assert.equal(config.prices.length, 1);
  assert.equal(config.prices[0].adjustments.length, 2);

  expectCode(
    () => load(
      "product_sku,price_amount,adjustment_kind,adjustment_type,adjustment_value,adjustment_label\n" +
      ".ng,10.00,discount,rate,0.10,Launch offer\n.ng,11.00,fee,amount,1.50,ICANN fee",
    ),
    "ERR_AMBIGUOUS_PRICE",
  );

  expectCode(
    () => load(
      "product_sku,price_amount,adjustment_kind,adjustment_type,adjustment_value,adjustment_label,adjustment_id\n" +
      ".ng,10.00,discount,rate,0.10,Launch offer,d1\n.ng,10.00,discount,rate,0.10,Launch offer,d1",
    ),
    "ERR_DUPLICATE_ADJUSTMENT",
  );
});

test("Scenario 16: mid-tier price change — 2D rectangles that pairwise overlap in 1D must still load", () => {
  const config = load(
    "product_sku,min_quantity,max_quantity,price_effective_start,price_effective_end,price_amount\n" +
    ".ng,1,10,,2026-01-01,16.00\n" +
    ".ng,1,10,2026-01-01,,17.00\n" +
    ".ng,11,,,2026-01-01,15.00\n" +
    ".ng,11,,2026-01-01,,16.00",
  );
  assert.equal(config.prices.length, 4);
});

test("Scenario 17: context-driven eligibility, absent context fails the constraint without throwing", () => {
  const config = load(
    "product_sku,price_amount,adjustment_kind,adjustment_type,adjustment_value,adjustment_constraints\n" +
    ".ng,10.00,discount,rate,0.20,customer_tier=!=free",
  );
  const q = new Quotes(config);
  const pro = q.quoteCart({ currency: "USD", lines: [{ sku: ".ng", quantity: 1 }], context: { customer_tier: "pro" } });
  assert.equal(pro.lines[0].unit.sale, 800);
  const noContext = q.quoteCart({ currency: "USD", lines: [{ sku: ".ng", quantity: 1 }] });
  assert.equal(noContext.lines[0].unit.sale, 1000);
});

// ---- Adversarial catalogs ----

test("Adversarial 1: the missing zero -> ERR_AMBIGUOUS_PRICE", () => {
  expectCode(() => load("product_sku,price_amount\n.ng,50.00\n.ng,5.00"), "ERR_AMBIGUOUS_PRICE");
});

test("Adversarial 2: percentage confusion on tax_rate and adjustment_value", () => {
  expectCode(() => load("product_sku,price_amount,tax_rate\n.ng,10.00,7.5"), "ERR_RATE_OUT_OF_RANGE");
  expectCode(
    () => load("product_sku,price_amount,adjustment_kind,adjustment_type,adjustment_value\n.ng,10.00,discount,rate,10"),
    "ERR_RATE_OUT_OF_RANGE",
  );
});

test("Adversarial 3: unquoted decimal comma shifts columns -> ERR_CSV_SHAPE", () => {
  expectCode(() => load("product_sku,price_amount,currency\n.ng,12,50,USD"), "ERR_CSV_SHAPE");
});

test("Adversarial 3b: quoted decimal comma -> ERR_BAD_NUMBER", () => {
  expectCode(() => load('product_sku,price_amount\n.ng,"12,50"'), "ERR_BAD_NUMBER");
});

test("Adversarial 4: currency symbols and thousands separators -> ERR_BAD_NUMBER", () => {
  expectCode(() => load('product_sku,price_amount\n.ng,"$12.34"'), "ERR_BAD_NUMBER");
  expectCode(() => load('product_sku,price_amount\n.ng,"1,234.00"'), "ERR_BAD_NUMBER");
});

test("Adversarial 5: overlapping quantity tiers -> ERR_AMBIGUOUS_PRICE", () => {
  expectCode(
    () => load("product_sku,min_quantity,max_quantity,price_amount\n.ng,1,10,16.00\n.ng,5,20,15.00"),
    "ERR_AMBIGUOUS_PRICE",
  );
});

test("Adversarial 5b: quantity gap -> ERR_QUANTITY_GAP", () => {
  expectCode(
    () => load("product_sku,min_quantity,max_quantity,price_amount\n.ng,1,10,16.00\n.ng,20,,15.00"),
    "ERR_QUANTITY_GAP",
  );
});

test("Adversarial 6: crossed axes -> ERR_AMBIGUOUS_PRICE", () => {
  expectCode(
    () => load("product_sku,product_variant,country_code,price_amount\n.ng,transfer,,8.00\n.ng,,NG,9.00"),
    "ERR_AMBIGUOUS_PRICE",
  );
});

test("Adversarial 7: forgotten end date resolves via containment; closing early -> ERR_WINDOW_GAP", () => {
  // NOTE: a seller who opens a new price without closing the old one leaves two overlapping,
  // both still-open windows. Rectangle containment resolves this the same way it resolves a
  // qty [1,10] vs qty [1,∞) tiering: the narrower, later-starting window dominates the
  // fully-open older one and wins from its start onward, so this loads rather than erroring.
  const config = load(
    "product_sku,price_effective_start,price_effective_end,price_amount\n" +
    ".ng,,,10.00\n.ng,2026-01-01,,12.00",
  );
  assert.equal(config.prices.length, 2);
  expectCode(
    () => load(
      "product_sku,price_effective_start,price_effective_end,price_amount\n" +
      ".ng,,2025-12-01,10.00\n.ng,2026-01-01,,12.00",
    ),
    "ERR_WINDOW_GAP",
  );
});

test("Adversarial 8: inverted ranges -> ERR_INVERTED_RANGE", () => {
  expectCode(() => load("product_sku,min_quantity,max_quantity,price_amount\n.ng,10,2,10.00"), "ERR_INVERTED_RANGE");
  expectCode(
    () => load("product_sku,price_effective_start,price_effective_end,price_amount\n.ng,2026-06-01,2026-01-01,10.00"),
    "ERR_INVERTED_RANGE",
  );
});

test("Adversarial 9: renamed in one place -> ERR_IDENTITY_CONFLICT", () => {
  expectCode(
    () => load(
      "product_sku,product_name,product_variant,price_amount\n" +
      ".ng,Nigeria Domain,,10.00\n.ng,.ng Domain,transfer,8.00",
    ),
    "ERR_IDENTITY_CONFLICT",
  );
});

test("Adversarial 10: a discount bigger than the product -> ERR_DISCOUNT_EXCEEDS_PRICE", () => {
  expectCode(
    () => load(
      "product_sku,price_amount,adjustment_kind,adjustment_type,adjustment_value\n.ng,10.00,discount,amount,15",
    ),
    "ERR_DISCOUNT_EXCEEDS_PRICE",
  );
});

test("Adversarial 11: stacked discounts past 100%", () => {
  expectCode(
    () => load(
      "product_sku,price_amount,adjustment_kind,adjustment_type,adjustment_value,adjustment_stackable,adjustment_id\n" +
      ".ng,10.00,discount,rate,0.40,true,d1\n.ng,10.00,discount,rate,0.40,true,d2\n.ng,10.00,discount,rate,0.40,true,d3",
    ),
    "ERR_RATE_OUT_OF_RANGE",
  );
});

test("Adversarial 12: a negative fee -> ERR_NEGATIVE_AMOUNT", () => {
  expectCode(
    () => load(
      "product_sku,price_amount,adjustment_kind,adjustment_type,adjustment_value\n.ng,10.00,fee,amount,-5",
    ),
    "ERR_NEGATIVE_AMOUNT",
  );
});

test("Adversarial 13: charm underflow from a catalog-wide default", () => {
  expectCode(() => load("product_sku,price_amount\n.ng,0.02", { charm: "to9", charm_position: 1 }), "ERR_CHARM_UNDERFLOW");
});

test("Adversarial 14: Excel serial dates and trailing NBSP are rejected/normalized", () => {
  expectCode(
    () => load("product_sku,price_effective_start,price_amount\n.ng,46236,10.00"),
    "ERR_BAD_DATE",
  );
  // Trailing NBSP is trimmed, not an error.
  const config = load("product_sku,price_amount\n.ng ,10.00");
  assert.equal(config.products[0].sku, ".ng");
});

test("Adversarial 15: column typos -> ERR_UNKNOWN_COLUMN with a suggestion", () => {
  try {
    load("product_sku,price_ammount\n.ng,10.00");
    assert.fail("expected an error");
  } catch (e) {
    const issue = e.issues.find((i) => i.code === "ERR_UNKNOWN_COLUMN");
    assert.ok(issue);
    assert.match(issue.suggestion, /price_amount/);
  }
});

test("Adversarial 16: constraint in the wrong place -> ERR_CONSTRAINT_ON_PRICE", () => {
  expectCode(
    () => load("product_sku,price_amount,tax_constraints\n.ng,10.00,quantity=>=10"),
    "ERR_CONSTRAINT_ON_PRICE",
  );
});

test("Adversarial 17: duplicated header -> ERR_DUPLICATE_COLUMN", () => {
  expectCode(() => load("product_sku,currency,currency\n.ng,USD,USD"), "ERR_DUPLICATE_COLUMN");
});

test("Adversarial 18: price_sanity_range catches a magnitude error when opted in", () => {
  expectCode(
    () => load("product_sku,price_amount,currency\n.ng,1594300,NGN", { price_sanity_range: { NGN: [1, 100000] } }),
    "ERR_PRICE_SANITY_RANGE",
  );
  // Off by default: the same catalog loads without the opt-in.
  const config = load("product_sku,price_amount,currency\n.ng,1594300,NGN");
  assert.equal(config.prices.length, 1);
});
