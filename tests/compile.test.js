import { test } from "node:test";
import assert from "node:assert/strict";
import { Quotes } from "../dist/index.js";
import { load, expectCode } from "./helpers.js";

function shuffle(rows, seed) {
  const arr = [...rows];
  let s = seed;
  const rand = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function buildCsv(header, rows) {
  return [header.join(","), ...rows.map((r) => r.join(","))].join("\n");
}

test("defaulting: catalog-wide defaults fill blank cells, never inherited from another row", () => {
  const config = load("product_sku,product_family,price_amount\n.ng,,10.00\nother,Domains,5.00", { product_family: "Default Family" });
  assert.equal(config.products.find((p) => p.sku === ".ng").family, "Default Family");
  assert.equal(config.products.find((p) => p.sku === "other").family, "Domains");
});

test("identity agreement: disagreeing non-blank identity fields across rows for one SKU errors", () => {
  expectCode(
    () => load("product_sku,product_name,product_variant,price_amount\n.ng,Nigeria Domain,,10.00\n.ng,.ng Domain,transfer,8.00"),
    "ERR_IDENTITY_CONFLICT",
  );
});

test("identity agreement: blank identity cells defer and do not conflict", () => {
  const config = load("product_sku,product_name,product_variant,price_amount\n.ng,Nigeria Domain,,10.00\n.ng,,transfer,8.00");
  assert.equal(config.products[0].name, "Nigeria Domain");
});

test("content-derived price IDs are stable across a row shuffle: byte-identical catalogHash", () => {
  const header = [
    "product_sku", "price_amount", "product_variant", "min_quantity", "max_quantity",
    "currency", "adjustment_kind", "adjustment_type", "adjustment_value", "adjustment_id",
  ];
  const rows = [
    [".ng", "10.00", "", "1", "", "USD", "", "", "", ""],
    [".ng", "8.00", "transfer", "1", "", "USD", "", "", "", ""],
    ["hosting", "60.00", "", "1", "10", "USD", "discount", "rate", "0.10", "promo"],
    ["hosting", "55.00", "", "11", "", "USD", "", "", "", ""],
    ["addon", "2.00", "", "1", "", "EUR", "", "", "", ""],
  ];

  const base = load(buildCsv(header, rows));
  for (let seed = 1; seed <= 5; seed++) {
    const shuffled = load(buildCsv(header, shuffle(rows, seed * 7919)));
    assert.equal(shuffled.hash, base.hash, `seed ${seed}`);
    assert.equal(shuffled.prices.length, base.prices.length);
  }
});

test("hash is unaffected by presentation/provenance-only differences", () => {
  const a = load("product_sku,product_name,price_amount\n.ng,Old Name,10.00");
  const b = load("product_sku,product_name,price_amount\n.ng,New Name,10.00");
  assert.equal(a.hash, b.hash);
});

test("hash changes when a priceable fact changes", () => {
  const a = load("product_sku,price_amount\n.ng,10.00");
  const b = load("product_sku,price_amount\n.ng,10.01");
  assert.notEqual(a.hash, b.hash);
});

test("explicit price_id is honored verbatim", () => {
  const config = load("product_sku,price_id,price_amount\n.ng,my-custom-id,10.00");
  assert.equal(config.prices[0].id, "my-custom-id");
});

test("explicit price_id reused with conflicting price-block fields errors", () => {
  expectCode(
    () => load("product_sku,price_id,price_amount,product_variant\n.ng,pid1,10.00,\n.ng,pid1,8.00,transfer"),
    "ERR_PRICE_ID_CONFLICT",
  );
});

test("identical rows dedupe (redundant duplicate row adds nothing)", () => {
  const config = load("product_sku,price_amount\n.ng,10.00\n.ng,10.00");
  assert.equal(config.prices.length, 1);
});

test("row merge is order-independent: shuffling the two rows of one price yields an identical adjustment list", () => {
  const a = load(
    "product_sku,price_amount,adjustment_kind,adjustment_type,adjustment_value,adjustment_id\n" +
    ".ng,10.00,discount,rate,0.10,d1\n.ng,10.00,fee,amount,1.50,f1",
  );
  const b = load(
    "product_sku,price_amount,adjustment_kind,adjustment_type,adjustment_value,adjustment_id\n" +
    ".ng,10.00,fee,amount,1.50,f1\n.ng,10.00,discount,rate,0.10,d1",
  );
  assert.deepEqual(a.prices[0].adjustments.map((x) => x.id), b.prices[0].adjustments.map((x) => x.id));
  assert.equal(a.hash, b.hash);
});

test("alias conflict: an alias claimed by two different products errors", () => {
  expectCode(
    () => load("product_sku,product_aliases,price_amount\nng-domain,ng,10.00\nother,ng,5.00"),
    "ERR_ALIAS_CONFLICT",
  );
});

test("a product may alias its own SKU harmlessly", () => {
  const config = load("product_sku,product_aliases,price_amount\n.ng,.ng;ng,10.00");
  assert.equal(config.index.aliasToSku.get("ng"), ".ng");
});

test("inactive product: unknown SKU at quote time, but still fully validated at load", () => {
  expectCode(
    () => load("product_sku,product_status,min_quantity,max_quantity,price_amount\n.ng,inactive,1,10,10.00\n.ng,inactive,5,20,9.00"),
    "ERR_AMBIGUOUS_PRICE",
  );
  const config = load("product_sku,product_status,price_amount\n.ng,inactive,10.00");
  const q = new Quotes(config);
  assert.throws(() => q.quote({ sku: ".ng", quantity: 1 }, "USD"), (e) => e.code === "ERR_UNKNOWN_SKU");
  assert.equal(config.products[0].status, "inactive");
});
