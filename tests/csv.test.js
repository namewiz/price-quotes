import { test } from "node:test";
import assert from "node:assert/strict";
import { Quotes } from "../dist/index.js";
import { load, expectCode } from "./helpers.js";

test("BOM is stripped", () => {
  const config = load("﻿product_sku,price_amount\n.ng,10.00");
  assert.equal(config.products[0].sku, ".ng");
});

test("CRLF and mixed line endings both parse", () => {
  const crlf = load("product_sku,price_amount\r\n.ng,10.00\r\n");
  assert.equal(crlf.products.length, 1);
  const mixed = load("product_sku,price_amount\r\n.ng,10.00\nother,5.00\r\n");
  assert.equal(mixed.products.length, 2);
});

test("quoted commas inside a cell survive", () => {
  const config = load('product_sku,product_name,price_amount\n.ng,"Nigeria, the .ng domain",10.00');
  assert.equal(config.products[0].name, "Nigeria, the .ng domain");
});

test("a row with the wrong field count is a shape error", () => {
  expectCode(() => load("product_sku,price_amount,currency\n.ng,10.00"), "ERR_CSV_SHAPE");
});

test("blank cell inherits the catalog default; explicit \"\" clears it", () => {
  const blank = load("product_sku,product_name,price_amount\n.ng,,10.00", { product_name: "Default Name" });
  assert.equal(blank.products[0].name, "Default Name");
  const cleared = load('product_sku,product_name,price_amount\n.ng,"",10.00', { product_name: "Default Name" });
  assert.equal(cleared.products[0].name, "");
});

test("a fully-blank row is skipped (Excel leftover)", () => {
  const config = load("product_sku,price_amount\n.ng,10.00\n,\nother,5.00");
  assert.equal(config.products.length, 2);
});

test("leading/trailing whitespace and NBSP are trimmed; interior whitespace is preserved", () => {
  const config = load("product_sku,product_name,price_amount\n.ng, Nigeria Domain ,10.00");
  assert.equal(config.products[0].name, "Nigeria Domain");
});

test("booleans accept true/false/yes/no/1/0 case-insensitively", () => {
  for (const [text, expected] of [["true", true], ["YES", true], ["1", true], ["false", false], ["No", false], ["0", false]]) {
    const config = load(
      `product_sku,price_amount,tax_rate,tax_compound\n.ng,10.00,0.1,${text}`,
    );
    assert.equal(config.prices[0].taxes[0].compound, expected, text);
  }
});

test("an unrecognized boolean is an error", () => {
  expectCode(() => load("product_sku,price_amount,tax_rate,tax_compound\n.ng,10.00,0.1,maybe"), "ERR_BAD_BOOLEAN");
});

test("date-only value is UTC midnight", () => {
  const config = load("product_sku,price_effective_start,price_amount\n.ng,2026-03-01,10.00");
  assert.equal(config.prices[0].effectiveStart, Date.parse("2026-03-01T00:00:00.000Z"));
});

test("list and map cells parse with `;`/`=` escaping", () => {
  const config = load('product_sku,product_aliases,product_features,price_amount\n.ng,"ng;dotng",k1=v1;k2=v2,10.00');
  const product = config.products[0];
  assert.deepEqual(new Set(product.aliases), new Set(["ng", "dotng"]));
  assert.deepEqual(product.features, { k1: "v1", k2: "v2" });
});

test("escaped delimiters inside list cells are literal", () => {
  const config = load('product_sku,product_tags,price_amount\n.ng,"a\\;b;c",10.00');
  assert.deepEqual(config.products[0].tags, ["a;b", "c"]);
});
