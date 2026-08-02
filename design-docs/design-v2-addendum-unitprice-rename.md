# Addendum to design-v2: rename `basePrice` to `unitPrice`

Status: implemented (see `progress.md`).

## Context

`LineQuote.basePrice` and `LineQuoteDebug.basePrice` (`src/types.ts`) hold the catalog price
with any markup folded in, before discounts/fees/charm. The name `basePrice` reads as "the
underlying/raw price," which is ambiguous next to `LineQuoteDebug.costPrice` (the truly raw
catalog price before markup). It should be renamed to `unitPrice` to better reflect what it
actually is: the regular per-unit price a customer would see before any discount/fee/charm is
applied. This is a pure rename — no computation, validation, or CSV contract changes.

## Scope

Every occurrence of the identifier `basePrice` across the repo (confirmed via `grep -rn
basePrice src tests docs README.md design-docs/design-v2-addendum-business-api.md progress.md`):

- **`src/types.ts`**: `LineQuote.basePrice` (~line 271) and `LineQuoteDebug.basePrice` (~line
  253), plus 3 JSDoc comment mentions.
- **`src/quote.ts`**: the local `const basePrice = ...` (stage-1 markup result, ~line 97) and
  every use of that variable (stage-2 discount/fee base, `toAppliedCharges` calls, the
  `debugInfo` object, the `computeLine` return statement) — rename the variable too, so it reads
  consistently with the field it populates.
- **`tests/money.test.js`**: `r.basePrice`/`plain.basePrice`/`withDebug.debug.basePrice`
  assertions (2 tests) and their comments.
- **`docs/index.html`**: `line.basePrice` in the render template (2 uses) and 2 comments in the
  new realistic presets.
- **Docs** (`README.md`, `design-docs/design-v2-addendum-business-api.md`, `progress.md`):
  prose/code-sample mentions of `basePrice` — update for consistency, since these documents are
  the current source of truth for the shipped API shape.

No change to `LineQuoteDebug.costPrice`, `salePrice`, `markup`, or any pricing math — this is a
find-and-rename, not a behavior change.

## Verification

1. `npx tsc --noEmit -p tsconfig.json` — clean typecheck.
2. `npm run build` — rebuilds `dist/` and `docs/price-quotes.js`.
3. `npm test` — full suite green.
4. `grep -rn basePrice src tests docs README.md design-docs progress.md` returns nothing.
5. Quick smoke script against `dist/index.js` (reuse the addendum's worked example) confirming
   `r.unitPrice` carries the value `basePrice` used to.
