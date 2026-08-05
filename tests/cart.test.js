import { test } from "node:test";
import assert from "node:assert/strict";
import { Quotes } from "../dist/index.js";
import { load, expectCode } from "./helpers.js";

test("multi-line cart prices every line independently", () => {
  const config = load("product_sku,price_amount\n.ng,10.00\nhosting,60.00");
  const q = new Quotes(config);
  const quote = q.quoteCart({
    currency: "USD",
    lines: [{ sku: ".ng", quantity: 2 }, { sku: "hosting", quantity: 1 }],
  });
  assert.equal(quote.lines.length, 2);
  assert.equal(quote.amountDue, 2000 + 6000);
});

test("a cart in a currency with no catalog rows errors before any line resolves", () => {
  const config = load("product_sku,price_amount,currency\n.ng,10.00,USD");
  const q = new Quotes(config);
  expectCode(() => q.quoteCart({ currency: "EUR", lines: [{ sku: ".ng", quantity: 1 }] }), "ERR_CURRENCY_NOT_IN_CATALOG");
});

test("an unpriceable line fails the whole cart, naming the line index and SKU", () => {
  const config = load("product_sku,price_amount\n.ng,10.00");
  const q = new Quotes(config);
  try {
    q.quoteCart({ currency: "USD", lines: [{ sku: ".ng", quantity: 1 }, { sku: "unknown-sku", quantity: 1 }] });
    assert.fail("expected an error");
  } catch (e) {
    assert.equal(e.code, "ERR_UNKNOWN_SKU");
    assert.match(e.message, /line 1/);
    assert.match(e.message, /unknown-sku/);
  }
});

test("the same cart at two asOf values spanning an effective-window boundary gives different prices", () => {
  const config = load(
    "product_sku,price_effective_start,price_effective_end,price_amount\n.ng,,2026-01-01,10.00\n.ng,2026-01-01,,12.00",
  );
  const q = new Quotes(config);
  const before = q.quoteCart({ currency: "USD", lines: [{ sku: ".ng", quantity: 1 }], asOf: new Date("2025-12-31T23:59:59Z") });
  const after = q.quoteCart({ currency: "USD", lines: [{ sku: ".ng", quantity: 1 }], asOf: new Date("2026-01-01T00:00:00Z") });
  assert.equal(before.lines[0].unit.sale, 1000);
  assert.equal(after.lines[0].unit.sale, 1200);
});

test("a quote replayed from (catalogHash, asOf, lines) is identical", () => {
  const config = load("product_sku,price_amount,tax_rate\n.ng,12.34,0.075");
  const q = new Quotes(config);
  const request = { currency: "USD", lines: [{ sku: ".ng", quantity: 3 }], asOf: new Date("2026-06-01T00:00:00Z") };
  const first = q.quoteCart(request);
  const second = q.quoteCart({ ...request, asOf: new Date(request.asOf) });
  assert.deepEqual(first, second);
});

test("invalid quantity (zero, fractional, negative) is ERR_INVALID_REQUEST", () => {
  const config = load("product_sku,price_amount\n.ng,10.00");
  const q = new Quotes(config);
  for (const quantity of [0, -1, 1.5]) {
    expectCode(() => q.quote({ sku: ".ng", quantity }, "USD"), "ERR_INVALID_REQUEST");
  }
});

test("property: total is never negative across a range of quantities, discounts and fees", () => {
  const config = load(
    "product_sku,price_amount,adjustment_kind,adjustment_type,adjustment_value,adjustment_id\n" +
    ".ng,9.99,discount,rate,0.9999,d\n.ng,9.99,fee,amount,0.01,f",
  );
  const q = new Quotes(config);
  for (let quantity = 1; quantity <= 25; quantity++) {
    const r = q.quote({ sku: ".ng", quantity }, "USD");
    assert.ok(r.total >= 0, `quantity=${quantity} total=${r.total}`);
    assert.equal(r.unit.sale * quantity, r.extended.sale);
  }
});

test("property: row order never changes the quote for equivalent catalogs", () => {
  const csvA = "product_sku,price_amount,product_variant\n.ng,10.00,\n.ng,8.00,transfer\nhosting,60.00,";
  const csvB = "product_sku,price_amount,product_variant\nhosting,60.00,\n.ng,8.00,transfer\n.ng,10.00,";
  const qa = new Quotes(load(csvA));
  const qb = new Quotes(load(csvB));
  const cart = { currency: "USD", lines: [{ sku: ".ng", quantity: 1 }, { sku: ".ng", quantity: 1, variant: "transfer" }, { sku: "hosting", quantity: 2 }] };
  const ra = qa.quoteCart(cart);
  const rb = qb.quoteCart(cart);
  assert.equal(ra.amountDue, rb.amountDue);
  assert.deepEqual(ra.lines.map((l) => l.unit.sale), rb.lines.map((l) => l.unit.sale));
});

test("performance: quote latency is flat from 100 to 100,000 price rows", () => {
  function buildCatalog(n) {
    const rows = ["product_sku,price_amount,min_quantity,max_quantity"];
    for (let i = 0; i < n; i++) {
      rows.push(`sku-${i},${(10 + (i % 90)).toFixed(2)},1,`);
    }
    return load(rows.join("\n"));
  }

  function timeQuotes(config, iterations) {
    const q = new Quotes(config);
    const start = process.hrtime.bigint();
    for (let i = 0; i < iterations; i++) {
      q.quote({ sku: `sku-${i % 100}`, quantity: 1 }, "USD");
    }
    const end = process.hrtime.bigint();
    return Number(end - start) / 1e6 / iterations; // ms per quote
  }

  const small = buildCatalog(100);
  const large = buildCatalog(100_000);
  const smallMs = timeQuotes(small, 2000);
  const largeMs = timeQuotes(large, 2000);

  // Not a tight bound (CI noise), but catches an O(n) regression outright: 100,000 rows
  // should not be drastically slower per-quote than 100 rows if resolution is truly O(1).
  assert.ok(largeMs < smallMs * 20 + 1, `expected flat latency, got small=${smallMs}ms large=${largeMs}ms`);
});
