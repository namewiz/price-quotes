# price-quotes

[![Build](https://github.com/namewiz/price-quotes/actions/workflows/build.yml/badge.svg)](https://github.com/namewiz/price-quotes/actions/workflows/build.yml)
[![Test](https://github.com/namewiz/price-quotes/actions/workflows/test.yml/badge.svg)](https://github.com/namewiz/price-quotes/actions/workflows/test.yml)
[![NPM](http://img.shields.io/npm/v/price-quotes.svg)](https://www.npmjs.com/package/price-quotes)

A small TypeScript library that turns a spreadsheet-style product catalog — CSV or a plain
array of rows — into a queryable catalog, then prices a cart of line items against it.

The driving scenario is domain-name sales, generalized to any product: a registrar wants to
list `.ng` at $10, `ok.ng` at $5, offer $8 for `.ng` transfers, and $15 for a 2-year `.ng`
registration instead of $16 — all as plain spreadsheet rows, with no code changes. The full
design rationale lives in [`design-docs/design-v2.md`](./design-docs/design-v2.md); this README
is the short version.

## Why

1. **Progressive disclosure.** The only required columns are `product_sku` and `price_amount`.
   Everything else — variants, quantity tiers, currency, tax, discounts — is optional.
2. **Spreadsheet-native.** The catalog round-trips through a CSV a non-engineer edits in Excel
   or Sheets. Structured fields (lists, maps, constraints) fit in a single cell with defined
   escaping.
3. **Declarative, not programmable.** No callback functions in the catalog. Eligibility for a
   price, tax, or discount is a small, closed comparison grammar over a fixed field set.
4. **Fail loudly at load, never silently at checkout.** An ambiguous, contradictory, or
   nonsensical catalog throws when loaded, with every problem reported at once, located by row
   and column. A catalog that loads is a catalog that prices unambiguously.
5. **Whole classes of wrong answers are impossible by construction** — a negative total, a
   mixed-currency cart, a discount exceeding the thing it discounts — excluded by the shape of
   the types and by load-time validation.
6. **O(1) pricing.** Resolving a price is a bounded number of hash lookups and integer
   operations, independent of catalog size. No parsing, no regex, no `Date` or `Intl`
   construction happens at quote time — all of it is precomputed at load.
7. **Correct, reconcilable money math.** All amounts are integer minor units. Quantization
   (representation) and charm (pricing policy, e.g. `$X.99`) are two distinct mechanisms that
   never get conflated; `unitMinor × quantity` is always exact, so unit, subtotal and total
   reconcile.
8. **Reproducible.** A quote is a pure function of `(catalog, cart, asOf)`. It records the
   catalog hash and `asOf` it was computed against, so it can be replayed from an audit log.

## Install

```bash
npm install price-quotes
```

## Quick start

```ts
import { loadCatalog, Quotes } from "price-quotes";

const csv = `
product_sku,product_variant,price_amount,charm,charm_position
.ng,,10.00,to9,1
.ng,transfer,8.00,to9,1
`;

const config = loadCatalog(csv); // throws CatalogError if the catalog is ambiguous/invalid
const quotes = new Quotes(config);

const cart = quotes.quoteCart({
  currency: "USD",
  lines: [
    { sku: ".ng", quantity: 1 },                    // -> $9.99 (charmed)
    { sku: ".ng", quantity: 1, variant: "transfer" }, // -> $7.99
  ],
});

console.log(cart.dueNowMinor, cart.currency, cart.catalogHash);
```

`loadCatalog` also accepts a plain array of row objects instead of CSV text — useful when rows
come from a database or a form rather than a spreadsheet:

```ts
loadCatalog([
  { product_sku: ".ng", price_amount: 10 },
  { product_sku: ".ng", product_variant: "transfer", price_amount: 8 },
]);
```

## The catalog schema

One flat row combines a product fact, a price fact, and optionally one tax fact and one
adjustment (discount/markup/fee) fact. Two placements are worth knowing up front:

- **`product_variant` is a price axis, not product identity** — it selects which price applies.
  `.ng` with variant `transfer` is the same product at a different price.
- **`product_features` is descriptive, not selective** — it's for display/filtering, not
  pricing. Bundles and add-ons are modeled with the variant axis or as separate products; see
  "Scenario 7" in the design doc.

A price with both a discount *and* a fee is authored as two rows that repeat the price — they
merge into one price with two adjustments, not two competing prices:

```csv
product_sku,price_amount,adjustment_kind,adjustment_type,adjustment_value,adjustment_label
.ng,10.00,discount,rate,0.10,Launch offer
.ng,10.00,fee,amount,1.50,ICANN fee
```

Full column reference, CSV escaping rules, and the constraint grammar (`country_code=US;CA`,
`customer_tier=!=free`, `quantity=10..49`, `line_subtotal=>=10000`) are documented in the design
doc's "Data model", "The CSV contract" and "Constraint grammar" sections.

## Catalog-wide defaults and currency overrides

```ts
loadCatalog(csv, {
  product_status: "active",
  quantization: "nearest",
  currency: "USD",
  // Currency exponents always derive from Intl. Rounding increments (cash rounding, e.g. CHF
  // at 0.05) have no Intl source, so they're authored here — quantization happens at load.
  currencies: { CHF: { increment: 5 } },
  // Opt-in per-currency magnitude guard against the one class of error static validation can't
  // catch (a seller typing kobo into a naira column). Off by default.
  price_sanity_range: { NGN: [100, 10_000_000] },
});
```

## Errors

Every failure is a `QuoteError` (or `CatalogError`, a `QuoteError` subclass) with a stable
`.code`, so callers branch on the code, not on message text.

```ts
try {
  loadCatalog(csv);
} catch (err) {
  if (err instanceof CatalogError) {
    for (const issue of err.issues) {
      console.error(issue.code, issue.row, issue.column, issue.message, issue.suggestion);
    }
  }
}
```

Load-time codes include `ERR_AMBIGUOUS_PRICE`, `ERR_QUANTITY_GAP`, `ERR_WINDOW_GAP`,
`ERR_DISCOUNT_EXCEEDS_PRICE`, `ERR_CHARM_UNDERFLOW`, `ERR_UNKNOWN_COLUMN`, and more — see
`src/errors.ts` or the design doc's "Errors" section for the full list. Quote-time codes
(`ERR_UNKNOWN_SKU`, `ERR_NO_PRICE`, `ERR_INVALID_REQUEST`, `ERR_CURRENCY_NOT_IN_CATALOG`,
`ERR_AMOUNT_OVERFLOW`) are deliberately few — most classes of error were made unreachable at
load.

## Development

```bash
npm test    # builds, then runs the test suite (node --test) against dist/
npm start   # builds, then serves docs/ (the CSV catalog playground) locally
```

The test suite (`tests/*.test.js`) covers the CSV contract, the constraint grammar, catalog
compilation and row-merging, every scenario and adversarial catalog from the design doc, money/
charm/rounding (including the design's worked example and known-hard regressions), and the cart
API (grouping, `dueNow`, reproducibility, a flat-latency benchmark from 100 to 100,000 rows).

See [`progress.md`](./progress.md) for the implementation's task-by-task status and a log of
places where this implementation had to make a judgment call the design doc didn't fully settle.

## License

MIT
