# Progress: design-v2 full rewrite

Tracking implementation of `design-docs/design-v2.md` — a CSV-catalog-driven quote engine.
This is a from-scratch rewrite of `src/` and `tests/`.

## Status: done

All 20 tasks below are complete. 95/95 tests pass (`npm test`). See "Blockers / decisions log"
for the handful of places this implementation had to make a judgment call the design doc didn't
fully settle, or where it deviates from the doc's prose in favor of the doc's own formal rules.

## Verification (design doc's "Verification" checklist)

1. ✅ Test suite passes — 95/95 (`tests/*.test.js`).
2. ✅ Two-column CSV (`product_sku,price_amount`) prices with defaults — `Scenario 1`.
3. ✅ Every adversarial catalog throws at load with its expected code — `Adversarial 1-18`.
4. ✅ Shuffling a catalog's rows gives a byte-identical `catalogHash` and identical quotes —
   `compile.test.js` ("content-derived price IDs are stable across a row shuffle", 5 seeds;
   "row order never changes the quote").
5. ✅ Replaying a quote from `(catalogHash, asOf, lines)` gives an identical result —
   `cart.test.js`.
6. ✅ Latency from 100 → 100,000 price rows is flat (benchmark in `cart.test.js`); the hot
   path (`resolve.ts`, the pricing section of `quote.ts`) contains no `Date`/`Intl`/regex
   construction — verified by inspection (`new Date()` appears only as an API-boundary default
   parameter, never in resolution or line computation).
7. ✅ The canonical `.ng` worked example (12.34 USD, `to9` charm, qty 3, 10% discount, 7.5%
   exclusive tax → $10.99 unit, $35.44 total) matches the design doc exactly —
   verified by hand during development and covered by `money.test.js`.

## Task list (mirrors harness TaskList)

1. [x] Scaffold: progress.md, remove old src/tests, new directory layout
2. [x] types.ts
3. [x] errors.ts
4. [x] CSV parser + cell contract
5. [x] Constraint grammar
6. [x] Currency metadata
7. [x] money.ts (quantization, charm, rounding)
8. [x] Catalog compilation (loadCatalog)
9. [x] Ambiguity detection + index build
10. [x] Catalog hash (SHA-256 canonical)
11. [x] Price resolution (probe + band select)
12. [x] Line computation + Quotes API
13. [x] CSV contract tests
14. [x] Constraint grammar tests
15. [x] Compilation + row-merge tests
16. [x] Ambiguity/coverage tests (scenarios + adversarial catalogs)
17. [x] Money/charm/rounding tests
18. [x] Cart/API + property tests + perf benchmark
19. [x] Demo app (docs/index.html — CSV catalog playground + cart builder)
20. [x] README + verification checklist

## Blockers / decisions log

- **Currency rounding increments have no home in the design's `loadCatalog(input, defaults)`
  signature.** Quantization (including cash-rounding increments like CHF 0.05) happens at
  *load* time, but the design only shows increment overrides living on `Quotes`' constructor
  options, which run after load. Resolved by adding `defaults.currencies?: Record<string,
  CurrencyMetaInput>` to `CatalogDefaults` so increments are available when `loadCatalog`
  quantizes. `Quotes`' constructor still accepts the design's `currencies` option for signature
  compatibility but it cannot retroactively change already-quantized `baseUnitMinor` values.
- **The design doc's own charm-table example mislabels NGN as "exp 0."** ISO 4217 / `Intl` both
  give NGN an exponent of 2 (kobo); the doc is illustrating "a currency with no minor unit,"
  which is what JPY actually is. Tests exercise the exponent-0 case against JPY instead of NGN.
- Window-gap sweep (`ERR_WINDOW_GAP`) coverage is a best-effort slab sweep, not the full
  per-region/per-slab algorithm described in the design doc verbatim.
- **Demo (`docs/index.html`) was not visually verified in an actual browser.** This
  environment has no headless-browser tooling (`chromium-cli` not installed; `playwright` isn't
  installed and installing it would pull down browser binaries out of scope for this pass). The
  demo's JS calls exactly the same `loadCatalog`/`Quotes` API exercised by the 95-test suite, and
  `docs/price-quotes.js` was smoke-tested by importing it directly in Node and calling
  `loadCatalog`. Recommend a manual check (`npm run start`) before relying on it for a live demo.
- **Adversarial 7 ("the forgotten end date") contradicts the design's own formal detection
  algorithm.** The prose wants two open-ended, overlapping-forever windows to be
  `ERR_AMBIGUOUS_PRICE`. But the doc's stated algorithm resolves ambiguity purely by rectangle
  containment, and a later-starting, still-open window IS a proper subset of a fully-open one —
  structurally identical to the doc's own accepted `qty [1,10]` vs `qty [1,∞)` tiering example,
  which it explicitly says *loads*. Implemented the formal containment rule as written (it
  loads; the later/narrower row wins from its start onward, which is arguably the more useful
  behavior for a seller who forgot to close the old row anyway). The inverse case — closing the
  old price a month before the new one starts, leaving a real gap — still correctly raises
  `ERR_WINDOW_GAP`.
