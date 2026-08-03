# Proposal: reshape `LineQuote` by scope

**Status:** proposed, not implemented. Once implemented, fold this into
[`design.md`](./design.md)'s "The public API" section and delete this file — the point is one
living design doc, not a chain of addendums.

**Scope:** the output types only (`LineQuote`, `LineQuoteDebug`). No change to the CSV contract,
the compiled catalog types, or the pricing math — with one deliberate exception, the markup basis
rule in §3, which is required for the invariants to hold.

Supersedes items 2.1–2.4 of [`clarity.md`](./clarity.md), and resolves 3.4 as a side effect.

---

## 1. The problem

`LineQuote` exposes nine same-typed `number` fields with synonym-adjacent names — `unitPrice`,
`extendedUnitPrice`, `salePrice`, `extendedSalePrice`, `netLineAdjustment`, `tax`, `total`, plus
`CartQuote.amountDue` and `AppliedCharge.amount`. They are mutually assignable, so nothing catches
a substitution:

```ts
renderInvoiceTotal(line.extendedSalePrice);  // meant total; compiles, silently wrong
```

Three specific traps sit inside that:

- **`extendedSalePrice + tax !== total`.** The names invite exactly that arithmetic, and it is
  wrong whenever a line-basis coupon is present. `src/types.ts` carries a four-line comment
  warning about it — the tell that a name promises what the arithmetic doesn't honor.
- **`tax` (number) and `taxes` (array)** differ by one character and by type. A singular/plural
  near-miss where both are valid is its own misuse vector.
- **`netLineAdjustment` is the odd field out three ways**: the only signed field among unsigned
  ones, the only line-scoped one among unit-derived ones, and the only one that nets two things
  the API elsewhere insists on itemizing separately (`discounts` and `fees` are two arrays
  precisely because lumping them was judged confusing).

And one defect found while designing this, not previously recorded — see §3.

## 2. The target shape

```ts
interface LineQuote {
  // identity — unchanged
  ref?: string; sku: string; priceId: string; quantity: number;
  variant: string | null; country: string | null; currency: string;
  frequency: Frequency; interval?: FrequencyInterval;

  unit:     { list: number; sale: number };   // per-unit amounts
  extended: { list: number; sale: number };   // × quantity

  adjustments: {
    discounts: AppliedCharge[];      // unit-basis, valued against unit.list
    fees:      AppliedCharge[];      // unit-basis
    lineDiscounts: AppliedCharge[];  // line-basis
    lineFees:      AppliedCharge[];  // line-basis
    lineNet:   number;               // sum(lineFees) − sum(lineDiscounts); signed
  };

  tax: {
    base:    number;                 // the amount tax was computed on
    amount:  number;                 // total added to the bill; 0 when all applicable tax is inclusive
    charges: AppliedTax[];           // only taxes that add to the bill
  };

  total: number;
  debug?: LineQuoteDebug;
}

interface LineQuoteDebug {
  cost: number;                                         // raw catalog price, before markup
  markup: AppliedCharge[];                              // folded into unit.list, never itemized publicly
  tax: { inclusive: AppliedTax[]; liability: number };  // mirrors the public tax object
}
```

### The invariant chain

This is the central argument for the shape. Every relationship becomes a two-term sum between
**adjacent** fields, and each holds exactly:

```
extended.list === unit.list × quantity
extended.sale === unit.sale × quantity
tax.base      === extended.sale + adjustments.lineNet
total         === tax.base + tax.amount
```

There is no longer any pair of neighbouring fields whose obvious combination is wrong. Compare
today, where the reader must know that `netLineAdjustment` sits between `extendedSalePrice` and
tax, and that a fourth term they cannot see sits between those (§3).

Invariant 3 holds **only because** of the markup rule in §3. That dependency is why the rule is in
scope here rather than deferred.

Verified against `dist/` under the current code, using `total − tax` as a stand-in for the
not-yet-exposed `tax.base`:

| Catalog | `tax.base` | `extended.sale + lineNet` | |
|---|---|---|---|
| plain, qty 3 | 3000 | 3000 | ✓ |
| line-basis discount, qty 2 | 1800 | 1800 | ✓ |
| line-basis fee + 7.5% exclusive tax, qty 4 | 4150 | 4150 | ✓ |
| unit-basis markup + inclusive tax, qty 2 | 2400 | 2400 | ✓ |

## 3. Required behavior change: markup is always unit-basis

**The defect.** Line-basis markup adds to `total` with no public field explaining it:

```
markup,amount,line,2.00 on a 2-unit $10 line
  extendedSalePrice 2000, netLineAdjustment 0, tax 0, total 2200   ← 200 unexplained
```

`README.md` and `design.md` both state `total = extendedSalePrice + netLineAdjustment + tax`,
which is false here. Because `adjustment_basis` defaults to `line`, this is the *default* path
for an amount markup, not an edge case. The engine carries it as a hidden accumulator
(`markupAmountLine`, `src/quote.ts:99`) that reaches the tax base and the total but no output
field.

**The resolution.** `adjustment_basis` has no meaning for markup. Markup is defined as the thing
that is *baked into the unit price and visible only in `debug`* — a per-line markup cannot be
baked into a per-unit price without dividing by quantity, which would break integer exactness.
So:

- A markup row with a blank `adjustment_basis` resolves to `unit`, not the global `line` default.
- An explicit `adjustment_basis: line` on a markup row is a load error — proposed code
  `ERR_MARKUP_BASIS`, with a message pointing at `fee` for a genuine per-line charge.

The hidden accumulator then disappears entirely, and invariant 3 holds unconditionally. Confirmed:
the same catalog authored with `basis=unit` gives `unitPrice` 1200, `total` 2400, and every
relationship reconciles.

**Migration cost, stated plainly:** a seller who today writes `markup,amount,2.00` gets $2 on the
line; afterwards they get $2 per unit. The explicit-`line` load error is what makes this loud
rather than silent, but a blank-basis row changes meaning without erroring. Worth a release note.

## 4. Naming rationale

- **`unit` / `extended`** — scope becomes structural rather than a prefix convention.
  `unit.sale` cannot be autocompleted into `extended.sale` the way `salePrice` and
  `extendedSalePrice` can, which is the single most likely machine-misuse failure in this API.
- **`list` / `sale`** — the standard retail pair. `list` is the pre-deal price, `sale` what is
  actually charged.
- **`tax.base`** — "tax base" is the accounting term of art, and it anchors the final invariant.
  Exposing it is what makes `total` reconcilable at all; the engine already computes it
  (`taxableMinor`, `src/quote.ts:121`) and simply doesn't return it.
- **`tax.amount` / `tax.charges`** — the scalar and the array now sit under distinct names inside
  one object, so the `tax`/`taxes` near-miss is designed out rather than documented around.
- **`adjustments.lineNet`** — `line` states the scope, `Net` states that it is signed and that it
  nets two things. It remains derivable from `lineFees`/`lineDiscounts`, so it is a convenience
  view, not the only one.
- **`debug.cost`** — the `Price` suffix is redundant inside `debug`. `debug.unitPrice` is dropped
  outright: a field documented as always equal to another field invites the reader to wonder when
  it isn't, and invites a future change to make them differ.
- **`CartQuote.amountDue` is unchanged** — already unambiguous, and renaming it to `total` would
  reintroduce exactly the confusion this reshape removes.

## 5. Migration table

| Today | Proposed | Note |
|---|---|---|
| `unitPrice` | `unit.list` | |
| `salePrice` | `unit.sale` | |
| `extendedUnitPrice` | `extended.list` | |
| `extendedSalePrice` | `extended.sale` | |
| `discounts` | `adjustments.discounts` | **now unit-basis only** — see below |
| `fees` | `adjustments.fees` | **now unit-basis only** |
| — | `adjustments.lineDiscounts` | new |
| — | `adjustments.lineFees` | new |
| `netLineAdjustment` | `adjustments.lineNet` | |
| `taxes` | `tax.charges` | |
| `tax` | `tax.amount` | |
| — | `tax.base` | new; already computed internally |
| `total` | `total` | unchanged |
| `debug.costPrice` | `debug.cost` | |
| `debug.markup` | `debug.markup` | unchanged |
| `debug.unitPrice` | — | removed |
| `debug.inclusiveTaxes` | `debug.tax.inclusive` | |
| `debug.taxLiability` | `debug.tax.liability` | |

**On `discounts`/`fees` becoming unit-basis only:** today both arrays are built from
`eligibleAdjustments` filtered by kind alone (`src/quote.ts:123-127`), so they contain line-basis
entries too — whose `amount` is *not* multiplied by quantity, unlike their unit-basis neighbours.
One array, two meanings, no discriminator. Splitting by basis gives each array exactly one
meaning, which is what `clarity.md` item 3.4 asked for; the `basis` discriminator it proposed is
then unnecessary.

## 6. What this does and doesn't resolve

Resolved: `clarity.md` **2.1** (interchangeable numbers — by scope nesting rather than brands),
**2.2** (`extendedSalePrice + tax !== total` — by exposing `tax.base`), **2.3**
(`netLineAdjustment`'s three asymmetries — by nesting *and* itemizing line-basis charges),
**2.4** (duplicated `debug.unitPrice`), **3.4** (`AppliedCharge.amount`'s three meanings), and the
line-basis markup defect in §3.

Not resolved, deliberately:

- **Unit confusion.** Nesting prevents *scope* confusion (unit vs line) but not *unit* confusion —
  nothing still stops a caller passing minor units where major are expected. Branded types
  (`clarity.md` 2.1) would; nesting is chosen over them because it also documents the pipeline,
  and the two are not mutually exclusive if brands are wanted later.
- **Finding 1.3** — itemized charges not summing to the reduction they explain. It shares these
  fields but is a harder problem with catalog-schema implications; see `clarity.md`.

## 7. Implementation sketch

`computeLine` (`src/quote.ts:44-174`) already computes every value in the target shape;
`taxableMinor` (line 121) *is* `tax.base`. The work:

1. Delete the `markupAmountLine` accumulator; route amount markups through the unit-basis path.
2. Default markup basis to `unit` (`src/rows.ts:339`) and reject explicit
   `adjustment_basis: line` on markup rows (`src/validate.ts`), adding `ERR_MARKUP_BASIS` to
   `LoadErrorCode` (`src/errors.ts`).
3. Split `discountAdjustments`/`feeAdjustments` by basis before calling the existing
   `toAppliedCharges` helper (`src/quote.ts:40`) — four arrays instead of two.
4. Assemble the nested return object; drop the `debug.unitPrice` echo.

Consumers to update: `docs/index.html` (render template), `tests/*.test.js` (field accesses and
the reconciliation assertions), `README.md`'s `LineQuote` table, and `design.md`'s "The public
API" section — at which point this file is folded in and deleted.

Verification, beyond the existing 97 tests passing: assert all four invariants as properties
across generated carts, including the line-basis-markup case that fails today; and confirm
`ERR_MARKUP_BASIS` fires for an explicit `markup` + `basis: line` row.
