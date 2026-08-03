# Clarity: making the API harder to misuse

Proposals for naming, API shape, and code organization that would make `price-quotes` harder to
get wrong — by a person reading it for the first time, by a person returning to it after a year,
and by a language model writing code against it.

Nothing here is implemented. Each item states the current shape, the misuse it invites, and what
to do about it. Ordered by consequence: the first section is defects found while reading, where
better structure would have prevented the bug outright; the rest are changes that lower the
chance of the next one.

The organizing idea throughout: **this library's entire value proposition is that wrong answers
are impossible rather than merely unlikely.** Every place the *output* API falls short of the
rigor the *input* validation applies is a place that promise leaks.

---

## 1. Defects that clarity would have prevented

These are real, verified against `dist/`. They are listed here rather than filed as bugs because
each one traces to a structural weakness the rest of this document proposes fixing.

### 1.1 The catalog hash ignores tax and adjustment values when IDs are authored

`computeCatalogHash` serializes each price as its price key, `baseUnitMinor`, and the **IDs** of
its taxes and adjustments (`src/hash.ts:26-35`). For *derived* IDs this is sound, because the ID
encodes the fields. For **author-supplied** `price_id` / `tax_id` / `adjustment_id` it is not:

```
product_sku,price_id,price_amount,adjustment_id,adjustment_kind,adjustment_type,adjustment_value
.ng,P1,10.00,A1,discount,rate,0.10        →  hash H
.ng,P1,10.00,A1,discount,rate,0.20        →  hash H   (identical)
```

Changing a discount from 10% to 20%, or a tax from `inclusive` to `exclusive`, leaves the hash
unchanged. Since the hash exists so a stored quote can be replayed and verified against its
catalog, this silently breaks the guarantee for exactly the catalogs most likely to have durable
external keys.

`serializeTax` and `serializeAdjustment` are **already written** in that same file
(`src/hash.ts:18-24`), complete and correct — and never called. The fix is to serialize the
entities rather than their IDs.

**Why clarity would have caught it:** two functions sitting unreferenced in a 49-line file is a
signal. Nothing in the build surfaces it — `noUnusedLocals` is not enabled in `tsconfig.json`.

### 1.2 An exclusive tax that rounds to zero is reported as inclusive

The inclusive/exclusive split keys on the computed amount rather than on the resolved behavior:

```ts
// src/quote.ts:149
if (added > 0) taxes.push(...); else inclusiveTaxes.push(...);
```

A 0.1% exclusive tax on a $0.01 item rounds to `0`, so it lands in `debug.inclusiveTaxes` —
described in the types as "taxes baked into the price (never added to the bill)", which it is
not. Verified. The condition should be `behavior === "inclusive"`, with the zero-amount case
handled on its own terms (include it in `taxes` with `amount: 0`, or drop it, but decide
deliberately).

**Why clarity would have caught it:** the branch tests a *proxy* for the property it means. The
resolved `behavior` is in scope on the line above.

### 1.3 Itemized discounts do not reconcile with the price they explain

Rate adjustments combine on one shared base and quantize **once** — that is the whole point of
the design's order-independence argument. But `AppliedCharge.amount` is computed per entry, each
rounded separately (`src/quote.ts:35-38`). The two disagree:

```
base 1005 minor, three stackable 5% discounts
  unitPrice 1005 → salePrice 854          (actual reduction: 151)
  discounts: [50, 50, 50]                 (itemized sum: 150)
```

Verified. On an invoice-shaped output this is the classic "the line items don't add up"
complaint, and the design doc claims the opposite invariant ("displayed components always sum to
the displayed total"). The fix is either to distribute the rounding residue across the itemized
entries (largest-remainder), or to document `AppliedCharge.amount` as explicitly *indicative* and
name it accordingly — but not to leave a field that looks like an invoice line and isn't one.

### 1.4 `config.products.find(...)` is a linear scan inside the O(1) path

```ts
// src/quote.ts:66
const product = config.products.find((p) => p.sku === sku);
```

This runs per line, on every quote, to check `status === "inactive"`. `buildIndex` already
receives a `Map<string, Product>` (`src/ambiguity.ts:162`) and `loadCatalog` already builds one
(`src/compile.ts:73`) — it just isn't kept on `CatalogConfig`. The flat-latency benchmark does not
catch this because it varies price-row count, not product count.

The check is also redundant: `buildIndex` already excludes inactive products' prices from the
index, so resolution would fail anyway — but with `ERR_NO_PRICE` instead of the intended
`ERR_UNKNOWN_SKU`. Retaining `productsBySku` on `CatalogConfig` fixes the cost and makes the
intent explicit.

### 1.5 Dead code that reads as intent

- `isNumericField` (`src/constraints.ts:23-26`) is never called, and its body is
  `return !KNOWN_FIELDS.has(field) && false` — a dead conjunct that reads as an unfinished
  thought. Callers use `NUMERIC_FIELDS.has(...)` directly.
- `serializeTax` / `serializeAdjustment` — see 1.1.
- `getNumberFormatter` (`src/currency.ts:44`) is exported, cached, commented as performance-
  critical, and referenced nowhere.
- `Money` and `Quantity` (`src/types.ts:4-7`) are exported type aliases documented as
  "validated at construction sites" — used by no interface in the codebase.

Each of these tells a reader something untrue about the system. Turning on `noUnusedLocals` and
`noUnusedParameters` in `tsconfig.json` catches the first three at build time.

---

## 2. The type system should carry the units and the roles

### 2.1 Eight interchangeable `number`s

`LineQuote` exposes `unitPrice`, `extendedUnitPrice`, `salePrice`, `extendedSalePrice`,
`netLineAdjustment`, `tax`, `total` — plus `CartQuote.amountDue` and `AppliedCharge.amount` — all
bare `number`, all in the same unit, all mutually assignable. Nothing catches:

```ts
renderInvoiceTotal(line.extendedSalePrice);   // meant total; compiles, silently wrong
formatPrice(line.total, quantity);            // per-unit function, line-level value
```

This is the single largest correctness gap in the output API, and the one most likely to be hit
by a model generating code: the field names are close synonyms drawn from a domain (invoicing)
where they are *not* synonyms.

**Proposal — branded types.** The aliases already exist; give them a brand and wire them up:

```ts
declare const MinorUnits: unique symbol;
export type Money = number & { readonly [MinorUnits]: true };
export type Quantity = number & { readonly [MinorUnits]: "qty" };
```

This costs a construction site (`toMoney(n)`) inside the engine and nothing at all for consumers
reading fields off a result. It does not distinguish *unit* money from *line* money, which is the
actual confusion above — for that, see 2.2.

**Proposal — or nest by scope**, which solves the same problem without brands and is arguably
clearer to a reader:

```ts
interface LineQuote {
  unit: { list: number; sale: number };          // per-unit amounts
  extended: { list: number; sale: number };      // × quantity
  adjustments: { discounts: AppliedCharge[]; fees: AppliedCharge[]; netLine: number };
  taxes: AppliedTax[];
  tax: number;
  total: number;
}
```

`line.unit.sale` cannot be mistaken for `line.extended.sale` by autocomplete the way `salePrice`
and `extendedSalePrice` can, and the grouping states the scope rule the flat shape only implies.
The cost is a breaking change and slightly longer access paths. At v0.1.0 with no external
consumers, this is the cheapest it will ever be.

### 2.2 `extendedSalePrice + tax !== total` is a trap the names set

The doc has to say this explicitly, twice, and `src/types.ts:276-280` carries a four-line comment
warning about it. That is the tell: the names promise a relationship the arithmetic doesn't
honor, because `netLineAdjustment` lands between them.

Anyone — human or model — reasoning from the names will write `extendedSalePrice + tax` and get a
wrong number whenever a line-basis coupon is present. Options, in order of preference:

1. **Add the missing intermediate**: `taxableAmount` (= `extendedSalePrice + netLineAdjustment +
   hidden line markup`, which the engine already computes as `taxableMinor`,
   `src/quote.ts:121`). Then `taxableAmount + tax === total` holds exactly, and every adjacent
   pair of fields reconciles. This is the smallest change with the largest payoff, and it also
   surfaces the tax base, which is currently invisible to callers.
2. Rename `extendedSalePrice` to something that does not read as a subtotal.
3. Leave it, and accept that the doc comment is load-bearing.

### 2.3 `netLineAdjustment` is the odd field out three ways

It is the only signed field among unsigned ones, the only line-scoped one among unit-derived
ones, and the only one that nets two things the API elsewhere insists on itemizing separately
(`discounts` and `fees` are two arrays precisely because lumping them was judged confusing).

The asymmetry has a real cause — line-basis amounts can't be pushed onto a unit without breaking
integer exactness — but the output shape shouldn't make the caller infer that. Either itemize it
the way its unit-basis counterparts are itemized (`lineDiscounts: AppliedCharge[]`,
`lineFees: AppliedCharge[]`), or fold it into the nested shape in 2.1 where its scope is
structural. If it stays as-is, the sign convention belongs in the field name
(`netLineFeeMinusDiscount`) rather than only in a doc comment.

### 2.4 `debug.unitPrice` duplicates the public field

`LineQuoteDebug.unitPrice` is documented as "same value as the public `unitPrice`, repeated here
for a one-glance view" (`src/types.ts:252`). A field that is *documented* as always equal to
another field invites the reader to wonder when it isn't — and invites a future change to make
them differ. Drop it; a caller reading `debug` has the `LineQuote` in hand. If the grouping is
genuinely wanted, make `debug` a self-contained pricing trace
(`costPrice → markup → unitPrice → discounts/fees → salePrice`) rather than a partial echo.

---

## 3. API surface: remove the sharp edges

### 3.1 `quote()` silently discards `context`

```ts
// src/quote.ts:183-187
quote(line, currency, asOf = new Date()) {
  return computeLine(this.config, line, currency, asOf.getTime(), {}, ...);
  //                                                              ^^ context
}
```

There is no way to pass `context` through the single-line API. Any adjustment gated on a context
key (`customer_tier=!=free`) silently never applies — the constraint fails rather than throwing,
by design, so the discount just quietly doesn't happen. A caller told by the README to "call
`quote()` per line for best-effort behavior" gets *different prices* than `quoteCart` would give.

This is a trap with no warning attached, and the kind a model will walk into with confidence.
Fix by taking the same shape as the cart API:

```ts
quote(line: CartLine, request: Omit<CartRequest, "lines">): LineQuote
```

which also removes the positional-`currency` inconsistency between the two methods.

### 3.2 Columns that parse but do nothing

Every one of these accepts a value, validates it, and then has no effect. A seller has no way to
discover that — and the whole design rests on "the catalog never silently ignores what you
typed."

| Column | Status |
|---|---|
| `adjustment_start` / `adjustment_end` | Parsed to epoch ms on `ResolvedRow` (`src/rows.ts:341-342`), never consulted. **A time-boxed discount never expires.** The most dangerous of the four. |
| `currency_separator` | In `KNOWN_COLUMNS`, never reaches `ResolvedRow` at all |
| `currency_symbol` | Reaches `ResolvedRow`, dropped at merge |
| `locale` | Reaches `ResolvedRow`, dropped at merge |

Three options per column, and each should get one deliberately: implement it, remove it from
`KNOWN_COLUMNS` so it errors as unknown, or keep it and emit a load-time issue saying it is
accepted-but-inert. Silently accepting it is the only choice inconsistent with the rest of the
design.

`adjustment_start`/`adjustment_end` in particular should either be enforced at resolution or
removed — a seller who ends a promotion by setting `adjustment_end` and watches it keep applying
has been failed by exactly the guarantee this library sells.

### 3.3 `priceId` is not unique

`derivePriceId` (`src/merge.ts:79-84`) omits `country_code`, though the price *key* includes it.
So a wildcard-country price and a `NG` price for the same SKU compile to two distinct `Price`
objects with an identical `id` — and, since tax and adjustment IDs derive from the price ID,
identical adjustment IDs too. Verified:

```
[ { id: '.ng:USD:*:1::one-time:', country: null },
  { id: '.ng:USD:*:1::one-time:', country: 'NG'  } ]
```

`LineQuote.priceId` therefore cannot be used to look a price back up, which is the only reason to
expose it. Add the country to the derivation (a hash change, so a deliberate one), or document
`priceId` as non-unique — but it should not look like a key while not being one.

### 3.4 `AppliedCharge.amount` means three different things

`chargeAmount` (`src/quote.ts:35-38`) returns, depending on the adjustment: a flat line amount, a
unit amount × quantity, or a rate applied to a base × quantity. Same field, three semantics, no
discriminator — and `AppliedCharge` deliberately dropped its `kind` field on the grounds that
"the array it's in already says that." The array says *discount vs fee*; it does not say
*per-unit vs per-line*, which is what the reader needs to interpret the number.

Restore a `basis: "unit" | "line"` discriminator, or split the arrays by basis. See also 1.3,
which is the same field failing to reconcile.

---

## 4. Structure

### 4.1 `computeLine` is a 130-line function holding five concerns

`src/quote.ts:44-174` performs quantity validation, SKU normalization, product lookup, currency
check, price resolution, constraint evaluation, markup, discount/fee, charm, line adjustments,
tax accumulation, debug assembly, and result construction. The design doc presents this as a
clean four-stage pipeline; the code presents it as one straight line with 25 intermediate
`const`s in a single scope, where nothing prevents stage 2 from reading a stage-3 variable.

Extract the stages the doc already names, so the call stack and the documentation agree:

```ts
function resolveLine(config, line, currency, asOf): ResolvedLine
function applyMarkup(price, adjustments, meta): { unitPrice, hiddenLineMarkup }
function applySaleAdjustments(unitPrice, adjustments, meta, price): { salePrice, discounts, fees, netLineAdjustment }
function applyTaxes(taxable, taxes, defaultBehavior): { taxes, inclusiveTaxes, taxAdded, taxCharged }
```

Beyond readability this buys unit-testability per stage — the tax accumulator in particular
(compound bases, inclusive extraction, the `added > 0` bug in 1.2) is currently only reachable
through a full `quoteCart` call.

### 4.2 `ambiguity.ts` holds two unrelated jobs

Proving the catalog unambiguous and building the lookup index are different concerns that happen
to run adjacently. The filename says only one of them, so `buildIndex` is hard to find. Split
into `ambiguity.ts` and `index.ts` (or `lookup.ts`, to avoid colliding with the package entry
point).

### 4.3 `levenshtein` and the suggestion threshold are duplicated

Byte-identical implementations in `src/csv.ts:184` and `src/errors.ts:84`, plus two copies of the
`bestDist <= Math.max(3, ceil(len/2))` heuristic (`src/csv.ts:181`, `src/errors.ts:111`). `csv.ts`
already imports from `errors.ts`, so there is no cycle to avoid. Keep `nearestMatch` in
`errors.ts` and delete the copy.

### 4.4 Stringly-typed keys built by concatenation in three places

The bucket key is assembled independently in `resolve.ts:25` and `ambiguity.ts:173`, the price key
in `merge.ts:70`, the region key in `ambiguity.ts:106` — each with its own delimiter and its own
`?? "*"` convention. Two of these must agree exactly or lookups silently miss, and nothing
enforces that. Give each key one exported builder function, colocated with the type it keys.

### 4.5 The `pick` helper defeats type checking

```ts
// src/rows.ts:143
function pick<T>(row, defaults, key: keyof CatalogRowInput, fallback: T): any
```

Returning `any` means every defaulted field in `resolveRows` — around twenty assignments — is
unchecked. `quantization`, `charm`, `status` and `frequency` are all union types assigned from
`any`, so a bad `CatalogDefaults` value flows straight into a compiled `Price` without complaint.
A typed overload keyed on the field would restore checking at the one place where untrusted input
becomes typed data.

---

## 5. What makes this API hard for a model to use correctly

Collecting the machine-facing angle, since it is a distinct audience with distinct failure modes.
A model writing against this library generates from field names and type signatures, has no
runtime feedback, and will not read a doc comment that contradicts a name. Ranked by likelihood
of producing silently wrong money:

1. **Nine same-typed amount fields with synonym-adjacent names.** `salePrice` vs
   `extendedSalePrice` vs `total` vs `amountDue` are four different numbers that a plausible
   completion will substitute for one another. Nothing in the type system objects. → 2.1.
2. **`extendedSalePrice + tax` is the arithmetic the names invite and it is wrong.** A model
   asked to "show the tax breakdown" will write exactly this. → 2.2.
3. **`quote()` drops `context`,** so a model that follows the README's own suggestion to use it
   for per-line error handling produces prices that differ from `quoteCart`'s, with no error and
   no warning. → 3.1.
4. **`adjustment_start`/`adjustment_end` look like a working feature.** A model generating a
   time-limited promotion CSV will use them — they are in the column list, they parse, they
   validate. The promotion never ends. → 3.2.
5. **Itemized charges don't sum to the reduction they explain,** so any generated reconciliation
   or assertion is intermittently wrong — passing at 999 minor units, failing at 1005. → 1.3.
6. **`debug.unitPrice` duplicating `unitPrice`** invites a model to treat them as distinguishable
   and pick the "more specific" one. → 2.4.
7. **`priceId` looks like a lookup key.** A model will write `prices.find(p => p.id ===
   line.priceId)` and get the wrong price for country-specific rows. → 3.3.

The common shape: every one is a case where **the name promises more than the type enforces.**
Sections 2 and 3 close the gap by moving guarantees out of prose and into the type system — which
is the same move the load-time validation already makes for catalog input, applied to output.

---

## Suggested order

1. **1.1, 1.2, 1.4, 1.5** — bug fixes and dead-code removal. No API change, all behind existing
   tests, and 1.1 restores a guarantee the library advertises.
2. **3.1, 3.2, 3.3** — the traps. Small changes, each removing a documented-but-silent surprise.
3. **2.2** (add `taxableAmount`) — additive, non-breaking, and the highest reconciliation payoff
   per line of change.
4. **4.1, 4.3, 4.4, 4.5** — internal structure. No API surface, enables the rest.
5. **2.1 / 2.3 / 1.3** — the breaking output-shape change. Worth doing as one deliberate v0.2, at
   v0.1.0 with no external consumers, rather than three renames strung across three releases —
   which is exactly the pattern that produced the addendum chain this documentation pass just
   collapsed.
