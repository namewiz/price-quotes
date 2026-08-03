# price-quotes

[![Build](https://github.com/namewiz/price-quotes/actions/workflows/build.yml/badge.svg)](https://github.com/namewiz/price-quotes/actions/workflows/build.yml)
[![Test](https://github.com/namewiz/price-quotes/actions/workflows/test.yml/badge.svg)](https://github.com/namewiz/price-quotes/actions/workflows/test.yml)
[![NPM](http://img.shields.io/npm/v/price-quotes.svg)](https://www.npmjs.com/package/price-quotes)

A small TypeScript library that turns a spreadsheet-style product catalog — CSV or a plain array
of rows — into a queryable catalog, then prices a cart of line items against it.

The only required columns are `product_sku` and `price_amount`; variants, quantity tiers,
currencies, tax and discounts are optional and can be added later. An ambiguous or contradictory
catalog throws when it loads, with every problem located by row and column, so a catalog that
loads is a catalog that prices unambiguously. All amounts are integer minor units, and a quote is
a pure function of `(catalog, cart, asOf)`.

Rationale, the full column reference, the constraint grammar, and the pricing math live in
[`design-docs/design.md`](./design-docs/design.md).

## Install

```bash
npm install price-quotes
```

## Quick start

```ts
import { loadCatalog, Quotes } from "price-quotes";

// The first line must be the header — no leading blank line.
const csv = `product_sku,product_variant,price_amount,charm,charm_position
.ng,,10.00,to9,1
.ng,transfer,8.00,to9,1`;

const config = loadCatalog(csv); // throws CatalogError if the catalog is ambiguous/invalid
const quotes = new Quotes(config);

const cart = quotes.quoteCart({
  currency: "USD",
  lines: [
    { sku: ".ng", quantity: 1 },                      // -> $9.99 (charmed)
    { sku: ".ng", quantity: 1, variant: "transfer" }, // -> $7.99
  ],
});

console.log(cart.amountDue, cart.currency, cart.catalogHash);
```

`loadCatalog` also accepts a plain array of row objects, for rows coming from a database or a
form rather than a spreadsheet:

```ts
loadCatalog([
  { product_sku: ".ng", price_amount: 10 },
  { product_sku: ".ng", product_variant: "transfer", price_amount: 8 },
]);
```

## API

```ts
loadCatalog(input: string | CatalogRowInput[], defaults?: CatalogDefaults): CatalogConfig

new Quotes(config: CatalogConfig, options?: {
  defaultTaxBehavior?: "inclusive" | "exclusive";  // for tax_behavior: unspecified; default "exclusive"
  normalizeSku?: (raw: string) => string;          // beyond what product_aliases covers
  debug?: boolean;                                 // default false; see "Debug breakdown"
})

quotes.quoteCart(request: CartRequest): CartQuote
quotes.quote(line: CartLine, currency: string, asOf?: Date): LineQuote
```

`CartRequest` carries `currency`, `lines`, an optional `asOf` (defaults to now, always recorded
on the result), and an optional `context` map available to the constraint grammar. Currency lives
on the cart, not the line, so a mixed-currency cart has nowhere to be expressed. `quoteCart`
throws on the first unpriceable line rather than returning a partial cart; call `quote()` per
line if you want best-effort behavior.

`CartQuote` is `{ lines, amountDue, currency, asOf, catalogHash }`. There is no per-billing-period
grouping — bucket `lines` by `frequency`/`interval` yourself if you need sub-totals.

### `LineQuote`

All amounts are integer minor units (cents, kobo, …), listed in pipeline order.

| Field | Meaning |
|---|---|
| `unitPrice` | Regular per-unit price: the catalog price with any markup folded in. The "list price" before any deal. |
| `extendedUnitPrice` | `unitPrice * quantity` — the pre-discount list line total. |
| `salePrice` | Actual per-unit price charged, after unit-basis discounts/fees and charm. |
| `extendedSalePrice` | `salePrice * quantity`. Computed **before** `netLineAdjustment` and tax, so `extendedSalePrice + tax` is *not* generally `total`. |
| `discounts` / `fees` | Itemized unit-basis adjustments (`AppliedCharge[]`), valued against `unitPrice`. |
| `netLineAdjustment` | Net *line-basis* fee minus discount. Negative when the line discount exceeds the line fee. |
| `taxes` | Taxes that actually add to the bill (`AppliedTax[]`). |
| `tax` | Sum of `taxes[].amount`. Zero when every applicable tax is inclusive. |
| `total` | `extendedSalePrice + netLineAdjustment + tax`. |
| `amountDue` | On `CartQuote`: the sum of every line's `total`. |

Plus identity fields echoed from resolution: `ref`, `sku`, `priceId`, `quantity`, `variant`,
`country`, `currency`, `frequency`, `interval`.

## The catalog schema

One flat row combines a product fact, a price fact, and optionally one tax fact and one
adjustment (discount/markup/fee) fact. Two placements are worth knowing up front:

- **`product_variant` is a price axis, not product identity** — it selects which price applies.
  `.ng` with variant `transfer` is the same product at a different price.
- **`product_features` is descriptive, not selective** — for display and filtering, not pricing.
  Bundles are modeled with the variant axis or as separate products.

A price with both a discount *and* a fee is authored as two rows repeating the price; they merge
into one price with two adjustments, not two competing prices:

```csv
product_sku,price_amount,adjustment_kind,adjustment_type,adjustment_value,adjustment_label
.ng,10.00,discount,rate,0.10,Launch offer
.ng,10.00,fee,amount,1.50,ICANN fee
```

Constraint cells gate a tax or adjustment on the line being priced —
`country_code=US;CA`, `customer_tier=!=free`, `quantity=10..49`, `line_subtotal=>=10000`, AND-ed
with `&`.

### Catalog-wide defaults

```ts
loadCatalog(csv, {
  product_status: "active",
  quantization: "nearest",
  currency: "USD",
  // Currency exponents derive from Intl. Rounding increments (cash rounding, e.g. CHF at 0.05)
  // have no Intl source, so they are authored here — quantization happens at load, not on Quotes.
  currencies: { CHF: { increment: 5 } },
  // Opt-in per-currency magnitude guard against the one error static validation can't catch
  // (a seller typing kobo into a naira column). Off by default.
  price_sanity_range: { NGN: [100, 10_000_000] },
});
```

## Debug breakdown

The plain quote hides two things that are the seller's business, not the customer's: catalog
**markup**, which is folded into `unitPrice` and never itemized, and **inclusive tax**, which
never appears in `taxes` because nothing was added to the bill. Pass `debug: true` to see both:

```ts
const quotes = new Quotes(config, { debug: true });
const cart = quotes.quoteCart({ currency: "USD", lines: [{ sku: ".ng", quantity: 1 }] });

const { costPrice, markup, unitPrice, inclusiveTaxes, taxLiability } = cart.lines[0].debug;
```

- `costPrice` — the raw catalog price, before markup.
- `markup` — the itemized markup folded into `unitPrice`.
- `inclusiveTaxes` — taxes baked into the price, with their extracted amount.
- `taxLiability` — total tax actually owed (exclusive plus the extracted portion of inclusive),
  which differs from the customer-facing `tax`.

`debug` is `undefined` on every line when the option is off, so the default output stays exactly
invoice-shaped.

## Errors

Every failure is a `QuoteError` (or `CatalogError`, a `QuoteError` subclass) with a stable
`.code`, so callers branch on the code, not on message text. Load-time issues are collected and
thrown together.

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
`ERR_DISCOUNT_EXCEEDS_PRICE`, `ERR_CHARM_UNDERFLOW` and `ERR_UNKNOWN_COLUMN`; see `src/errors.ts`
for the full list. Quote-time codes are deliberately few — most classes of error were made
unreachable at load: `ERR_UNKNOWN_SKU`, `ERR_NO_PRICE`, `ERR_INVALID_REQUEST`,
`ERR_CURRENCY_NOT_IN_CATALOG`, `ERR_AMOUNT_OVERFLOW`.

## Where things live

`src/`, in pipeline order — load path first, then the quote path:

| File | Role |
|---|---|
| `csv.ts` | RFC 4180 tokenizer and the cell contract (numbers, dates, booleans, list/map escaping) |
| `rows.ts` | Column names, defaulting, per-row validation, product-identity agreement |
| `merge.ts` | Content-derived IDs; merges rows describing the same price |
| `validate.ts` | Load-time quantization to `baseUnitMinor`; adjustment/tax validation; the charm bound |
| `ambiguity.ts` | Proves no two prices compete, checks coverage gaps, builds the lookup index |
| `compile.ts` | Orchestrates the above; `loadCatalog` lives here |
| `resolve.ts` | Alias normalization, the four-probe specificity lattice, band selection |
| `quote.ts` | Line computation and the `Quotes` class |
| `money.ts` | Quantization, charm snapping, tax rounding |
| `constraints.ts` | The constraint grammar: parse at load, fixed-dispatch evaluation at quote time |
| `currency.ts`, `hash.ts`, `sha256.ts`, `errors.ts`, `types.ts` | Currency metadata, the catalog hash, typed errors, shared types |

`tests/` mirrors that split (`csv`, `constraints`, `compile`, `scenarios`, `money`, `cart`).
`docs/` is the CSV catalog playground served by `npm start`; `docs/price-quotes.js` is a build
artifact, regenerated by `npm run build` — do not hand-edit it.

## Development

```bash
npm test    # builds, then runs the test suite (node --test) against dist/
npm start   # builds, then serves docs/ (the CSV catalog playground) locally
```

`design-docs/clarity.md` tracks proposed API and structural changes that would make the library
harder to misuse.

## License

MIT
