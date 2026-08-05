import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Quotes, loadCatalog } from "../dist/index.js";
import { expectCode } from "./helpers.js";

// Fixture emulates ngdomain's real domain catalog: pricing sourced from
// registrar-pricelist/data/unified-{create,renew,transfer}-prices.csv (openprovider TLDs)
// and registrar-pricelist/data/nira-prices.json (.ng family), with the .ng discount rules
// from server/src/config.ts (ALL_NG_DISCOUNT, NG_DISCOUNT, COM_NG_DISCOUNT) applied as
// stackable adjustment rows on the create/transfer variants only.

const fixturePath = fileURLToPath(new URL("./fixtures/ngdomain-catalog.csv", import.meta.url));
const csv = readFileSync(fixturePath, "utf8");

function catalog() {
  return loadCatalog(csv);
}

function quotes() {
  return new Quotes(catalog());
}

test("the fixture catalog loads without ambiguity or validation errors", () => {
  assert.doesNotThrow(() => catalog());
});

test("all products load as active domain-category SKUs", () => {
  const config = catalog();
  const skus = config.products.map((p) => p.sku).sort();
  assert.deepEqual(
    skus,
    [
      "aaa.pro", "abc.br", "biz", "co", "com", "com.ng", "edu.ng", "i.ng", "in", "info",
      "io", "mobi.ng", "name.ng", "net", "net.ng", "ng", "org", "org.ng", "pro", "sch.ng",
    ].sort(),
  );
  for (const p of config.products) {
    assert.equal(p.status, "active");
    assert.equal(p.category, "domain");
  }
});

test(".ng stacks ALL_NG_DISCOUNT (20%) and NG_DISCOUNT (33.18%) on create and transfer only", () => {
  const q = quotes();
  // 951 minor units base, 53.18% combined discount -> round(951 * 0.4682) = 445
  assert.equal(q.quote({ sku: "ng", quantity: 1, variant: "create" }, "USD").unit.sale, 445);
  assert.equal(q.quote({ sku: "ng", quantity: 1, variant: "transfer" }, "USD").unit.sale, 445);
  // renew is not in the DISCOUNTS.transactions list, so it stays full price
  assert.equal(q.quote({ sku: "ng", quantity: 1, variant: "renew" }, "USD").unit.sale, 951);
});

test("com.ng stacks ALL_NG_DISCOUNT (20%) and COM_NG_DISCOUNT (20.43%) on create and transfer only", () => {
  const q = quotes();
  // 439 minor units base, 40.43% combined discount -> round(439 * 0.5957) = 262
  assert.equal(q.quote({ sku: "com.ng", quantity: 1, variant: "create" }, "USD").unit.sale, 262);
  assert.equal(q.quote({ sku: "com.ng", quantity: 1, variant: "transfer" }, "USD").unit.sale, 262);
  assert.equal(q.quote({ sku: "com.ng", quantity: 1, variant: "renew" }, "USD").unit.sale, 439);
});

test("the remaining .ng-family extensions only get the blanket ALL_NG_DISCOUNT (20%)", () => {
  const q = quotes();
  for (const sku of ["org.ng", "net.ng", "edu.ng", "sch.ng", "mobi.ng", "i.ng"]) {
    // 439 * 0.8 = 351.2 -> 351
    assert.equal(q.quote({ sku, quantity: 1, variant: "create" }, "USD").unit.sale, 351, sku);
    assert.equal(q.quote({ sku, quantity: 1, variant: "transfer" }, "USD").unit.sale, 351, sku);
    assert.equal(q.quote({ sku, quantity: 1, variant: "renew" }, "USD").unit.sale, 439, sku);
  }
  // 29 * 0.8 = 23.2 -> 23
  assert.equal(q.quote({ sku: "name.ng", quantity: 1, variant: "create" }, "USD").unit.sale, 23);
  assert.equal(q.quote({ sku: "name.ng", quantity: 1, variant: "renew" }, "USD").unit.sale, 29);
});

test("gTLD/ccTLD prices match the registrar pricelist for each transaction variant", () => {
  const q = quotes();
  const cases = [
    ["com", 1198, 1698, 1198],
    ["net", 1553, 1999, 1999],
    ["org", 1999, 2090, 1999],
    ["info", 2698, 3998, 2698],
    ["biz", 2198, 2898, 2198],
    ["pro", 2698, 3598, 2698],
    ["io", 7498, 8998, 7498],
    ["co", 3998, 4698, 3998],
    ["in", 769, 1100, 769],
    ["aaa.pro", 22200, 22200, 22200],
  ];
  for (const [sku, create, renew, transfer] of cases) {
    assert.equal(q.quote({ sku, quantity: 1, variant: "create" }, "USD").unit.sale, create, `${sku} create`);
    assert.equal(q.quote({ sku, quantity: 1, variant: "renew" }, "USD").unit.sale, renew, `${sku} renew`);
    assert.equal(q.quote({ sku, quantity: 1, variant: "transfer" }, "USD").unit.sale, transfer, `${sku} transfer`);
  }
});

test("abc.br transfer is a legitimate free line, not an error (registrar lists it at 0)", () => {
  const q = quotes();
  const r = q.quote({ sku: "abc.br", quantity: 1, variant: "transfer" }, "USD");
  assert.equal(r.unit.sale, 0);
  assert.equal(r.total, 0);
  assert.equal(q.quote({ sku: "abc.br", quantity: 1, variant: "create" }, "USD").unit.sale, 4338);
  assert.equal(q.quote({ sku: "abc.br", quantity: 1, variant: "renew" }, "USD").unit.sale, 3664);
});

test("every SKU requires an explicit variant: there is no wildcard create/renew/transfer price", () => {
  const q = quotes();
  expectCode(() => q.quote({ sku: "com", quantity: 1 }, "USD"), "ERR_NO_PRICE");
});

test("a cart mixing a .ng registration and a gTLD renewal prices each line independently", () => {
  const q = quotes();
  const quote = q.quoteCart({
    currency: "USD",
    lines: [
      { sku: "ng", quantity: 1, variant: "create" },
      { sku: "com", quantity: 1, variant: "renew" },
    ],
  });
  assert.equal(quote.lines[0].unit.sale, 445);
  assert.equal(quote.lines[1].unit.sale, 1698);
  assert.equal(quote.amountDue, 445 + 1698);
});
