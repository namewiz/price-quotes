# Addendum to design-v2: business-friendly output API

Status: implemented (see `progress.md`). This addendum supersedes the output
field names and shapes described in `design-v2.md` (`LineQuote`,
`AppliedAdjustment`, `AppliedTax`, `PeriodTotal`, `CartQuote`) without
changing the CSV catalog contract, the compiled catalog types (`Price`,
`Adjustment`, `AdjustmentKind`/`Type`/`Basis`), or any pricing math.

**Follow-up (post-implementation): `CartQuote.groups`/`PeriodTotal` removed.**
`groups` (lines rolled up by billing period) was confirmed to be a pure
presentation convenience — `amountDue` never needed it (`lines.reduce((s, l)
=> s + l.total, 0)` is equivalent to summing `groups[].total`), and nothing
else in the pricing pipeline read it. It was removed from `CartQuote` and
`PeriodTotal` was deleted from `src/types.ts`; the demo now buckets
`quote.lines` by `frequency`/`interval` client-side when it wants a
per-period sub-total row. Every table below that still mentions
`PeriodTotal` reflects the shape as originally implemented, before this
follow-up removal.

**Follow-up (post-implementation): `basePrice` renamed to `unitPrice`.** See
`design-docs/design-v2-addendum-unitprice-rename.md`. Every table below that
still says `basePrice` reflects the field's original name; the shipped API
now calls it `unitPrice`.

**Follow-up (post-implementation): `subtotal` renamed to `extendedSalePrice`,
`otherCharges` renamed to `netLineAdjustment`, new field `extendedUnitPrice`
added.** See `design-docs/design-v2-addendum-line-field-rename.md`. Every
table below that still says `subtotal`/`otherCharges` reflects the field's
original name; the shipped API now calls them `extendedSalePrice`/
`netLineAdjustment`, and also has an `extendedUnitPrice` field (`unitPrice *
quantity`) that didn't exist at the time this addendum was written.

## Context

`price-quotes` is a fresh (v0.1.0, no external consumers) TypeScript pricing
engine. Its public output types currently use implementation jargon —
integer-minor-unit fields suffixed `Minor` (`unitMinor`, `dueNowMinor`, ...)
and a catch-all `Adjustment`/`adjustments` concept that lumps discounts,
markups, and fees together, plus a tax/accounting split (`chargedMinor` vs
`addedMinor`) that leaks an internal nuance into the customer-facing quote.
The goal is for the *output* API (what a caller gets back from
`quotes.quote()` / `quoteCart()`) to read like an invoice a customer would
actually see — base price, sale price, subtotal, discounts, fees, tax,
total, amount due — while hiding two things that are the seller's business,
not the customer's: markup (folded into the price shown, never itemized)
and inclusive tax (already baked into the price, so it must not appear as
a line item the customer is being separately "charged"). Everything hidden
from the plain output should still be inspectable by developers/business
owners via an opt-in debug breakdown.

Decisions locked in during planning:
- **Rename scope**: JS/TS *output* types only. CSV column names
  (`adjustment_kind`, `adjustment_value`, ...) are the documented
  spreadsheet contract and stay as-is.
- **Discounts and fees become two separate arrays**, not one combined list.
- **Markup is applied first and never itemized** in the normal output — it
  changes what the base price *is*.
- **A tax line item only appears when the customer is actually being
  charged extra for it.** Inclusive (baked-in) tax must not show as a
  separate line in the normal output.
- **Add an opt-in `debug` breakdown** (only populated in debug mode) with
  the raw catalog cost price, the hidden markup, and the inclusive-tax
  amounts — for developers/business owners, not customers.

## Part 1 — Rename and reshape the output API

Scoped to **output/quote types only**. `Price`, `Adjustment`,
`AdjustmentKind/Type/Basis`, and `CatalogRowInput`'s `adjustment_*` columns
in `src/types.ts` are catalog/compile-time types and are **not renamed** —
a catalog row can still declare `adjustment_kind=markup`.

### New field mapping (`src/types.ts`)

| Old | New | Notes |
|---|---|---|
| `LineQuote.listUnitMinor` | `basePrice` | Catalog price **with markup already folded in**; pre-discount/fee, pre-charm. |
| `LineQuote.unitMinor` | `salePrice` | Final charged unit price (post discount/fee/charm). |
| `LineQuote.subtotalMinor` | `subtotal` | `salePrice * quantity`. |
| `LineQuote.adjustments` (`AppliedAdjustment[]`) | `discounts: AppliedCharge[]` + `fees: AppliedCharge[]` | Split by kind; markup-kind entries never appear here (see debug, below). |
| `LineQuote.lineAdjustmentsMinor` | `otherCharges` | Net line-basis fee minus discount amount (markup excluded, folded silently into totals — see debug). |
| `LineQuote.taxChargedMinor` + `taxAddedMinor` | `tax` (single field) | See "Tax visibility" below — the charged/added accounting split moves to `debug`. |
| `LineQuote.taxes` (`AppliedTax[]`) | `taxes: AppliedTax[]` (kept, reshaped) | **Filtered to only taxes that actually add to the bill** (exclusive behavior). Shape becomes `{ id, label, rate, amount }` — drop the `charged`/`added` distinction publicly. |
| `LineQuote.totalMinor` | `total` | |
| `AppliedAdjustment` (type) | `AppliedCharge` | Drop `kind` — the array it's in (`discounts`/`fees`/debug's `markup`) already says that. Fields: `id`, `label`, `amount`. |
| `PeriodTotal.subtotalMinor` | `subtotal` | |
| `PeriodTotal.adjustmentsMinor` | `otherCharges` | |
| `PeriodTotal.taxableMinor` | `taxable` | |
| `PeriodTotal.taxMinor` | `tax` | |
| `PeriodTotal.totalMinor` | `total` | |
| `CartQuote.dueNowMinor` | `amountDue` | |

The `Minor` suffix is dropped everywhere (values stay integer minor units —
documented once via JSDoc on `LineQuote`/`CartQuote`, not per-field).

### Tax visibility: exclusive shows, inclusive doesn't

A tax is "inclusive" when it's already baked into the sticker price (the
customer isn't charged anything extra for it) vs. "exclusive" when it's
added on top. Today both behaviors produce an `AppliedTax` entry; going
forward:

- The public `taxes: AppliedTax[]` list **only includes taxes where
  `behavior` resolves to exclusive** (i.e. the tax actually added to the
  bill). Inclusive taxes are computed as before internally but excluded
  from this list.
- `LineQuote.tax` = sum of amounts actually added to the bill (what today
  is `taxAddedMinor`) — this is what the customer needs to see, and it's
  already correct for inclusive tax (contributes 0, since nothing was added
  on top).
- The *liability* accounting (`taxChargedMinor` today — real tax owed,
  including the portion embedded in inclusive prices, needed for
  remittance/reporting) moves into `debug` only (see Part 1b).

### Markup: applied first, folded into `basePrice`, never itemized

Restructure `computeLine` (`src/quote.ts`) into two pricing stages instead
of one combined rate factor:

1. **Markup stage**: apply markup (rate + unit-amount, from
   `price.adjustments` filtered to `kind === "markup"`) to the raw catalog
   `price.baseUnitMinor`, quantize → this becomes `basePrice`. No charm at
   this stage (charm is sale-price psychology, not the sticker price).
   Line-basis markup is a flat per-line amount — carried forward as a
   hidden accumulator that still affects `total`/tax base, but is not part
   of `otherCharges` and is not itemized in `discounts`/`fees`.
2. **Discount/fee stage**: apply fee/discount rate and unit-amount
   adjustments on top of `basePrice` (not the raw catalog price), quantize,
   then charm → `salePrice`. `subtotal = salePrice * quantity`.
3. Line-basis fee/discount amounts → `otherCharges` (displayed). Taxable
   base = `subtotal + otherCharges + hiddenLineMarkup`.
4. Build `discounts`/`fees` the same way `appliedAdjustments` is built
   today (per-entry informational dollar amount), filtered by kind; markup
   entries are routed to `debug.markup` instead (see below).

Reuse the existing `combineKind` helper (`src/quote.ts:24`) per stage — no
need to rewrite it.

### Part 1b — Opt-in `debug` breakdown

New `QuotesOptions.debug?: boolean` (default `false`), alongside the
existing `defaultTaxBehavior`/`normalizeSku` options. When `true`, every
`LineQuote` gets a populated `debug` field; when `false` (default),
`debug` is `undefined` so the plain-output shape stays exactly the invoice
shape above.

```ts
interface LineQuoteDebug {
  costPrice: number;            // price.baseUnitMinor — raw catalog price, pre-markup
  markup: AppliedCharge[];      // itemized markup entries (the "hidden" business margin)
  basePrice: number;            // same value as the public basePrice, repeated for a one-glance view
  inclusiveTaxes: AppliedTax[]; // taxes baked into the price, with their extracted amount
  taxLiability: number;         // total real tax owed (exclusive + inclusive-extracted) — today's taxChargedMinor
}

interface LineQuote {
  // ...invoice fields above...
  debug?: LineQuoteDebug;
}
```

### Consumers to update

- `docs/index.html` (~lines 453-468): render `basePrice` as "Unit price",
  loop `line.discounts` and `line.fees` as two separate row groups, show
  `salePrice` only when it differs from `basePrice`, show `line.taxes`
  (now pre-filtered to exclusive-only) as before, rename
  `subtotal`/`amountDue` accordingly. Add a "Show debug breakdown" toggle
  that constructs `new Quotes(config, { debug: true })` and renders
  `line.debug` (cost price, hidden markup, inclusive tax, tax liability) in
  a collapsible section — this is exactly the "help developers/business
  owners understand the final rendered quote" audience the feature is for.
- `README.md`: update the quick-start snippet's field references and add a
  short "Debug breakdown" subsection documenting `{ debug: true }`.
- Tests (`tests/cart.test.js`, `tests/compile.test.js`,
  `tests/constraints.test.js`, `tests/money.test.js`,
  `tests/scenarios.test.js`): rename field accesses; split `.adjustments`
  assertions into `.discounts`/`.fees`; add cases for:
  - markup folded into `basePrice`, absent from `discounts`/`fees`, present
    in `debug.markup` only when `debug: true`.
  - inclusive tax absent from `taxes`, present in `debug.inclusiveTaxes`;
    `debug` is `undefined` when the option isn't set.
  - `total`/`amountDue` math is unchanged by all of the above (pure
    presentation change, not a pricing change).
- `docs/price-quotes.js` is a generated build artifact — do not hand-edit,
  regenerated by `npm run build`.

## Part 2 — Trim design-doc pointer comments

In `src/constraints.ts:2`, `compile.ts:1`, `csv.ts:1`, `types.ts:1`,
`types.ts:100`, `money.ts:2`, `quote.ts:1-2`, `resolve.ts:2`,
`ambiguity.ts:2`: single-line "See design-docs/design-v2.md, 'Section'"
pointers with no other content. Trim each to just the descriptive first
clause, e.g. `// The CSV contract.` instead of `// The CSV contract. See
design-docs/design-v2.md, "The CSV contract".`

`tests/scenarios.test.js:6`: same treatment (plain section pointer).

Keep, but reword to be self-contained (describe the actual reasoning
directly, not "per the design doc"):
- `tests/scenarios.test.js:188-189` (Adversarial-7 containment-vs-prose
  discrepancy).
- `tests/money.test.js:40-41` (NGN exponent note).

`README.md`'s link to `design-docs/design-v2.md` stays. `progress.md` gets
a short new entry noting this follow-up rename/reshape pass, and that
`design-docs/design-v2.md` (historical spec) now describes older field
names/behavior than the shipped API.

## Verification

1. `npx tsc --noEmit -p tsconfig.json` — clean typecheck.
2. `npm run build` — esbuild + `postbuild` regenerate `dist/` and
   `docs/price-quotes.js` without errors.
3. `npm test` — full suite green after the field renames, the discount/fee
   split, the tax-visibility filter, and the new debug-mode tests.
4. Manually re-check the worked example still holds under the new names:
   $12.34 base (no markup in that catalog), 10% discount, qty 3 →
   `salePrice` $10.99, `subtotal` $32.97, via a quick Node smoke script
   against `dist/index.js`.
5. Add a small smoke case with markup + an inclusive tax (e.g. catalog cost
   $10, 20% markup, 10% inclusive tax) and confirm: `basePrice` reflects
   the marked-up price, `taxes` is empty (inclusive, nothing added),
   `debug` (when enabled) shows `costPrice: $10`, `markup` itemized, and
   `inclusiveTaxes` itemized.
6. `npm start` (serve `docs/`) and confirm the demo renders `basePrice`,
   separate discount/fee rows, `amountDue`, and the debug toggle correctly
   for the default preset — flag if no headless-browser tooling is
   available in this environment (same caveat as the original build).
