# Addendum to design-v2: rename `subtotal`/`otherCharges`, add `extendedUnitPrice`

Status: implemented (see `progress.md`).

## Context

`LineQuote.subtotal` (`src/types.ts`) holds `salePrice * quantity` — the line total after unit-
level discounts/fees/charm, but *before* line-level fees/discounts (`otherCharges`) and tax. The
name `subtotal` doesn't signal that timing, so a reader could wrongly assume `subtotal + tax ===
total`. It also shares a name (though not a meaning) with the unrelated `line_subtotal`/
`cart_subtotal` constraint-grammar fields in `src/constraints.ts`, which are a pre-adjustment
`price * quantity` used for discount-eligibility rules, not a quote-output value.

`LineQuote.otherCharges` holds `feeLine - discountLine` — the net *line-basis* fee/discount
amount only (unit-basis fee/discount are itemized separately in `discounts`/`fees`). "Other
charges" doesn't say what it actually nets, and reads as though it could be positive-only, which
it isn't (a net line discount makes it negative).

There was also no field for `unitPrice * quantity` (the pre-discount/fee/charm "list" line
total), which is useful for showing customers what they'd pay before any discount.

The fix adopts `extended<X>` — a standard invoicing term for "price × quantity" — as a
consistent naming pattern: `extendedUnitPrice` and `extendedSalePrice` are now a matched pair
(pre- and post-discount line totals), and `otherCharges` becomes `netLineAdjustment`, which
states both that it's a net value and that it's line-scoped.

## Scope

- **`src/types.ts`**: `LineQuote.subtotal` → `extendedSalePrice` (with a doc comment clarifying
  it's computed before `netLineAdjustment`/tax); `LineQuote.otherCharges` → `netLineAdjustment`;
  new field `LineQuote.extendedUnitPrice: number` = `unitPrice * quantity`.
- **`src/quote.ts`**: new `const extendedUnitPrice = unitPrice * line.quantity;` computed
  alongside `unitPrice`; local `const subtotal` renamed to `extendedSalePrice`; local `const
  otherCharges` renamed to `netLineAdjustment`; `computeLine`'s return object updated to include
  all three.
- **`tests/money.test.js`**, **`tests/cart.test.js`**: assertions/comments referencing
  `subtotal` updated to `extendedSalePrice`; added an `extendedUnitPrice` reconciliation check.
- **`docs/index.html`**: the rendered "Subtotal" row now reads `line.extendedSalePrice`.
- **`README.md`**: field list and reconciliation prose updated.
- **`design-docs/design-v2-addendum-business-api.md`**: left as a frozen historical record (per
  its existing convention), with a "Follow-up" note added instead of editing its body.
- **`design-docs/design.md`** and **`design-docs/design-v2.md`**: intentionally not touched —
  both are superseded design snapshots (design-v2.md's field names were themselves superseded by
  `design-v2-addendum-business-api.md`), not living documentation of the current field names.

`src/constraints.ts`'s `line_subtotal`/`cart_subtotal` (a distinct constraint-grammar concept)
and `src/quote.ts`'s `line_subtotal` context key are unrelated and untouched.

No change to tax/discount/fee/markup computation — this is a rename plus one additive derived
field.

## Verification

1. `npx tsc --noEmit -p tsconfig.json` — clean typecheck.
2. `npm run build` — rebuilds `dist/` and `docs/price-quotes.js`.
3. `npm test` — full suite green.
4. `grep -rn '\bsubtotal\b\|otherCharges' src tests docs README.md design-docs` — only matches
   the unrelated `line_subtotal`/`cart_subtotal` constraint-grammar occurrences and the
   intentionally-frozen historical docs.
