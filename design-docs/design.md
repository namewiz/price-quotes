# Design: a CSV-catalog-driven quote engine

**Status:** implemented. This document describes the shipped behavior of `src/`. Where the
implementation made a judgment call, or knowingly departed from an earlier spec, it is recorded
under "Judgment calls and known limits" rather than hidden.

## Context

A seller — often non-technical — maintains a product catalog as a CSV or a JSON list of rows,
one row per product/price/tax/discount fact. This library compiles that into a queryable
catalog and prices a cart of line items against it.

The driving scenario is domain-name sales, generalized: a registrar lists `.ng` at $10, `ok.ng`
at $5, offers $8 for `.ng` transfers, and $15 for a 2-year registration instead of $16 — all as
spreadsheet rows, with no code changes. The schema stays product-agnostic enough to describe
software licences, services, or physical goods with the same columns.

Two forces shape everything below. The person editing the catalog is not an engineer, has no
test suite, and will make mistakes that move money. And the engine sits in a checkout path, so
a quote must be fast enough that nobody thinks about it.

## Design goals

1. **Progressive disclosure.** The only required columns are `product_sku` and `price_amount`.
2. **Spreadsheet-native.** Flat rows, not nested JSON. Lists, maps and constraints fit in one
   cell with defined escaping.
3. **Declarative, not programmable.** No callbacks in the catalog. Eligibility is a closed
   comparison grammar over a fixed field set — portable, auditable, safe to deserialize from
   untrusted spreadsheet input.
4. **Fail loudly at load, never silently at checkout.** An ambiguous or contradictory catalog
   throws on load, with every problem reported at once and located by row and column. The
   engine never picks a winner among competing prices and never repairs a cell it doesn't
   understand.
5. **Whole classes of wrong answers excluded by construction.** See *Impossible states*.
6. **O(1) pricing.** Resolving a price is a bounded number of hash lookups and integer
   operations, independent of catalog size.
7. **Correct, reconcilable money math.** All amounts are integer minor units. Quantization
   (representation) and charm (pricing policy) stay distinct. `salePrice × quantity` is exact,
   so unit, extended and total always reconcile.
8. **Reproducible.** A quote is a pure function of `(catalog, cart, asOf)`, and records the
   catalog hash and `asOf` it was computed against.

The general principle behind #4: **push every check as early as possible.** A check at load
runs once against data a human can still edit. The same check at quote time runs on every
request against data nobody is looking at.

## Non-goals

- **No FX conversion.** Multi-currency means "add a row for that currency," not "convert." Every
  quoted amount traces to a row a human typed.
- **No invoicing, payments, or subscription lifecycle.** No proration, no billing schedule, no
  concept of what a customer already owns.
- **No tax compliance logic.** It applies the rules the catalog hands it; it does not determine
  jurisdiction or validate tax IDs.
- **No persistence or catalog CRUD.** Rows are supplied in memory.
- **No cross-line pricing.** Every line prices independently. This is what keeps pricing a pure
  per-line function, keeps it O(1), and keeps cart-scoped constraints from becoming a fixpoint.
  Bundles are catalog entries, not cart-scanning rules — see *Bundles*.

## Impossible states

"We validate that" and "that cannot be represented" are different guarantees. Each row names the
mechanism.

| Cannot happen | Mechanism |
| --- | --- |
| **A mixed-currency cart** | `currency` is a field of `CartRequest`, not `CartLine`. There is nowhere to put a second currency. A line whose SKU has no row in the cart's currency raises `ERR_NO_PRICE`. |
| **A negative unit price** | `price_amount < 0` is a load error, as is a negative `fee` or `markup` value. |
| **A charm-snapped price that goes negative** | Charm runs at quote time, but its input is load-time *bounded*: the floor is the base with every discount and no markup. Compilation proves `charm(floor) ≥ 0`, so `$0.02` with `to9` at position 1 — which would snap to `−$0.01` — is a load error telling the seller to lower `charm_position`. Charm is the identity at zero, so a fully discounted line stays free. |
| **A discount larger than what it discounts** | The quantized base is known at load, so an `amount` discount is compared against `base × min_quantity` and rejected. A `rate` discount above `1.0`, or stackable rate discounts summing above `1.0`, is likewise a load error. |
| **A negative line or cart total** | Follows from the above: unit ≥ 0, quantity ≥ 1, discounts ≤ subtotal by load-time proof, fees/markups ≥ 0, tax rates in `[0, 1]`. A zero total is legal (100% discount, free tier); a negative one is unreachable. |
| **Two prices competing for one query** | Load-time ambiguity detection. If two rows' regions intersect and neither contains the other, the catalog does not load. |
| **A quantity of zero, a fraction, or a negative** | Rejected with `ERR_INVALID_REQUEST` at the API boundary, before any resolution. |
| **A price window that ends before it starts** | `ERR_INVERTED_RANGE` at load; likewise `max_quantity < min_quantity`. |
| **A quote that silently used "now"** | `asOf` is resolved once at the top of `quoteCart`/`quote` and recorded on the result. Nothing below it reads the clock — resolution and constraint evaluation receive an epoch integer. |

## Data model

A catalog row (`CatalogRowInput`) is the unit of authoring: one flat record combining a product
fact, a price fact, and optionally one tax fact and one adjustment (discount/markup/fee) fact.
Only fields differing from the catalog-wide defaults need filling in.

```ts
interface CatalogRowInput {
  // product — identity fields; must agree across all rows sharing a SKU
  product_sku: string;                         // required
  product_aliases: string[];                   // cell: "ng;.ng" — declarative SKU normalization
  product_name: string;
  product_description: string;
  product_status: "active" | "inactive";       // default "active"
  product_family: string;
  product_category: string;
  product_type: string;
  product_features: Record<string, string>;    // cell: "k1=v1;k2=v2" — descriptive, not a price axis
  product_tags: string[];                      // cell: "s1;s2"
  created_at, updated_at, created_by: string;

  // price
  price_id: string;                            // blank => content-derived
  price_amount: number;                        // required; major units, "." decimal, no separators
  product_variant: string;                     // a price axis; blank = wildcard
  price_effective_start: string;               // ISO 8601; blank = open
  price_effective_end: string | null;          // exclusive bound; blank = open
  min_quantity: number;                        // default 1
  max_quantity: number | null;                 // blank = unbounded
  currency: string;                            // ISO 4217; default "USD"
  currency_symbol, currency_separator, locale: string;
  country_code: string;                        // ISO 3166-1 alpha-2; blank = wildcard
  quantization: "nearest" | "floor" | "ceil";  // default "nearest"
  charm: "none" | "to4" | "to9";               // default "none"; requires a rounding increment of 1
  charm_position: number;                      // digit index in minor units; default 0
  frequency: "one-time" | "recurring";         // default "one-time"
  frequency_interval: ("month" | "year") | null;

  // tax — present when any of tax_rate / tax_id / tax_label is non-blank
  tax_id, tax_label: string;
  tax_rate: number;                            // fraction in [0, 1], not a percentage
  tax_behavior: "inclusive" | "exclusive" | "unspecified";   // default "unspecified"
  tax_compound: boolean;                       // default false: additive on the same base
  tax_constraints: string;                     // constraint grammar

  // adjustment — present when adjustment_kind is non-blank
  adjustment_id, adjustment_label: string;
  adjustment_kind: "discount" | "markup" | "fee";   // default "discount"
  adjustment_type: "rate" | "amount";               // default "rate"
  adjustment_basis: "unit" | "line";                // default "line"; only meaningful for "amount"
  adjustment_value: number;                         // rate: fraction in [0,1]. amount: major units, >= 0
  adjustment_start, adjustment_end: string;         // parsed but not yet enforced — see Judgment calls
  adjustment_stackable: boolean;                    // default false
  adjustment_constraints: string;
}
```

Two placements are deliberate, because they answer the questions that come up first:

- **`product_variant` is a price axis, not product identity.** It selects *which price applies*,
  not *which product this is*. `.ng` with variant `transfer` is the same product at a different
  price. Only the product block is subject to the cross-row agreement rule.
- **`product_features` is descriptive, not selective.** It carries "supports DNSSEC" for display
  and filtering. It does not participate in price resolution — see *Bundles*.

Rows compile into `CatalogConfig`, the normalized shape the engine queries:

```ts
interface CatalogConfig {
  products: Product[];
  prices: Price[];        // each carries a precomputed baseUnitMinor and its taxes/adjustments inline
  index: PriceIndex;      // the O(1) lookup structure, built at load
  hash: string;           // content hash, for quote reproducibility
  currencies: Map<string, CurrencyMeta>;
}
```

### Catalog-wide defaults

`loadCatalog(input, defaults)` takes a `CatalogDefaults` object: any `CatalogRowInput` field
(except `product_sku` and `price_amount`), plus two options that have no per-row equivalent.

```ts
loadCatalog(csv, {
  quantization: "nearest",
  currency: "USD",
  // Exponents always derive from Intl. Rounding increments (cash rounding, e.g. CHF at 0.05)
  // have no Intl source, so they are authored here — quantization happens at load.
  currencies: { CHF: { increment: 5 } },
  // Opt-in per-currency magnitude guard. Off by default — see "the undetectable typo".
  price_sanity_range: { NGN: [100, 10_000_000] },
});
```

## The CSV contract

The schema declares `price_amount: number`, but a CSV cell is text. Every gap between the two is
a way to mis-price a product silently, so all of it is specified. Violations are load errors,
never coercions.

- **Encoding and line endings.** A UTF-8 BOM is stripped. `LF`, `CRLF` and mixed endings parse.
  Quoting is RFC 4180.
- **Headers** are matched case-insensitively after trimming and collapsing `-` and space to `_`.
  A duplicate header is an error. An unrecognized header is an error naming the column and its
  nearest known match — the likely cause is a typo in a column that was meant to set a price
  (`price_ammount`), and ignoring it prices the product wrong.
- **Row shape.** Every row must have exactly as many fields as the header. A short or long row
  is an error quoting the row — this is the signal that catches an unquoted decimal comma or
  thousands separator, which shifts every subsequent column by one.
- **Blank vs empty.** A blank cell inherits the catalog default. A cell containing `""` (two
  quote characters) sets the field to the empty string — the only way to clear a default. A row
  where *every* cell is blank is skipped (Excel leaves these behind); a partially blank row is a
  real row.
- **Whitespace.** Leading and trailing whitespace is trimmed from every cell, treating a
  non-breaking space (`U+00A0`, which Excel and web pastes produce freely) as whitespace.
  Interior whitespace is preserved. Trimming is the one permitted normalization: it cannot
  change a number's value or an identifier's meaning, and skipping it makes `"US "` silently
  fail to match `"US"`.
- **Numbers.** `price_amount` and `adjustment_value` (when `amount`) are **major units**: `.` as
  the decimal separator, no group separators, no currency symbols. `12.34` — never `12,34`,
  `$12.34`, or `1,234`. Rates (`tax_rate`, `adjustment_value` when `rate`) are **fractions in
  `[0, 1]`**; `7.5` is an error suggesting `0.075`, because a 750% tax is never what anyone
  meant.
- **Booleans** accept `true`/`false`/`yes`/`no`/`1`/`0`, case-insensitive. Anything else errors.
- **Dates** are ISO 8601. A date-only value is UTC midnight. `_end` bounds are **exclusive**. A
  bare integer is an error naming Excel's date serial format, because that is what it is.
- **Currency codes** are validated by constructing an `Intl.NumberFormat` at load; an invalid
  code becomes a located `ERR_UNSUPPORTED_CURRENCY`.
- **Escaping inside cells.** `;` and `=` are structural in list, map and constraint cells, as are
  `..`, `>=`, `<=`, `!=`, `>`, `<` at the start of a constraint value. A literal is escaped with
  a backslash (`\;`, `\=`, `\>`). Typographic quotes and dashes (`“ ” ‘ ’ –`), which Excel
  autocorrect inserts, are errors inside structured cells rather than silently accepted content.

## Constraint grammar

Tax and adjustment eligibility is a closed comparison grammar. It is inert data: a cell parses
into a small tagged struct at load, evaluates by fixed dispatch over a fixed field set, and never
reaches `eval` or a callback. Equality alone cannot express what sellers actually ask for ("10%
off orders over $100", "EU only", "any tier but free").

```
country_code  = US;CA;GB        OR-set (any of)
customer_tier = !=free          negation
quantity      = 10..49          inclusive range
line_subtotal = >=10000         threshold, minor units
variant       = transfer        bare value is literal equality
```

Multiple keys in one cell are `AND`-ed: `country_code=US;CA & quantity=>=10`.
Operators: `=`, `!=`, `>`, `>=`, `<`, `<=`, `a..b`.

- **Fields are line-scoped only**: `sku`, `variant`, `quantity`, `currency`, `frequency`,
  `country_code`, `line_subtotal` (minor units, post-resolution, pre-adjustment), plus any key
  from the caller-supplied `context` map.
- **Typing is declared per field**, not inferred per value. `quantity` and `line_subtotal` are
  numeric; everything else, including every context key, is a string. A relational operator on a
  string field is a load error, not a silent lexicographic comparison — `country_code >= US` is
  meaningless and must say so.
- **A near-miss on a known field is a load error** naming the key and its nearest match, so
  `contry_code` fails loudly rather than never matching. A field bearing no resemblance to a
  known one is accepted as a caller-context key.
- **A constraint cell without an accompanying fact is an error** (`ERR_CONSTRAINT_ON_PRICE`).
  Prices select by their own columns (`product_variant`, `min_quantity`, `country_code`), so a
  seller who writes `quantity=>=10` in a row carrying no tax or adjustment gets told so.
- **Cart-scoped keys** (`cart_subtotal`, `cart_quantity`, `cart_line_count`) are *recognized and
  rejected* with a dedicated error. They are reserved deliberately: a cart-level threshold would
  make one line's price depend on the others, breaking per-line independence and O(1) pricing.
  Reserving them makes cart-scoped pricing a future feature rather than a format migration.
- **A field absent from the query fails its clause** rather than throwing. A discount gated on
  `customer_tier` simply does not apply to a cart that supplied no `context`.

## Catalog compilation

`loadCatalog(input, defaults): CatalogConfig` returns a config or **throws**. There is no partial
success and no warning channel.

Diagnostics are **collected, then thrown together** as a single `CatalogError` carrying every
problem with its row, column and offending value. Collecting is about ergonomics — a 200-row
sheet with eight bad cells should report eight, not the first — and throwing is about safety.
Those are not in tension: the seller gets one complete list, and no half-valid catalog ever
reaches a checkout. There is deliberately **no lenient mode**; an escape hatch for "just price it
anyway" is a feature request from the person who is about to lose money.

The pipeline, one module per stage:

**1. Parse cells** (`csv.ts`) against the contract above, then **2. require the minimum**
(`rows.ts`): every row needs `product_sku` and a parseable `price_amount`.

**3. Default, don't inherit** (`rows.ts`). A blank cell is filled from the single catalog-wide
`CatalogDefaults` object — never from another row. This is what keeps a row's meaning independent
of file order.

**4. Product identity must agree** (`rows.ts`). Projecting a `Product` from the first row a SKU
appears in would reintroduce the order-dependence step 3 removes: re-sort the sheet and the
compiled product changes. Instead, non-blank identity cells — `product_name`,
`product_description`, `product_status`, `product_family`, `product_category`, `product_type`,
`created_by` — must **agree** across all rows sharing a SKU; blanks defer to defaults. A
disagreement is `ERR_IDENTITY_CONFLICT` naming both row numbers and both values. The set-valued
product fields (`product_aliases`, `product_tags`, `product_features`) are unioned instead, since
adding a tag on one row and another on the next is a reasonable thing to do.

**5. Content-derived IDs** (`merge.ts`). A blank `price_id` is synthesized as a readable
composite — `sku:currency:variant:minqty:maxqty:frequency:start` — not `sku:rowIndex`. Row
indices shift the moment a seller inserts or re-sorts a row, silently re-pointing external
references and making quotes irreproducible across catalog edits. `tax_id` and `adjustment_id`
derive from their `price_id` plus their own discriminating fields.

Content-derived IDs are stable under reordering but **not** under editing: changing a row's
variant changes its ID. They are correct as internal join keys and wrong as durable external
keys. A seller needing a durable key authors `price_id` explicitly and it is honored verbatim.

**6. Merge rows describing the same price** (`merge.ts`). This is what makes the flat schema work
at all, and it must run *before* ambiguity checking. A row carries at most one tax fact and one
adjustment fact, so a price with a discount *and* a fee is authored as two rows repeating the
price:

```csv
product_sku,price_amount,adjustment_kind,adjustment_type,adjustment_value,adjustment_label
.ng,10.00,discount,rate,0.10,Launch offer
.ng,10.00,fee,amount,1.50,ICANN fee
```

Those two rows are **one price with two adjustments**, not two competing prices. The **price
key** is every price-block field: `sku`, `currency`, `variant`, `country`, quantity bounds,
effective window, billing period, `price_amount`, `quantization`, `charm`, `charm_position`.
Then:

- Rows with the **same price key** are the same price; their tax and adjustment facts are unioned
  onto it. A row contributing no tax or adjustment fact is simply redundant (the Excel
  copy-paste case).
- Rows with the **same region but a different price key** — most importantly a different
  `price_amount` — are competing prices, and fail the ambiguity check in step 9.
- Two rows carrying the *identical* tax or adjustment fact (same derived ID) under one price is
  `ERR_DUPLICATE_ADJUSTMENT`, not a silent double-application. A discount applied twice because a
  row was pasted twice is exactly the class of mistake this design exists to catch.
- Two rows sharing an authored `price_id` must agree on every other price-block field, or
  `ERR_PRICE_ID_CONFLICT`. Two rows with *different* authored `price_id`s and the same region
  compete, and fail step 9 normally.

The merge is a group-by on a key, and the resulting tax/adjustment lists are sorted by derived
ID rather than by row order, so it preserves the order-independence from step 3.

**7. Quantize at load** (`validate.ts`). Each price's `baseUnitMinor` is computed once: parse →
scale by the currency exponent → quantize onto the currency's grid. This depends only on the row
and its currency, never on the query. Charm snapping does *not* happen here — see *Charm*. A
`baseUnitMinor` above `2^40` (about ₦1.1 trillion) is `ERR_AMOUNT_TOO_LARGE`: comfortably above
any real price and comfortably below where intermediate products lose precision. A non-`none`
charm on a currency with a rounding increment other than 1 is `ERR_CHARM_INCREMENT_CONFLICT` —
the two are unsatisfiable together, as *Charm* explains.

**8. Validate the merged taxes and adjustments, and bound the unit price** (`validate.ts`). With
`baseUnitMinor` known and the full adjustment set assembled:

- Stackable rate discounts on one price must sum to `≤ 1.0`.
- An `amount` discount must be `≤ baseUnitMinor × min_quantity` — the smallest line it could
  apply to.
- Mixing `rate` and `amount` among stackable adjustments *of one kind* is `ERR_MIXED_STACK_TYPES`.
  The order they would combine in is ambiguous, and a spreadsheet author has no way to specify
  it. Make one non-stackable, or split into separate prices.
- **Bound the unit price.** Because charm runs at quote time on a value that depends on which
  adjustments matched, its result is not a load-time constant — but it is load-time *bounded*.
  The floor applies every discount and no markup, and is computable from the row. Validating
  `charm(floor) ≥ 0` preserves the guarantee against charm underflow without needing the exact
  value: the seller still learns at load that their $0.02 add-on can snap negative.

**9. Prove unambiguity, then build the index** (`ambiguity.ts`). Competing prices, overlapping
regions and coverage gaps are caught here. See *Price resolution*.

Compilation stops at this point if any issue was collected. The index and hash are built only
from a catalog that passed.

### Products, aliases and status

**`product_aliases`** compile into a single alias → SKU map. An alias colliding with another
product's SKU, or with an alias another product claims, is `ERR_ALIAS_CONFLICT` naming both
products — silently resolving it would route a customer to the wrong product. A product may alias
its own SKU; that is a harmless no-op.

**`product_status: inactive`** excludes the product's prices from the index entirely. A query for
an inactive SKU raises `ERR_UNKNOWN_SKU`, not `ERR_NO_PRICE` — from a pricing perspective the
product does not exist, and reporting it as "known but unpriceable" invites a caller to retry
differently. It still appears in `config.products` with its status, so a catalog browser can show
it as unavailable, and its rows are still fully validated: a product deactivated to work around a
load error must still be a valid product, or the error reappears the moment it is switched on.

### The catalog hash

`config.hash` identifies exactly the inputs that can change a quote, and must be reproducible
across processes and row orderings. It is a SHA-256 over a canonical serialization:

1. Take the **compiled** entities, not the source rows — post-default, post-merge, post-money
   resolution. Two catalogs differing only in row order, blank-vs-defaulted cells, or redundant
   duplicate rows are the same catalog and must hash identically.
2. Serialize each price as a fixed-order tuple of its price key, `baseUnitMinor`, and its sorted
   tax and adjustment IDs; each product as its identity fields plus sorted aliases, tags and
   features.
3. Sort the serialized entities, join, and hash.

Excluded deliberately: `created_at`/`updated_at`/`created_by`, `product_description`,
`product_name`, `currency_symbol` and `locale`. These are presentation and provenance — they
cannot change a computed amount, and including them would make a quote irreproducible after a
typo fix in a description. The hash answers "would this catalog price this cart the same way,"
not "is this the same file."

> Tax and adjustment *values* reach the hash only through their derived IDs, which encode them.
> This is load-bearing, and it breaks for author-supplied IDs — see *Judgment calls and known
> limits*.

## Price resolution

### The region model

Every price row describes a **region** of query space, one interval or set per axis:

| Axis | Kind | Region |
| --- | --- | --- |
| `product_sku` | exact | a single value (after alias resolution) |
| `currency` | exact | a single value |
| billing period | exact | `one-time`, `recurring:month`, or `recurring:year` |
| `product_variant` | **wildcard-capable** | a single value, or all values when blank |
| `country_code` | **wildcard-capable** | a single value, or all values when blank |
| quantity | interval | `[min_quantity, max_quantity]`, `max` unbounded when blank |
| effective window | interval | `[start, end)`, either end open |

Three axis kinds, and the distinction drives everything downstream. **Exact** axes partition the
catalog — they can never overlap, so they are pure bucket key. **Wildcard-capable** axes admit a
strictly-containing region, which is what makes overrides expressible, and are the only axes
requiring multi-key probing. **Interval** axes are ordered and admit partial overlap, which is
what makes tiers expressible and gaps possible.

Billing period is exact, not wildcard-capable: `frequency` defaults to `one-time` and is never
blank, so there is no "applies to both" region. `frequency` and `frequency_interval` are one
axis, normalized to a single token at load — `recurring` without an interval, or `one-time` with
one, is `ERR_INVALID_FREQUENCY`. This keeps the wildcard-capable axis count at two, which is what
bounds the probe sequence below.

A price **matches** a query when the query point falls inside the region on every axis. Row `A`
**dominates** row `B` when `A`'s region is contained in `B`'s on every axis and strictly smaller
on at least one. Dominance is the formal version of "more specific."

### Ambiguity is a load-time error

> **Rule.** If two rows' regions intersect and neither dominates the other, the catalog does not
> load.

One rule does the work that would otherwise need three: a specificity ladder ordering the axes
against each other, an overlap scan warning about duplicates, and a tie-break for whatever the
first two failed to decide. It is also stricter than all three, since each of those exists to let
an ambiguous catalog ship.

The tie-break is the important removal. "Lowest price wins" mirrors spreadsheet intuition, but as
an unconditional silent rule it means a missing zero — `5` typed for `50` — becomes the
authoritative price and nothing surfaces. The competing rows are visible in the sheet at load
time. There is no version of "the engine guessed" better than "the catalog didn't load."

Worked through the cases:

- `variant=* / $10` vs `variant=transfer / $8` → the second's region is strictly inside the
  first's on the variant axis and equal elsewhere, so it dominates. **Loads.** A query for
  `transfer` gets $8; anything else gets $10. Deliberate override, correctly expressed.
- `qty [1,10]` vs `qty [1,∞)` → the first dominates. **Loads.** Tiered pricing works.
- `qty [1,10] / $16` vs `qty [5,20] / $15` → regions intersect at `[5,10]`, neither contains the
  other. **Error**, naming both prices and the overlapping range. The seller meant `[1,4]` and
  `[5,20]`, and now knows it.
- `variant=transfer, country=*` vs `variant=*, country=NG` → both match a `(transfer, NG)` query;
  neither dominates. **Error.** This is the case a specificity ladder would decide by fiat —
  "variant outranks country" — for a seller who never made that decision. The fix is an explicit
  `(transfer, NG)` row, which is what they meant.
- Two rows with the same region and the same price key → **not** two prices. Step 6 already
  merged them into one price carrying both rows' facts, so nothing reaches this check. This is
  how a price gets more than one adjustment, and it is why the merge must run first. Identical
  regions with a **different** price key — a different `price_amount`, `charm`, or
  `quantization` — are competing prices, and error.
- **Coverage gaps.** `qty [1,10]` and `qty [20,∞)` don't intersect, so the dominance rule is
  silent. But quantity 15 is then unpriceable, which is a typo far more often than a policy. A
  gap in the interior of a SKU's covered quantity range is `ERR_QUANTITY_GAP`; an open ceiling
  is fine, and a query above it raises `ERR_NO_PRICE` at runtime. The same applies to effective
  windows: a gap between a price ending and its replacement starting is `ERR_WINDOW_GAP`, because
  it is a period during which the product cannot be sold.

### The detection algorithm

Two traps make the naive version wrong, and both are worth naming because the obvious
implementation falls into them.

**The check is not per-bucket.** The crossed-axes case — `(transfer, *)` against `(*, NG)` — is
precisely a pair landing in two *different* buckets. Any algorithm comparing only rows that share
a bucket key misses the case this rule exists to catch.

**The region is two-dimensional.** Quantity and effective window are independent interval axes,
so overlap is rectangle intersection, not interval intersection. Sorting by quantity lower bound
and comparing neighbours reports a false conflict for two rows that overlap in quantity but sit
in disjoint time windows — a mid-tier price change, which is legitimate and common.

The procedure runs per `(sku, currency, billing period)` group — call its row count *m*, which is
single digits for almost every product:

1. **Pairwise wildcard-axis screen.** For each pair, compare the `variant` and `country` regions.
   Skip the pair if either axis is disjoint (two different exact values). Otherwise record the
   pair's relation: `A ⊂ B`, `B ⊂ A`, `equal`, or **`incomparable`** — the last being the
   crossed-axes case, where each row is exact on an axis the other wildcards.
2. **Rectangle intersection on the interval axes.** For each surviving pair, test whether the
   quantity intervals overlap *and* the effective windows overlap. Both must, for the regions to
   intersect at all.
3. **Verdict per intersecting pair.** `incomparable` → `ERR_AMBIGUOUS_PRICE`. `equal` → dominance
   must come from the interval axes: one rectangle must strictly contain the other, else error.
   `A ⊂ B` → `A` must be at least as small on the interval axes too; a row more specific on
   variant but *wider* on quantity is incomparable, and errors.
4. **Coverage.** Per wildcard-axis region within the group, sort by `min_quantity` and walk
   adjacent pairs whose effective windows overlap; a hole between two populated tiers is
   `ERR_QUANTITY_GAP`. Then sweep the effective-window boundaries into slabs; a slab with no
   active price, sitting between slabs that have one, is `ERR_WINDOW_GAP`.

   Coverage is checked *upward from the lowest `min_quantity` present*, not from 1. A catalog
   whose cheapest tier starts at 5 has an open floor, which is a legitimate minimum order
   quantity; a query for 3 raises `ERR_NO_PRICE`. Only a hole *between* two populated tiers is an
   error, since that is a typo rather than a policy.

Cost is `O(m²)` per group plus the slab sweep, and `O(n log n)` overall to form the groups. The
`m²` term is on rows sharing a SKU, currency and billing period — not on the catalog — so a
100,000-row catalog with a dozen rows per product validates in linear time plus a rounding error.

### The index, and why lookup is O(1)

Because the catalog is proven unambiguous at load, the set of rows matching any query is a
**chain** under dominance — the winner is the most specific one, and the first hit in a fixed
probe order *is* that winner. No sorting, no comparison, no scan.

```
key   = sku ‖ currency ‖ billingPeriod ‖ variant ‖ country     // "*" for a wildcard axis
value = PriceBucket { bands: Band[] }   // quantity × window rectangles, sorted by min_quantity
```

Resolution (`resolve.ts`):

1. **Normalize the SKU** — one map lookup against the alias table.
2. **Probe the index** along the specificity lattice of the two wildcard-capable axes, most
   specific first: `(variant, country) → (variant, *) → (*, country) → (*, *)`. First hit wins.
   Four probes maximum; fewer when the query omits an axis.

   **Why first-hit is correct, and why the middle two may be probed in either order.** If
   `(variant, country)` hits, that row's region is contained in every other candidate's, so it
   dominates them all. If it misses, at most one of `(variant, *)` and `(*, country)` can hit:
   those two regions are incomparable, and the per-pair verdict rule rejects any catalog in which
   two incomparable regions intersect. So they cannot both contain the query point, and
   the order between them is arbitrary — fixed only for reproducibility of the audit trail, not
   for correctness. The load-time invariant is what buys the O(1); without it this would be a
   scan and a sort.

   The probe count is `2^w` where *w* is the number of wildcard-capable axes — a compile-time
   constant, independent of catalog size. Adding a third would double it to 8, which is the
   concrete cost of that decision and the reason `product_features` stays out of resolution.
3. **Select the band** within the bucket: the first whose quantity interval contains the quantity
   *and* whose window contains `asOf`. Bands are non-overlapping rectangles, so at most one
   matches. Buckets hold 1–3 bands in practice, so a linear scan is a handful of integer
   comparisons. No match → `ERR_NO_PRICE`, reachable only through an open floor or open ceiling,
   since interior gaps were rejected at load.
4. **Read `baseUnitMinor`** — already an integer on the `Price`. Taxes and adjustments hang inline
   off it, so there is no second lookup and no join.

### What is precomputed, and why it matters more than the lookup

The lookup was never going to be the bottleneck. These are:

| Work | Naive placement | Here |
| --- | --- | --- |
| Parsing `price_amount` text | per quote | load |
| Quantizing to `baseUnitMinor` | per quote | load |
| Parsing constraint cells | per quote | load |
| Parsing ISO dates | per quote | load — windows are epoch integers, compared as integers |
| Currency exponent lookup | per quote | load, and memoized per `(currency, locale)` |
| `Intl.NumberFormat` construction | per format call | cached — constructing one costs microseconds and would dominate the entire quote |
| Joining taxes/adjustments by `price_id` | per quote | load — attached inline |
| Alias resolution | string munging per quote | load — a map |
| Charm snapping | — | **quote, by necessity**: it applies after query-dependent discounts. Pure integer work, no allocation |

The rule the implementation holds to: **at quote time, no string is parsed, no regex is run, no
`Date` is constructed, and no `Intl` object is created.** Everything is integer arithmetic over
precomputed structures.

## Money

Two mechanisms live here, and they are **not** a pair. Quantization is a *representation* rule —
how any value lands on the grid of amounts this currency can express. Charm is a *pricing policy*
— which of those representable amounts looks good on a page. A catalog with `charm: none` still
quantizes; a currency with no rounding increment still charms. Conflating them is the mistake
that makes people expect one to move when the other does.

### Quantization — representation

`quantization` converts a value into a minor-unit integer lying on the currency's grid, defined
by its exponent and optional rounding increment: `nearest` (half away from zero, the default),
`floor`, or `ceil`. Float representation error is corrected before rounding — `79.8 × 0.075` is
exactly `5.985` but floats give `5.984999…`, and quantizing that down is a real bug a naive
implementation reintroduces every time.

It applies **wherever a value must become representable**, which is two places:

1. **At load**, converting `price_amount` into `baseUnitMinor`.
2. **At quote time**, after each rate multiply, before charm — because `1234 × 0.90 = 1110.6` is
   not a representable amount either.

The same row-level mode governs both. A seller who sets `floor` means "never round up against the
customer," and that intent applies at least as much to the discounted price as to the base;
applying their mode at load and a hardcoded one at quote would put the configurable knob where
nothing is at stake and a fixed rule where the money is.

A note so nobody expects load-time quantization to do work it doesn't: at load, quantization only
does something real when the currency has a **rounding increment** — CHF at 0.05, where `12.34`
snaps to `12.35`. For every currency without one, `12.34 × 100 = 1234` is exact and the mode is
moot. It earns its configurability at quote time.

Tax rounding is explicitly *not* governed by this. See *Arithmetic rounding*.

### Charm — pricing policy

Charm snapping applies to the **unit** amount only, never to a line total, and runs **at quote
time**, after markup and discounts. Two constraints pin it there. It must come *after*
adjustments, because a discounted price is a price the customer sees and it should end in `.99`
too — snapping the base and then discounting produces $10.79, which is what `to9` exists to
prevent. And it must come *before* the quantity multiply, because `to9` on a line total is
incoherent: a $9.99 unit at quantity 3 gives $29.97, snapped to $29.99, which is not a charm
price and no longer equals unit × quantity. Applying it after tax is worse still — the unit
price, the extended price and the total become three mutually inconsistent numbers on one
invoice. Charmed unit, then exact multiply, is the only ordering where every displayed figure
reconciles *and* every displayed price is a charm price.

A charm candidate is a minor-unit integer whose digit at `charm_position` *p* is the charm digit
*d* (4 or 9) and whose lower digits are all 9:

```
candidate(k) = k·10^(p+1) + d·10^p + (10^p − 1)
```

The result is the **nearest** candidate — not the next one upward. "Round up to the next value
ending in 9" maps $12.00 to $12.09, where every seller means $11.99. Ties resolve **downward**;
charm pricing exists to look cheaper.

| Input | Currency | Behavior | *p* | Candidates | Result |
| --- | --- | --- | --- | --- | --- |
| $12.34 | USD (exp 2) | `to9` | 1 | $11.99, $12.99 | **$11.99** |
| $12.34 | USD | `to9` | 0 (default) | 1229, 1239 | **$12.29** (tie → down) |
| $12.34 | USD | `to4` | 1 | $11.49, $12.49 | **$12.49** |
| $12.00 | USD | `to9` | 1 | $11.99, $12.99 | **$11.99** |
| ¥15,943 | JPY (exp 0) | `to9` | 2 | ¥14,999, ¥15,999 | **¥15,999** |
| $0.02 | USD | `to9` | 1 | −$0.01, $0.99 | **load error** |

`charm_position` defaults to `0`, so a `to9` USD row with no explicit position snaps to the
nearest `…x9` cent, not the nearest `…99`. A seller who wants $11.99 sets `charm_position: 1`.

The last row is why compilation bounds the unit price rather than merely quantizing it: the
nearest candidate to 2 minor units is −1, and a negative price must be impossible rather than
merely unlikely. Since charm runs at quote time, the check is applied to the load-time *floor* —
the unit with every discount and no markup — so the seller still learns at load, and is told to
lower `charm_position` or set `charm: none`. `charm(0) = 0` by definition, so a fully discounted
line stays free instead of snapping.

**Charm and rounding increments are mutually unsatisfiable**, and the combination is
`ERR_CHARM_INCREMENT_CONFLICT`. An increment of 0.05 means every representable amount ends in 0
or 5; charm candidates end in 4 or 9 by construction. No value satisfies both — CHF with
`charm: to9` describes a price that cannot exist, so whichever operation ran last would silently
win. This is the one place the two mechanisms interact at all, and the interaction is a
contradiction rather than an ordering question.

### Arithmetic rounding

Rates produce fractions of a minor unit, so rounding at quote time is unavoidable. What *is*
avoidable is leaving it implicit — the choice of where to round changes totals, so the points are
enumerated and the mode is fixed. Two modes, split by whether the value is a *price* (the
seller's call) or a *tax* (not):

- **Adjustment results use the row's `quantization` mode** — the same rule that landed the base
  amount on the currency's grid, since these values need to land on it for the same reason.
- **Tax results use half away from zero, always**, with float error corrected first. Not
  configurable: letting a seller pick a tax-rounding mode is an invitation to a compliance
  problem, and a tax authority is not interested in the catalog's charm strategy.

**The rounding points**, and nowhere else:

1. **The combined markup rate**, applied once to `baseUnitMinor` and quantized → `unitPrice`.
2. **The combined fee-minus-discount rate**, applied once to `unitPrice` and quantized. All rate
   adjustments within a stage are summed *as exact rates first* into a single net factor, then
   multiplied and quantized once. Quantizing each adjustment separately and summing makes the
   total depend on visit order: two 5% discounts on 999 minor units give `50 + 50 = 100` applied
   separately but `round(999 × 0.10) = 100` combined, and at other values they diverge. One base
   and one quantization is order-independent, which goal #4 requires. Charm then snaps this
   result.
3. **Each `amount` adjustment**, already an integer after load-time quantization — multiplied by
   quantity when `adjustment_basis` is `unit`, applied once to the line when it is `line`. Exact.
4. **Each tax line, individually**, against its own base, half away from zero. Taxes round per
   line rather than on a summed rate because they are itemized on invoices and each must
   reconcile on its own.
5. **The inclusive-tax extraction**, `gross − round(gross ÷ (1 + rate))`, computed on the
   post-adjustment gross, half away from zero.

Points 1–2 land *before* charm, so for a row with `charm` set the snapping usually subsumes the
quantization entirely — the mode matters most for the default `charm: none`, which is exactly
where a seller's `floor`/`ceil` intent has nothing else to express it.

Every other operation — `salePrice × quantity`, summing line totals into `amountDue` — is exact
integer arithmetic with no rounding. Because rounding only ever happens on a rate application,
and each line's components are integers rounded when produced, the invariant holds: displayed
components always sum to the displayed total.

**Bounds.** All monetary values are integer minor units held in JavaScript numbers, valid to
`Number.MAX_SAFE_INTEGER`. A `salePrice × quantity` product exceeding it is `ERR_AMOUNT_OVERFLOW`
at quote time; a `baseUnitMinor` above `2^40` is a load error.

### Currency metadata

The minor-unit exponent derives from
`Intl.NumberFormat(locale, { style: "currency", currency: code }).resolvedOptions()
.maximumFractionDigits`, which also gives free code validation. Two things the derivation does
not cover, which is why `CatalogDefaults.currencies` exists: `Intl` supplies no rounding
increment, so cash rounding (CHF at 0.05) must be authored; and a symbol from `formatToParts` is
locale-dependent — a guess about the reader rather than a fact about the currency — so
`currency_symbol` remains authored data. Increments must be supplied to `loadCatalog`, not to
`Quotes`, because quantization has already happened by the time `Quotes` exists.

## Line computation

The pipeline order is fixed. Everything expressible per unit is applied per unit, before charm:

```
[load]  parse → quantize                                    ⇒ baseUnitMinor
[quote] baseUnitMinor → markup → quantize                   ⇒ unitPrice   (× qty ⇒ extendedUnitPrice)
        unitPrice → fee/discount → quantize → charm         ⇒ salePrice   (× qty ⇒ extendedSalePrice)
        extendedSalePrice → line-basis adjustments → tax    ⇒ total
```

**Stage 1 — markup.** Markup rate and unit-basis markup amounts apply to the raw catalog
`baseUnitMinor`, quantized, giving `unitPrice`. No charm here: charm is sale-price psychology,
not sticker-price policy. Markup is the seller's margin, so it is **folded into `unitPrice` and
never itemized** in the customer-facing output — it changes what the price *is*, rather than
being a charge levied on top of it. Line-basis markup is carried as a hidden accumulator that
still affects the tax base and `total`, but never appears in `fees` or `netLineAdjustment`.
`debug` exposes all of it.

**Stage 2 — fee and discount.** Fee/discount rates and unit-basis amounts apply on top of
`unitPrice` — not the raw catalog price — then quantize, then charm, giving `salePrice`. A 20%
reseller markup on $12.34 must produce $14.99, not $14.39; charming before the markup gives the
latter.

**All rate adjustments within a stage share one base and combine additively:**

```
unitPrice = quantize(baseUnit × (1 + Σmarkup_rate) + Σmarkup_unit_amount)
salePrice = charm(quantize(unitPrice × (1 + Σfee_rate − Σdiscount_rate))
                  + Σfee_unit_amount − Σdiscount_unit_amount)
```

They are *not* applied sequentially. Sequential application makes the result depend on the order
the kinds are visited — a 10% markup then a 10% discount is not a 10% discount then a 10% markup
— and a spreadsheet author has no way to express an intended order. A common base is commutative.
Within a kind, stackable rows sum and non-stackable rows compete, the single
most-favorable-to-the-buyer one winning per kind (largest discount, smallest fee/markup).

**Line-scoped adjustments.** `amount` adjustments with `adjustment_basis: line` (the default) are
inherently line-scoped — a $5-off-the-order coupon cannot be pushed onto a unit without dividing
by quantity, which would break integer exactness. These apply **after** charm, to the line total,
netted into `netLineAdjustment` (fee minus discount, so a net line discount makes it negative). A
coupon does not produce a charm-priced line, and nobody expects it to.

**Charm of zero is zero.** A fully discounted unit stays free rather than snapping to the nearest
charm candidate, which for `to9` at position 1 would be −$0.01. This is a definitional carve-out,
not a clamp: the charm function is the identity at zero.

**Tax.** Computed on the post-adjustment taxable amount (`extendedSalePrice + netLineAdjustment`
plus any hidden line markup). `exclusive` adds to the total; `inclusive` is extracted from the
price rather than added; `unspecified` follows the configurable `defaultTaxBehavior` (default
`exclusive`) — a policy, not a definition, and one that silently inflates a total when the
catalog didn't say to. Multiple taxes apply additively on the same base unless `tax_compound` is
set, which Quebec (GST + QST) and several LATAM regimes require.

Two running totals are maintained: tax **charged** (which includes inclusive tax, because it is
real tax owed) and tax **added** (which does not, because it is already in the price).
Conflating them reports zero tax on inclusive-tax quotes. `LineQuote.tax` is the *added* figure —
what the customer is being charged extra — while `debug.taxLiability` is the *charged* figure,
which is what remittance needs.

**Inclusive tax × discount:** a discount reduces a gross that already contains tax, so tax is
recomputed from the discounted gross, reducing net and tax proportionally. Worked: unit gross
1199 minor, 7.5% inclusive, 10% discount → discount 120, gross 1079, tax
`1079 − round(1079/1.075) = 75`, total 1079.

### Worked example, end to end

`.ng` at `price_amount 12.34` USD, `charm to9` with `charm_position 1`, quantity 3, a stackable
10% discount, 7.5% exclusive tax:

| Step | When | Computation | Minor units |
| --- | --- | --- | --- |
| parse | load | `"12.34"` → 12.34 major | — |
| quantize | load | 12.34 × 100 | `baseUnitMinor` 1234 |
| markup (none) | quote | — | `unitPrice` 1234 |
| discount | quote | 1234 × (1 − 0.10) = 1110.6 → round | 1111 |
| charm `to9` p=1 | quote | nearest of 1099, 1199 | **`salePrice` 1099** ($10.99) |
| × quantity 3 | quote | exact integer multiply | `extendedSalePrice` 3297 |
| tax 7.5% exclusive | quote | round(247.275) = 247 | **`total` 3544** ($35.44) |

`salePrice × quantity` = $10.99 × 3 = $32.97 = `extendedSalePrice`. Every displayed figure
reconciles, and the discounted price the customer sees is itself a charm price.

The same line with **no** discount charms 1234 to 1199 — so the list price a browsing customer
sees is $11.99, and the discounted price is $10.99. Both are charm prices, which is the point.
Charming *before* adjustments would give 1234 → 1199 → less 10% → 1079 → **$10.79**, a price
ending in 79, which is exactly what a seller configuring `to9` was trying to avoid.

## The public API

```ts
class Quotes {
  constructor(config: CatalogConfig, options?: {
    defaultTaxBehavior?: "inclusive" | "exclusive";   // for tax_behavior: unspecified; default "exclusive"
    normalizeSku?: (raw: string) => string;
    debug?: boolean;                                  // default false
  })
  quoteCart(request: CartRequest): CartQuote
  quote(line: CartLine, currency: string, asOf?: Date): LineQuote
}

interface CartRequest {
  currency: string;                       // one currency per cart, structurally
  lines: CartLine[];
  asOf?: Date;                            // defaults to now(), but always recorded
  context?: Record<string, string>;       // available to the constraint grammar
}

interface CartLine {
  sku: string;                            // raw; alias-resolved during resolution
  quantity: number;                       // positive integer
  variant?: string;                       // omitted => matches only wildcard-variant prices
  frequency?: "one-time" | "recurring";   // default "one-time"
  interval?: "month" | "year";            // required iff frequency is "recurring"
  country?: string;                       // omitted => matches only wildcard-country prices
  ref?: string;                           // caller's opaque line identifier, echoed on the quote
}

interface CartQuote {
  lines: LineQuote[];                     // one per input line, in order
  amountDue: number;                      // sum of every line's total
  currency: string;
  asOf: string;                           // ISO 8601
  catalogHash: string;
}
```

Four things this shape settles:

- **Currency lives on the cart.** A mixed-currency cart isn't rejected by a check; it has nowhere
  to be expressed. Summing across currencies without FX is undefined, and the type system should
  say so.
- **A failing line fails the cart.** `quoteCart` throws on the first unpriceable line rather than
  returning a partial result, with the offending line index and SKU in the message. Per-line
  result unions are the right shape for a catalog browser; for a checkout, a cart that silently
  prices four of five items is how a customer gets charged for something they didn't get. A
  caller wanting best-effort behavior calls `quote()` per line and handles its own failures.
- **`asOf` is explicit and recorded.** Filtering effective windows against an implicit `now()`
  makes quotes unreproducible from an audit log, un-backdatable, and untestable without clock
  mocking. Together with `catalogHash`, a stored quote identifies both of its inputs.
- **There is no cart total, only `amountDue`.** A cart holding a one-time registration and a
  monthly subscription has no single meaningful "total"; `amountDue` is defined as the sum of
  line totals and named for what it is. A caller wanting per-billing-period sub-totals buckets
  `lines` by `frequency`/`interval` itself — the demo in `docs/index.html` does exactly this.

SKU normalization is data-first: `product_aliases` handles the ordinary case (`.ng` ≡ `ng`)
declaratively, compiled into the alias map. The `normalizeSku` hook remains for genuinely
algorithmic normalization. It does not violate goal #3 — it is caller-owned and
construction-time, so it cannot arrive from untrusted spreadsheet input — but for catalogs using
it, reproducibility depends on application code as well as on the catalog hash, and it runs on
every line, so it must be O(1) and allocation-light.

### `LineQuote`, and why it is shaped like an invoice

Every amount is integer minor units. The fields are in pipeline order, each building on the last.

```ts
interface LineQuote {
  ref?: string; sku: string; priceId: string; quantity: number;
  variant: string | null; country: string | null; currency: string;
  frequency: Frequency; interval?: FrequencyInterval;

  unitPrice: number;           // catalog price with markup folded in; pre-discount/fee/charm
  extendedUnitPrice: number;   // unitPrice * quantity — the "list" line total
  salePrice: number;           // actual unit price charged, after discount/fee/charm
  extendedSalePrice: number;   // salePrice * quantity
  discounts: AppliedCharge[];  // itemized unit-basis discounts, valued against unitPrice
  fees: AppliedCharge[];
  netLineAdjustment: number;   // net line-basis fee minus discount; negative when discount wins
  taxes: AppliedTax[];         // only taxes that actually add to the bill
  tax: number;                 // sum of taxes[].amount; 0 when all applicable taxes are inclusive
  total: number;               // extendedSalePrice + netLineAdjustment + tax
  debug?: LineQuoteDebug;      // present only when QuotesOptions.debug is true
}
```

The naming pattern is deliberate. `extended<X>` is the standard invoicing term for "price ×
quantity", so `extendedUnitPrice`/`extendedSalePrice` read as a matched pre-/post-discount pair.
`netLineAdjustment` states both that it is a net value and that it is line-scoped, which
distinguishes it from the unit-basis fees and discounts itemized alongside it. Note that
`extendedSalePrice` is computed *before* `netLineAdjustment` and tax, so
`extendedSalePrice + tax !== total` in general.

**Two things are hidden from the plain output**, because they are the seller's business rather
than the customer's:

- **Markup**, folded into `unitPrice` and never itemized. A customer sees the price; the margin
  inside it is not a line item.
- **Inclusive tax**, which never appears in `taxes` because nothing was added to the bill. A tax
  line item the customer isn't being charged for is misleading on an invoice.

Both are inspectable via `QuotesOptions.debug`, which is for developers and business owners:

```ts
interface LineQuoteDebug {
  costPrice: number;            // Price.baseUnitMinor — the raw catalog price, before markup
  markup: AppliedCharge[];      // itemized markup folded into unitPrice
  unitPrice: number;            // same value as the public unitPrice, for a one-glance view
  inclusiveTaxes: AppliedTax[]; // taxes baked into the price, with their extracted amount
  taxLiability: number;         // total real tax owed: exclusive + the inclusive-extracted portion
}
```

`debug` is `undefined` on every line when the option is off, so the default output shape stays
exactly invoice-shaped.

## Errors

All failures are `QuoteError` (or `CatalogError`, a subclass) with a stable string `.code`, so
callers branch on the code rather than on message text.

**Load-time** — all collected into one `CatalogError`, carrying `issues: Issue[]` with row,
column, value and a suggested fix:

`ERR_CSV_SHAPE`, `ERR_UNKNOWN_COLUMN`, `ERR_DUPLICATE_COLUMN`, `ERR_BAD_NUMBER`,
`ERR_RATE_OUT_OF_RANGE`, `ERR_BAD_DATE`, `ERR_BAD_BOOLEAN`, `ERR_UNSUPPORTED_CURRENCY`,
`ERR_NEGATIVE_AMOUNT`, `ERR_AMOUNT_TOO_LARGE`, `ERR_INVALID_FREQUENCY`, `ERR_IDENTITY_CONFLICT`,
`ERR_ALIAS_CONFLICT`, `ERR_PRICE_ID_CONFLICT`, `ERR_DUPLICATE_ADJUSTMENT`, `ERR_AMBIGUOUS_PRICE`,
`ERR_QUANTITY_GAP`, `ERR_WINDOW_GAP`, `ERR_INVERTED_RANGE`, `ERR_CHARM_UNDERFLOW`,
`ERR_CHARM_INCREMENT_CONFLICT`, `ERR_DISCOUNT_EXCEEDS_PRICE`, `ERR_MIXED_STACK_TYPES`,
`ERR_CONSTRAINT_SYNTAX`, `ERR_CONSTRAINT_UNKNOWN_FIELD`, `ERR_CONSTRAINT_CART_SCOPE`,
`ERR_CONSTRAINT_ON_PRICE`, `ERR_PRICE_SANITY_RANGE`.

`ERR_AMBIGUOUS_PRICE` carries both price IDs and the overlapping quantity ranges, because "two
prices conflict" without those is not actionable on a 200-row sheet.

**Quote-time** — deliberately few, because most classes of error were made unreachable at load:
`ERR_UNKNOWN_SKU` (unknown or inactive), `ERR_NO_PRICE` (nothing covers this quantity or date),
`ERR_INVALID_REQUEST` (non-positive or fractional quantity, or a recurring line with no
interval), `ERR_CURRENCY_NOT_IN_CATALOG`, `ERR_AMOUNT_OVERFLOW`.

## Scenarios the design must express

Each is a test in `tests/scenarios.test.js`, where the full CSV lives.

| # | Shape | What it proves |
| --- | --- | --- |
| 1 | `product_sku,price_amount`, one row | Progressive disclosure: everything else defaults |
| 2 | Blank variant + `transfer` variant | The canonical override. The wildcard region strictly contains the specific one, so it dominates and the catalog loads |
| 3 | `qty [1,1] $16`, `qty [2,∞) $15` | Tier boundary: quantity 2 must hit the second row. Bands adjacent, no overlap, no gap |
| 4 | Same SKU in USD and JPY | Multi-currency without FX; exercises exponent 0. A cart in EUR → `ERR_CURRENCY_NOT_IN_CATALOG` |
| 5 | Blank country + `NG` country | Same dominance shape as variants, different axis |
| 6 | Windows abutting at `2026-01-01` | `_end` is exclusive, so no overlap and no gap. `asOf = 2026-01-01T00:00:00Z` → the new price; one second earlier → the old. Impossible to test without an explicit `asOf` |
| 7 | Variant-based bundle; separate-SKU bundle | See *Bundles* |
| 8 | Charm with markup, with discount, with both | `salePrice × quantity === extendedSalePrice`; the final unit is always a charm candidate. 20% markup on 1234 → 1481 → **$14.99**, not $14.39 |
| 9 | 7.5% inclusive tax + 10% discount | Tax *charged* non-zero while tax *added* is zero; total equals the discounted gross |
| 10 | GST 5% + QST 9.975% with `tax_compound` | The second computes on base + first; the same rows without compounding give the additive result |
| 11 | `price_amount` of `0` | A zero price is legal and distinct from a blank cell. A zero total is a valid quote |
| 12 | One-time line + monthly line in one cart | Both price independently; `amountDue` sums them; callers bucket by period themselves |
| 13 | `rate` discount of exactly `1.0`, then `1.01` | Total exactly zero, no error; `1.01` → `ERR_RATE_OUT_OF_RANGE`. The boundary is the test |
| 14 | Fee and discount on one price | A fee survives a discount that zeroes the sale price; total stays non-negative |
| 15 | Two rows, same price, different adjustments | The row-merge case. **Not** an ambiguity error. Negative controls beside it: differing `price_amount` → `ERR_AMBIGUOUS_PRICE`; a verbatim third row → `ERR_DUPLICATE_ADJUSTMENT` |
| 16 | Mid-tier price change (2×2 qty × window grid) | The false-positive control: quantity intervals overlap pairwise and windows overlap pairwise, but no *rectangle* overlaps another. Must load. A one-dimensional overlap scan wrongly rejects this |
| 17 | `adjustment_constraints: customer_tier=!=free` | Applies with `context: { customer_tier: "pro" }`; with the key absent, fails the constraint rather than throwing |

### Bundles

"Can a bundle be a different price when feature X is included?" — not through `product_features`.
Putting features in the resolution path would add an unbounded, set-valued wildcard axis, which
multiplies probe count, turns the dominance check into a subset lattice rather than interval
containment, and gives the seller a second way to express something they can already express.

The intended mechanism is **the variant axis**: a bundle is the same product configured
differently (`.ng` at $10 with `privacy=no`, `.ng` variant `with-privacy` at $13 with
`privacy=yes`). The buyer picks a variant, the price follows, and `product_features` stays
available for display. When the bundle is a genuinely different thing — different components, its
own SKU on an invoice — model it as its own product.

What is **not** supported, and should be stated rather than discovered: the engine will not
detect that a cart containing `.ng` *and* `hosting-basic` should be repriced as
`ng-plus-hosting`. That is cross-line logic, which breaks per-line independence and O(1) pricing.
Cart composition is the caller's job — it has the UI context to say "add both and save $15" — and
the engine's job is to price whatever composition it is handed. The cart-shaped API means adding
cross-line rules later is an extension, not a redesign.

## Adversarial catalogs

The worst mistakes a business owner actually makes. Each is a test in `tests/scenarios.test.js`
asserting a specific error code, and together they are the argument for goal #4 — every one of
these prices something wrong under a lenient engine.

| # | The mistake | Outcome |
| --- | --- | --- |
| 1 | **The missing zero.** `50.00` and `5.00` on identical regions | `ERR_AMBIGUOUS_PRICE`. Lenient engines take the cheaper row and sell at a 90% discount forever |
| 2 | **Percentage confusion.** `tax_rate,7.5` meaning 7.5% | `ERR_RATE_OUT_OF_RANGE` suggesting `0.075`. A 750% tax turns a $10 domain into $85. Same guard on `adjustment_value` |
| 3 | **The decimal comma.** `12,50` unquoted | `ERR_CSV_SHAPE` on field count, before any field is interpreted — every later column shifted by one. Quoted (`"12,50"`) → `ERR_BAD_NUMBER` |
| 4 | **Symbols and separators.** `$12.34`, `1,234.00`, `₦15 943` | `ERR_BAD_NUMBER`. `$12.34` silently becoming `12.34` today means `12,34` silently becoming `12` tomorrow |
| 5 | **Overlapping tiers.** `[1,10]` and `[5,20]` | `ERR_AMBIGUOUS_PRICE` naming the overlap. The mirror-image typo `[1,10]` and `[20,∞)` → `ERR_QUANTITY_GAP`: 11–19 unsellable |
| 6 | **Crossed axes.** `(transfer, *)` and `(*, NG)` | `ERR_AMBIGUOUS_PRICE`. A Nigerian customer transferring matches both; neither is more specific. A ladder would silently pick one. The fix is an explicit `(transfer, NG)` row |
| 7 | **The forgotten end date.** Two open-ended windows | Resolves by containment rather than erroring — see *Judgment calls*. The inverse, closing the old price early → `ERR_WINDOW_GAP` |
| 8 | **Inverted ranges.** `min 10, max 2`; end before start | `ERR_INVERTED_RANGE`. A lenient engine matches nothing and the product silently disappears from sale |
| 9 | **Renamed in one place.** `product_name` fixed on row 1 only | `ERR_IDENTITY_CONFLICT` naming both rows and values. Under "first occurrence wins", re-sorting would change the displayed name |
| 10 | **A discount bigger than the product.** `amount: 15` on a $10 product | `ERR_DISCOUNT_EXCEEDS_PRICE` at load, against `baseUnitMinor × min_quantity`. Never a runtime clamp |
| 11 | **Stacked discounts past 100%.** Three stackable 40% | Load error on the sum. Individually each is legal, which is what makes it worth checking |
| 12 | **A negative fee.** `kind: fee, value: -5` meaning "$5 off" | `ERR_NEGATIVE_AMOUNT` telling them to use `kind: discount`. Otherwise the sign convention silently inverts downstream |
| 13 | **Charm underflow.** A $0.02 add-on under a catalog-wide `charm: to9` | `ERR_CHARM_UNDERFLOW` rather than a −$0.01 price. Catalog-wide defaults make this reachable without the seller touching the row |
| 14 | **Excel's helpfulness.** Date serial `46236`; trailing NBSP; `≠free` autocorrect; smart quotes | Whitespace and the BOM are normalized (they cannot change meaning); the rest are errors naming what happened, because a silently unmatched constraint is a discount that never applies and nobody notices |
| 15 | **Column typos.** `price_ammount`, `min_qty`, `contry_code` | `ERR_UNKNOWN_COLUMN` with the nearest match. An ignored `price_ammount` column means every row falls back to the default price |
| 16 | **Constraint in the wrong place.** `quantity=>=10` on a row with no adjustment | `ERR_CONSTRAINT_ON_PRICE` |
| 17 | **Duplicated header.** Two `currency` columns after a bad merge | `ERR_DUPLICATE_COLUMN` rather than last-one-wins |
| 18 | **The undetectable one.** `1594300` for NGN meaning kobo, when the column is naira | Nothing in the schema can distinguish this from a legitimately expensive product, and this design does not pretend otherwise. Mitigation is opt-in: `price_sanity_range` per currency, off by default, because a guess about plausible prices is not something the library can make. The known limit of static validation |

## Judgment calls and known limits

Recorded because each is a place the implementation decided something the spec left open, or
where the shipped behavior will surprise someone reading only the prose above.

- **`charm_position` defaults to `0`, not `exponent − 1`.** A `to9` USD row with no explicit
  position snaps to the nearest `…x9` cent ($12.29 from $12.34), not the nearest `…99` ($11.99).
  Sellers wanting the familiar `.99` ending set `charm_position: 1` explicitly.
- **The forgotten end date (Adversarial 7) loads.** The prose argument wants two open-ended,
  overlapping-forever windows to be `ERR_AMBIGUOUS_PRICE`, but the formal containment rule says
  otherwise: a later-starting, still-open window *is* a proper subset of a fully-open one —
  structurally identical to the `qty [1,10]` vs `qty [1,∞)` tiering case that must load. The
  containment rule was implemented as written; the later, narrower row wins from its start
  onward, which is arguably what a seller who forgot to close the old row wanted anyway. The
  genuine gap case still raises `ERR_WINDOW_GAP`.
- **`adjustment_start` / `adjustment_end` are parsed but not enforced.** They reach `ResolvedRow`
  and stop there; nothing consults them at quote time. A time-boxed discount authored through
  these columns never expires. Time-boxing an offer today means a separate price row with an
  effective window.
- **Two runtime clamps exist**, contrary to the "no clamping anywhere" claim the load-time proofs
  are supposed to earn: the pre-charm unit and the taxable amount are each floored at zero. They
  are unreachable if the load-time bounds hold, which makes them belt-and-braces rather than
  policy — but they are real code, and they would mask a bound that turned out to be wrong.
- **Only the charm floor is proven at load, not the ceiling.** The upper bound (every markup, no
  discount) is not checked against the amount limit.
- **Content-derived `price_id` omits `country_code`**, so two prices distinguished only by
  country share an identical `priceId` — and therefore identical derived tax and adjustment IDs.
  `LineQuote.priceId` is consequently not a unique reference into `config.prices`.
- **The catalog hash covers tax and adjustment values only through their derived IDs.** For
  author-supplied `tax_id`/`adjustment_id`, changing a rate or a tax behavior leaves the hash
  unchanged, which breaks the reproducibility guarantee for exactly the catalogs most likely to
  have durable external keys.
- **`ERR_WINDOW_GAP` detection is a best-effort slab sweep**, not the full per-region, per-slab
  algorithm the detection procedure describes.
- **The demo (`docs/index.html`) has never been verified in a real browser** — no headless
  tooling was available when it was written. It calls the same API the test suite exercises, and
  `docs/price-quotes.js` was smoke-tested under Node.

Proposals addressing several of these live in [`clarity.md`](./clarity.md).

## Tests

`npm test` builds and runs `node --test` against `dist/`. Coverage by file:

- **`csv.test.js`** — the CSV contract as positive and negative cases: BOM, CRLF, quoted commas,
  field-count mismatch, blank vs `""`, NBSP trimming, typographic characters, Excel date serials.
- **`constraints.test.js`** — each operator; AND across keys; OR-sets; relational-on-string
  errors; unknown-field errors with suggestions; cart-scoped keys rejected; a known field absent
  from the query failing its clause without throwing.
- **`compile.test.js`** — defaulting; identity agreement; content-derived IDs stable across a row
  shuffle (asserting a byte-identical `catalogHash` over several seeds); explicit `price_id`
  honored; row merging and its order-independence; duplicate detection.
- **`scenarios.test.js`** — every scenario and adversarial catalog above, each asserting its
  specific error code, plus the positive controls that must load. A rule this strict has to be
  shown not to reject legitimate catalogs, and the 2-D case (Scenario 16) is the one a naive
  implementation gets wrong.
- **`money.test.js`** — every row of the charm table; the reconciliation property
  (`salePrice × quantity === extendedSalePrice`) across quantities and charm modes and both
  exponent-0 and exponent-2 currencies; quantization modes and rounding increments; the
  rounding-order-independence cases; the safe-integer bounds; the known-hard regressions
  (unbounded-range comparison, inclusive-tax double-counting, half-cent float error,
  period-ratio off-by-one).
- **`cart.test.js`** — multi-line carts; an unpriceable line failing the whole cart with the line
  index named; the same cart at two `asOf` values spanning a window boundary; replay from
  `(catalogHash, asOf, lines)`; a benchmark asserting flat quote latency from 100 to 100,000
  price rows, which is the operational definition of goal #6.
