# Design: a CSV-catalog-driven quote engine

**Status:** proposed.

## Context

We're building a small TypeScript library that turns a spreadsheet-style product catalog into
priced quotes. A seller (often non-technical) maintains their catalog as a CSV or JSON list of
rows — one row per product/price/tax/discount fact — and the library compiles that into a
queryable catalog, then prices a cart of line items against it.

The driving scenario is domain-name sales, generalized to any product: a registrar wants to
list `.ng` at $10, `ok.ng` at $5, offer $8 for `.ng` transfers, and $15 for a 2-year `.ng`
registration instead of $16 — all as plain spreadsheet rows, with no code changes. But the
schema must be product-agnostic enough to describe software licences, services, or physical
goods with the same columns.

Two forces shape everything below. First, the person editing the catalog is not an engineer,
has no test suite, and will make mistakes that move money. Second, the engine sits in a
checkout path, so a quote must be fast enough that nobody thinks about it.

## Design goals

1. **Progressive disclosure.** The only required inputs are a product SKU and a price. Every
   other column (variants, quantity tiers, currency, tax, discounts) is optional and can be
   added later without breaking existing rows or requiring existing rows to be rewritten.
2. **Spreadsheet-native.** The catalog must round-trip through a CSV a non-engineer edits in
   Excel or Sheets — flat rows, not nested JSON. Structured fields (tag lists, key/value maps,
   constraints) still need to fit in a single cell, with defined escaping.
3. **Declarative, not programmable.** No callback functions in the catalog. Eligibility for a
   price, tax, or discount is expressed as data — a small, closed comparison grammar over a
   fixed field set — so the catalog is portable, auditable, and safely deserializable from
   untrusted spreadsheet input.
4. **Fail loudly at load, never silently at checkout.** An ambiguous, contradictory, or
   nonsensical catalog is an error thrown when the catalog is loaded, with every problem
   reported at once and located by row and column. The engine never picks a winner among
   competing prices, never clamps a value into range, and never repairs a cell it doesn't
   understand. A catalog that loads is a catalog that prices unambiguously.
5. **Whole classes of wrong answers impossible by construction.** A negative total, a
   mixed-currency cart, a discount exceeding the thing it discounts — these are not runtime
   checks that could be missed. They are excluded by the shape of the types and by load-time
   validation, so no code path exists that could produce them. See *Impossible states*.
6. **O(1) pricing.** Resolving a price is a bounded number of hash lookups and integer
   operations, independent of catalog size. No parsing, no regex, no `Date` construction, and
   no `Intl` construction happens at quote time — all of it is precomputed at load.
7. **Correct, reconcilable money math.** All amounts are integer minor units internally;
   currency is a first-class per-row attribute. Two independent mechanisms shape a number, and
   the design keeps them apart. **Quantization** is representation — how a value lands on the
   grid its currency can express — and applies wherever one must, under the row's mode: at load
   for the base amount, and at quote time after adjustments. **Charm** is pricing policy, and
   applies once, to the post-adjustment unit, so the discounted price the customer sees is a
   charm price too. Tax is the sole carve-out, rounding half away from zero regardless of the
   row, because it is not a pricing choice. Nothing rounds anywhere else: `unitMinor ×
   quantity` is exact integer math, so the unit price, the line subtotal and the total always
   reconcile.
8. **Reproducible.** A quote is a pure function of (catalog, cart, `asOf`). Nothing reads the
   clock implicitly. A quote records the catalog hash and `asOf` it was computed against, so it
   can be replayed from an audit log.

## Non-goals / constraints

- **No FX conversion.** The catalog carries currency-native prices; multi-currency support
  means "add a row for that currency," not "convert via an exchange rate." Every quoted amount
  traces to a catalog row a human typed.
- **No invoicing, payments, or subscription lifecycle.** No proration, no billing schedule, no
  concept of what a customer already owns.
- **No tax compliance logic.** It applies the tax rules the catalog hands it. It does not
  determine jurisdiction or validate tax IDs.
- **No persistence or catalog CRUD.** Rows are supplied in-memory on construction.
- **No cross-line pricing.** Every line prices independently of every other line. This is what
  keeps pricing a pure per-line function, keeps it O(1), and keeps cart-scoped constraints from
  becoming a fixpoint. Bundles are modeled as catalog entries, not as cart-scanning rules — see
  *Scenario 7*.
- **No savings/upsell insights.** A caller can compare quotes by calling the engine twice.

## Impossible states

Goal #5 deserves specifics, because "we validate that" and "that cannot be represented" are
very different guarantees. Each row below names the mechanism, not just the rule.

| Cannot happen | Mechanism |
| --- | --- |
| **A mixed-currency cart** | `currency` is a field of `CartRequest`, not of `CartLine`. There is no place to put a second currency. Prices are filtered by the cart's currency during resolution, so a line whose SKU has no row in that currency raises `ERR_NO_PRICE` rather than quietly pricing in another. |
| **A negative unit price** | `price_amount < 0` is a load error. `Money` is a branded integer type whose only constructor rejects negatives, so a negative can't be constructed downstream either. |
| **A charm-snapped price that goes negative** | Charm runs at quote time (it applies after discounts), but its inputs are load-time *bounded*: the unit-price floor is `base` with every discount and no markup applied. Compilation validates `charm(floor) ≥ 0`, so `$0.02` with `to9` at position 1 — which would snap to `−$0.01` — is a load error telling the seller to lower `charm_position`, not a runtime surprise. Charm is defined as the identity at zero, so a fully discounted line stays free. |
| **A discount larger than what it discounts** | The quantized base unit is known at load, so an `amount` discount can be compared against `base × min_quantity` and rejected. A `rate` discount above `1.0`, or a set of stackable rate discounts summing above `1.0`, is likewise a load error. No runtime clamp exists, because nothing can reach it. |
| **A negative line or cart total** | Follows from the above: unit ≥ 0, quantity ≥ 1, discounts ≤ subtotal by load-time proof, fees/markups ≥ 0 by validation, tax rates in `[0, 1]`. Every term is non-negative or bounded, so the sum is non-negative. A zero total is legal (100% discount, free tier); a negative one is unreachable. |
| **Two prices competing for one query** | Load-time ambiguity detection (see *Price resolution*). If two rows' match regions intersect and neither region contains the other, the catalog does not load. |
| **A quantity of zero, a fraction, or a negative** | `quantity` is a branded positive integer validated at the API boundary. |
| **A price effective window that ends before it starts** | Load error. |
| **A quote that silently used "now"** | `asOf` is resolved once at the top of `quoteCart` and recorded on the result. Nothing below it can call `Date.now()` — the resolution and constraint code receives an epoch integer, not a clock. |

The general principle: **push every check as early as possible.** A check at load time runs
once against data a human can still edit. The same check at quote time runs on every request
against data nobody is looking at.

## Data model

A **`CatalogRow`** is the unit of authoring: one flat record combining a product fact, a price
fact, and optionally a tax fact and an adjustment (discount/markup/fee) fact. Only fields that
differ from catalog-wide defaults need to be filled in.

```ts
interface CatalogRow {
  // product — identity fields; must agree across all rows sharing a SKU
  product_sku: string;
  product_aliases: string[];                   // cell: "ng;.ng" — declarative SKU normalization
  product_name: string;
  product_description: string;
  product_status: "active" | "inactive";
  product_family: string;
  product_category: string;
  product_type: string;
  product_features: Record<string, string>;    // cell: "k1=v1;k2=v2" — descriptive, not a price axis
  product_tags: string[];                      // cell: "s1;s2"
  created_at: string;
  updated_at: string;
  created_by: string;

  // price
  price_id: string;                            // blank => content-derived, see Compilation
  price_amount: number;                        // major units, "." decimal, no group separators
  product_variant: string;                     // a price axis; blank = wildcard
  price_effective_start: string;               // ISO 8601; blank = open
  price_effective_end: string | null;          // exclusive bound; blank = open
  min_quantity: number;                        // default 1
  max_quantity: number | null;                 // blank = unbounded
  currency: string;                            // ISO 4217
  currency_symbol: string;
  currency_separator: string;
  country_code: string;                        // ISO 3166-1 alpha-2; blank = wildcard
  locale: string;
  quantization: "nearest" | "floor" | "ceil";  // how values land on the currency grid, at load
                                               // and after adjustments; default "nearest"
  charm: "none" | "to4" | "to9";               // pricing policy on the post-adjustment unit;
                                               // default "none"; needs a rounding increment of 1
  charm_position: number;                      // digit index in minor units; default max(0, exponent-1)
  frequency: "one-time" | "recurring";         // default "one-time"
  frequency_interval: ("month" | "year") | null;

  // tax
  tax_id: string;
  tax_label: string;
  tax_rate: number;                            // fraction in [0, 1], not a percentage
  tax_behavior: "inclusive" | "exclusive" | "unspecified";
  tax_compound: boolean;                       // default false: additive on the same base
  tax_constraints: string;                     // constraint grammar, see below

  // adjustment (discount | markup | fee)
  adjustment_id: string;
  adjustment_kind: "discount" | "markup" | "fee";
  adjustment_label: string;
  adjustment_type: "rate" | "amount";
  adjustment_basis: "unit" | "line";           // default "line"; only meaningful for "amount"
  adjustment_value: number;                    // rate: fraction in [0, 1]. amount: major units, >= 0
  adjustment_start: string;
  adjustment_end: string | null;
  adjustment_stackable: boolean;
  adjustment_constraints: string;
}
```

Two placements are deliberate and worth stating, because they answer questions that come up
immediately:

- **`product_variant` is a price axis, not product identity.** It selects *which price
  applies*, not *which product this is*. `.ng` with variant `transfer` is the same product at a
  different price. Product identity is exactly the first block, and only those fields are
  subject to the cross-row agreement rule.
- **`product_features` is descriptive, not selective.** It exists so a catalog can carry
  "supports DNSSEC" for display and filtering. It does **not** participate in price
  resolution — see *Scenario 7* for why, and for what to use instead.

Rows compile into a normalized, relational **`CatalogConfig`** — the shape the query engine
runs against:

```ts
interface CatalogConfig {
  products: Product[];
  prices: Price[];        // each carries a precomputed baseUnitMinor and its taxes/adjustments inline
  index: PriceIndex;      // the O(1) lookup structure, built at load
  hash: string;           // content hash, for quote reproducibility
}
```

## The CSV contract

The schema declares `price_amount: number`, but a CSV cell is text. Every gap between the two
is a way for a seller to mis-price a product silently, so all of it is specified. Violations
are load errors, never coercions.

- **Encoding and line endings.** A UTF-8 BOM is stripped. `LF`, `CRLF` and mixed endings all
  parse. Quoting is RFC 4180, so a cell containing a comma needs only the CSV quotes.
- **Headers** are matched case-insensitively after trimming and collapsing `-` and space to
  `_`. A duplicate header is an error. An unrecognized header is an error naming the column and
  its nearest known match, because the overwhelmingly likely cause is a typo in a column that
  was supposed to set a price (`price_ammount`), and ignoring it prices the product wrong.
- **Row shape.** Every row must have exactly as many fields as the header. A short or long row
  is an error quoting the row — this is the signal that catches an unquoted decimal comma or
  thousands separator, which shifts every subsequent column by one.
- **Blank vs empty.** A cell containing nothing inherits the catalog default. A cell containing
  `""` (two quote characters) sets the field to the empty string. This is the only way to clear
  a default. A row where *every* cell is blank is skipped (Excel leaves these behind); a row
  where only some are blank is a real row.
- **Whitespace.** Leading and trailing whitespace is trimmed from every cell, and a
  non-breaking space (`U+00A0`, which Excel and web pastes produce freely) is treated as
  whitespace for trimming. Interior whitespace is preserved verbatim. Trimming is the one
  permitted normalization: it cannot change a number's value or an identifier's meaning, and
  not doing it makes `"US "` silently fail to match `"US"`.
- **Numbers.** `price_amount` and `adjustment_value` (when `amount`) are **major units**: `.`
  as the decimal separator, no group separators, no currency symbols. `12.34` — never `12,34`,
  `$12.34`, or `1,234`. Rates (`tax_rate`, `adjustment_value` when `rate`) are **fractions in
  `[0, 1]`**; `7.5` is an error suggesting `0.075`, because a 750% tax is never what anyone
  meant. More decimal places than the currency supports is an error, not a silent round.
- **Booleans** accept `true`/`false`/`yes`/`no`/`1`/`0`, case-insensitive. Anything else errors.
- **Dates** are ISO 8601. A date-only value is UTC midnight. `_end` bounds are **exclusive**.
  A bare integer is an error naming Excel's date serial format, because that is what it is.
- **Currency codes** are validated by constructing an `Intl.NumberFormat` at load; an invalid
  code throws `RangeError`, which becomes a located error.
- **Escaping inside cells.** `;` and `=` are structural in list, map and constraint cells, as
  are `..`, `>=`, `<=`, `!=`, `>`, `<` at the start of a constraint value. A literal is escaped
  with a backslash (`\;`, `\=`, `\>`). Typographic quotes and dashes (`“ ” ‘ ’ –`), which Excel
  autocorrect inserts, are errors inside structured cells rather than being silently accepted
  as content.

## Constraint grammar

Tax and adjustment eligibility is a closed comparison grammar. It is inert data: a cell parses
into a small tagged struct at load, evaluates by fixed dispatch over a fixed field set, and
never reaches `eval` or a callback — goal #3 holds. Equality alone cannot express what sellers
actually ask for ("10% off orders over $100", "EU only", "any tier but free").

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
  numeric; the rest are strings. A relational operator on a string field is a load error, not a
  silent lexicographic comparison — `country_code >= US` is meaningless and must say so.
- **An unknown field is a load error** naming the key and its nearest match, so `contry_code`
  fails loudly rather than never matching.
- **A constraint cell on a price row is an error.** Prices select by their own columns
  (`product_variant`, `min_quantity`, `country_code`); a seller who writes
  `quantity=>=10` where they meant `min_quantity` gets told so.
- **Cart-scoped keys** (`cart_subtotal`, `cart_quantity`, `cart_line_count`) are *recognized
  and rejected* with a dedicated error. They are reserved deliberately: a cart-level threshold
  would make one line's price depend on the others, breaking per-line independence and O(1)
  pricing. Reserving them makes cart-scoped pricing a future feature rather than a format
  migration.

## Catalog compilation

`loadCatalog(input, defaults): CatalogConfig` — returns a config or **throws**. There is no
partial success and no warning channel.

Diagnostics are **collected, then thrown together** as a single `CatalogError` carrying every
problem with its row, column, and offending value. Collecting is about ergonomics — a
200-row sheet with eight bad cells should report eight, not the first — and throwing is about
safety. Those are not in tension: the seller gets one complete list, and no half-valid catalog
ever reaches a checkout.

There is deliberately **no lenient mode**. An escape hatch for "just price it anyway" is a
feature request from the person who is about to lose money.

1. **Parse and validate cells** against the CSV contract above.
2. **Require the minimum.** Every row needs `product_sku` and a parseable `price_amount`
   (goal #1). Every other field is optional.
3. **Default, don't inherit.** A blank cell is filled from a single catalog-wide
   `CatalogDefaults` object — never from another row. This is what keeps a row's meaning
   independent of file order.
4. **Product identity must agree.** Projecting a `Product` from the first row a SKU appears in
   would reintroduce the order-dependence step 3 removes: re-sort the sheet and the compiled
   product changes. Instead, non-blank product-identity cells must **agree** across all rows
   sharing a SKU; blanks defer to defaults. A disagreement is an error naming both row numbers
   and both values.
5. **Content-derived IDs.** A blank `price_id` is synthesized as a readable composite —
   `sku:currency:variant:minqty:maxqty:frequency:start` — not `sku:rowIndex`. Row indices shift
   the moment a seller inserts a row or re-sorts, silently re-pointing external references and
   making quotes irreproducible across catalog edits. `tax_id` and `adjustment_id` derive from
   their `price_id` plus their own discriminating fields.

   Content-derived IDs are stable under reordering but **not** under editing: changing a row's
   variant changes its ID. They are correct as internal join keys and wrong as durable external
   keys. A seller needing a durable key authors `price_id` explicitly and it is honored
   verbatim.
6. **Merge rows that describe the same price.** This step is what makes the flat schema work
   at all, and it must happen *before* ambiguity checking.

   A row carries at most one tax fact and one adjustment fact, so a price with a discount *and*
   a fee is authored as two rows that repeat the price:

   ```csv
   product_sku,price_amount,adjustment_kind,adjustment_type,adjustment_value,adjustment_label
   .ng,10.00,discount,rate,0.10,Launch offer
   .ng,10.00,fee,amount,1.50,ICANN fee
   ```

   Those two rows are **one price with two adjustments**, not two competing prices. Define the
   **price key** as every price-block field — `sku`, `currency`, `variant`, quantity bounds,
   effective window, `frequency`/`frequency_interval`, `price_amount`, `quantization`, `charm`,
   `charm_position` — plus the product identity fields. Then:

   - Rows with the **same price key** are the same price. Their tax and adjustment facts are
     unioned onto it. A row contributing no tax or adjustment fact is simply redundant and adds
     nothing (this is the Excel copy-paste case).
   - Rows with the **same region but a different price key** — most importantly a different
     `price_amount` — are competing prices, and fail the ambiguity check in step 8.
   - Two rows carrying the *identical* tax or adjustment fact (same derived ID) under one price
     is a duplicate: an error, not a silent double-application. A discount applied twice
     because a row was pasted twice is exactly the class of mistake this design exists to
     catch.
   - Explicitly authored `price_id`s participate: two rows sharing an authored `price_id` must
     agree on every other price-block field, or `ERR_PRICE_ID_CONFLICT`. Two rows with
     different authored `price_id`s and the same region compete, and fail step 8 normally.

   The merge is order-independent — it is a group-by on a key, and the resulting adjustment
   list is sorted by derived ID, not by row order — so it preserves the property from step 3.
7. **Quantize at load.** Each price's `baseUnitMinor` is computed once, at load: parse →
   quantize onto the currency's grid. This depends only on the row and its currency, never on
   the query. Charm snapping does *not* happen here — see step 8 and *Line computation*. Also
   check `charm` against the currency's rounding increment: the two are unsatisfiable together
   (*Charm*), so a non-`none` charm on a currency with an increment other than 1 is
   `ERR_CHARM_INCREMENT_CONFLICT`.
8. **Validate the merged taxes and adjustments, and bound the unit price.** Constraints are
   parsed into structs. Then, with `baseUnitMinor` known and the full adjustment set assembled
   by step 6:
   - Stackable rate discounts on one price must sum to `≤ 1.0`.
   - An `amount` discount must be `≤ baseUnitMinor × min_quantity` (the smallest line it could
     apply to).
   - `markup` and `fee` values must be `≥ 0`. A negative fee is a discount; say so.
   - Mixing `adjustment_type` among stackable adjustments on one price is an error — the order
     `rate` and `amount` would combine in is ambiguous, and a spreadsheet author has no way to
     specify it. Make one non-stackable, or split into separate prices.
   - **Compute the unit-price floor and ceiling.** Because charm now runs at quote time on a
     value that depends on which adjustments matched, its result is no longer a load-time
     constant. But it is still load-time *bounded*: the worst case applies every discount and
     no markup, the best case the reverse, and both sets are known from the row. Validate
     `charm(floor) ≥ 0` and that `ceiling` is within the amount bound. This preserves the
     load-time guarantee against charm underflow (*Impossible states*) without requiring the
     exact value — the seller still learns at load that their $0.02 add-on can snap negative.
9. **Prove unambiguity and build the index.** See below. This is where competing prices,
   overlapping regions, and coverage gaps are caught.

### Products, aliases and status

- **`product_aliases`** compile into a single alias → SKU map. An alias that collides with
  another product's SKU, or with an alias another product claims, is `ERR_ALIAS_CONFLICT`
  naming both products — silently resolving it would route a customer to the wrong product.
  A product may alias its own SKU; that is a harmless no-op, not a conflict.
- **`product_status: inactive`** excludes the product's prices from the index entirely. A query
  for an inactive SKU raises `ERR_UNKNOWN_SKU`, not `ERR_NO_PRICE` — from a pricing
  perspective the product does not exist, and reporting it as "known but unpriceable" invites
  a caller to retry differently. The product still appears in `config.products` with its status,
  so a catalog browser can show it as unavailable. Its rows are still fully validated: a
  product deactivated to work around a load error must still be a valid product, or the error
  reappears the moment it is switched back on.

### The catalog hash

`config.hash` identifies exactly the inputs that can change a quote, and must be reproducible
across processes and row orderings. It is a SHA-256 over a canonical serialization:

1. Take the **compiled** entities, not the source rows — post-default, post-merge, post-money
   resolution. Two catalogs that differ only in row order, blank-vs-defaulted cells, or
   redundant duplicate rows are the same catalog and must hash identically.
2. Serialize each price as a fixed-order tuple of its price key, `baseUnitMinor`, and its sorted
   tax and adjustment IDs; each tax and adjustment as a fixed-order tuple of its own fields
   with constraints in canonical form (keys sorted, OR-set members sorted); each product as its
   identity fields plus sorted aliases.
3. Sort the serialized entities by ID, join with a delimiter that cannot appear in the encoding,
   and hash.

Excluded deliberately: `created_at`/`updated_at`/`created_by`, `product_description`,
`currency_symbol` and `locale`. These are presentation and provenance — they cannot change a
computed amount, and including them would make a quote irreproducible after a typo fix in a
description. `product_name` is also excluded; the hash answers "would this catalog price this
cart the same way," not "is this the same file."

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

Three axis kinds, and the distinction drives everything downstream. **Exact** axes are always a
single value and partition the catalog — they can never overlap, so they are pure bucket key.
**Wildcard-capable** axes admit a strictly-containing region, which is what makes overrides
expressible, and are the only axes that require multi-key probing. **Interval** axes are ordered
and admit partial overlap, which is what makes tiers expressible and gaps possible.

The **billing period** axis is exact, not wildcard-capable: `frequency` defaults to `one-time`
and is never blank, so there is no "applies to both" region. `frequency` and
`frequency_interval` are one axis, normalized to a single token at load — `recurring` without an
interval, or `one-time` with one, is `ERR_INVALID_FREQUENCY`. This keeps the wildcard-capable
axis count at two, which is what bounds the probe sequence below.

A price **matches** a query when the query point falls inside the region on every axis.
Row `A` **dominates** row `B` when `A`'s region is contained in `B`'s on every axis and
strictly smaller on at least one. Dominance is the formal version of "more specific."

### Ambiguity is a load-time error

> **Rule.** If two rows' regions intersect and neither dominates the other, the catalog does
> not load.

One rule does the work that would otherwise need three: a specificity ladder ordering the axes
against each other, an overlap scan warning about duplicates, and a tie-break for whatever the
first two failed to decide. It is also stricter than all three, since each of those exists to
let an ambiguous catalog ship.

The tie-break is the important removal. "Lowest price wins" mirrors spreadsheet intuition, but
as an unconditional silent rule it means a missing zero — `5` typed for `50` — becomes the
authoritative price and nothing surfaces. The competing rows are visible in the sheet at load
time. There is no reason to defer the decision to a checkout, and no version of "the engine
guessed" that is better than "the catalog didn't load."

Worked through the cases:

- `variant=* / $10` vs `variant=transfer / $8` → the second's region is strictly inside the
  first's on the variant axis and equal elsewhere, so it dominates. **Loads.** A query for
  `transfer` gets $8; anything else gets $10. Deliberate override, correctly expressed.
- `qty [1,10]` vs `qty [1,∞)` → the first dominates. **Loads.** Tiered pricing works.
- `qty [1,10] / $16` vs `qty [5,20] / $15` → regions intersect at `[5,10]`, neither contains
  the other. **Error**, naming both rows and the overlapping range. The seller meant `[1,4]`
  and `[5,20]`, and now knows it.
- `variant=transfer, country=*` vs `variant=*, country=NG` → both match a `(transfer, NG)`
  query; neither dominates. **Error.** This is the case a specificity ladder would have decided
  by fiat — "variant outranks country" — for a seller who never made that decision. The fix is
  to add an explicit `(transfer, NG)` row, which is what they meant.
- Two rows with the same region and the same price key → **not** two prices. Compilation step 6
  already merged them into one price carrying both rows' tax and adjustment facts, so nothing
  reaches this check. This is how a price gets more than one adjustment, and it is why the
  merge must run first. Identical regions with a **different price key** — a different
  `price_amount`, `charm`, or `quantization` — are competing prices, and error.
- **Coverage gaps.** `qty [1,10]` and `qty [20,∞)` don't intersect, so the dominance rule is
  silent. But quantity 15 is then unpriceable, which is a typo far more often than a policy.
  A gap in the interior of a SKU's covered quantity range is an error; an open ceiling
  (`[1,10]` and nothing above) is fine, and a query for 11 raises `ERR_NO_PRICE` at runtime.
  The same applies to effective windows: a gap between a price ending and its replacement
  starting is an error, because it is a period during which the product cannot be sold.

### The detection algorithm

Two traps make the naive version wrong, and both are worth naming because the obvious
implementation falls into them.

**Trap one: the check is not per-bucket.** The crossed-axes case above —
`(transfer, *)` against `(*, NG)` — is precisely a pair that lands in two *different* buckets.
Any algorithm that only compares rows sharing a bucket key will miss the case this rule exists
to catch.

**Trap two: the region is two-dimensional.** Quantity and effective window are independent
interval axes, so overlap is rectangle intersection, not interval intersection. Sorting by
quantity lower bound and comparing neighbours reports a false conflict for two rows that
overlap in quantity but sit in disjoint time windows — a mid-tier price change, which is
legitimate and common.

The correct procedure, run per `(sku, currency, billing period)` group — call its row count
*m*, which is small (single digits for almost every product):

1. **Pairwise wildcard-axis screen.** For each pair, compare the `variant` and `country`
   regions. Skip the pair if either axis is disjoint (two different exact values). Otherwise
   record the pair's *wildcard relation*: `A ⊂ B`, `B ⊂ A`, `equal`, or **`incomparable`** —
   the last being the crossed-axes case, where each row is exact on an axis the other
   wildcards. `O(m²)`, cheap.
2. **Rectangle intersection on the interval axes.** For each surviving pair, test whether the
   quantity intervals overlap *and* the effective windows overlap. Both must overlap for the
   regions to intersect at all.
3. **Verdict per intersecting pair.** If the wildcard relation is `incomparable` →
   `ERR_AMBIGUOUS_PRICE`. If it is `equal`, then dominance must come from the interval axes:
   one rectangle must contain the other, otherwise → `ERR_AMBIGUOUS_PRICE`. If it is `A ⊂ B`,
   then `A` must be at least as small on the interval axes too — a row that is more specific on
   variant but *wider* on quantity is incomparable, and errors.
4. **Coverage, per time slab.** Gap detection is only meaningful at fixed points on the other
   axes, so sweep: collect every effective-window boundary in the group, forming slabs between
   consecutive boundaries. Within each slab, for each distinct wildcard-axis region, sort the
   active quantity intervals and walk them. An interior gap → `ERR_QUANTITY_GAP`, naming the
   uncovered range and the date slab. Slabs with no rows at all, sitting between slabs that
   have them, → `ERR_WINDOW_GAP`.

   Coverage is checked *upward from the lowest `min_quantity` present*, not from 1. A catalog
   whose cheapest tier starts at 5 has an open floor, which is a legitimate minimum order
   quantity; a query for 3 raises `ERR_NO_PRICE`. Only a hole *between* two populated tiers is
   an error, since that is a typo rather than a policy.

Cost is `O(m² + s·m log m)` per group with *s* slabs, and `O(n log n)` overall to form the
groups. The `m²` term is on rows sharing a SKU, currency and billing period — not on the
catalog — so a 100,000-row catalog with a dozen rows per product validates in linear time
plus a rounding error.

### The index, and why lookup is O(1)

Because the catalog is proven unambiguous at load, the set of rows matching any query is a
**chain** under dominance — the winner is simply the most specific one, and the first hit in a
fixed probe order *is* that winner. No sorting, no comparison, no scan.

The index is a hash map:

```
key   = sku ‖ currency ‖ billingPeriod ‖ variant ‖ country     // "*" for a wildcard axis
value = PriceBucket { bands: Band[] }   // quantity × window rectangles, sorted by min_quantity
```

Resolution:

1. **Normalize the SKU** — one map lookup against the alias table. `O(1)`.
2. **Probe the index** along the *specificity lattice* of the two wildcard-capable axes, most
   specific first:

   ```
   (variant, country) → (variant, *) → (*, country) → (*, *)
   ```

   First hit wins. Four probes maximum; fewer when the query omits an axis, since `(variant, *)`
   and `(*, *)` are the only candidates when no country is supplied.

   **Why first-hit is correct, and why the middle two may be probed in either order.** If
   `(variant, country)` hits, that row's region is contained in every other candidate's, so it
   dominates them all — no further probe can produce a better answer. If it misses, at most one
   of `(variant, *)` and `(*, country)` can hit for this query: those two regions are
   incomparable, and step 3 of the detection algorithm rejects any catalog in which two
   incomparable regions intersect. So they cannot both contain the query point, and the order
   between them is arbitrary — it is fixed only for reproducibility of the audit trail, not for
   correctness. The load-time invariant is what buys the O(1); without it this would be a scan
   and a sort.

   The probe count is `2^w` where *w* is the number of wildcard-capable axes — a compile-time
   constant, independent of catalog size. Adding a third such axis would double it to 8, which
   is the concrete cost of that decision and the reason `product_features` stays out of
   resolution (*Scenario 7*).
3. **Select the band** within the bucket: the first band whose quantity interval contains the
   quantity *and* whose window contains `asOf`. Bands are non-overlapping rectangles, so at
   most one matches. Buckets hold 1–3 bands in practice, so a linear scan is a handful of
   integer comparisons; if a catalog has many tiers, binary-search the quantity axis first.
   Effectively `O(1)`, formally `O(log b)` in the number of tiers on one price point. No match
   → `ERR_NO_PRICE`, which is reachable only through an open floor or open ceiling, since
   interior gaps were rejected at load.
4. **Read `baseUnitMinor`** — already an integer on the `Price`, quantized at load. Zero work.
5. **Apply unit adjustments, charm, then multiply** by quantity. Integer arithmetic only: one
   multiply-and-round for the combined rate, then charm (a divmod and two comparisons), then
   one multiply. Charm is the only step that moved out of load time, and it allocates nothing.
6. **Apply adjustments and taxes**, which hang inline off the resolved `Price` — no second
   lookup, no join. Cost is `O(a + t)` in the number of adjustments and taxes *on that one
   price*, typically 0–3 total, with pre-parsed constraint structs evaluated by fixed dispatch.

Per line: at most five hash lookups (one alias, four probes) and a few dozen integer
operations, with a bounded, catalog-size-independent constant. The dominant remaining cost is
hashing the probe keys.

### What is precomputed, and why it matters more than the lookup

The lookup was never going to be the bottleneck. These are:

| Work | Naive placement | Here |
| --- | --- | --- |
| Parsing `price_amount` text | per quote | load |
| Quantizing to `baseUnitMinor` | per quote | load |
| Charm snapping | — | quote, by necessity: it applies after query-dependent discounts. Pure integer work, no allocation |
| Parsing constraint cells | per quote | load |
| Parsing ISO dates | per quote | load — windows are epoch integers, compared as integers |
| Currency exponent lookup | per quote | load |
| `Intl.NumberFormat` construction | per format call | cached per `(currency, locale)` — constructing one costs microseconds and would dominate the entire quote |
| Joining taxes/adjustments by `price_id` | per quote | load — attached inline |
| Alias resolution | string munging per quote | load — a map |

The rule the implementation should hold to: **at quote time, no string is parsed, no regex is
run, no `Date` is constructed, and no `Intl` object is created.** Everything is integer
arithmetic over precomputed structures.

Two optional refinements, neither needed for correctness:

- **Interned keys.** Probe keys are built by string concatenation, which allocates. Interning
  sku/variant/country to small integers at load and packing the key into a single number
  removes the allocation. Worth doing only if profiling says so.
- **Memoization.** An LRU keyed on the full query tuple helps when a page prices the same
  product repeatedly (a TLD search results page). It must be keyed on `asOf` too, or it
  silently breaks reproducibility.

## Money

Two mechanisms live here, and they are **not** a pair. Quantization is a *representation* rule
— how any value lands on the grid of amounts this currency can express. Charm is a *pricing
policy* — which of those representable amounts looks good on a page. A catalog with
`charm: none` still quantizes; a currency with no rounding increment still charms. Conflating
them is the mistake that makes people expect one to move when the other does.

### Quantization — representation

`quantization` converts a value into a minor-unit integer lying on the currency's grid, defined
by its exponent and optional rounding increment. `nearest` (half away from zero, the default),
`floor`, or `ceil`. Float representation error is corrected before rounding: `79.8 × 0.075` is
exactly `5.985` but floats give `5.984999…`, and quantizing that down is a real bug that a
naive implementation reintroduces every time.

It applies **wherever a value must become representable**, which is two places:

1. **At load**, converting `price_amount` into `baseUnitMinor`.
2. **At quote time**, after the combined rate multiply, before charm — because
   `1234 × 0.90 = 1110.6` is not a representable amount either.

The same row-level mode governs both. A seller who sets `floor` means "never round up against
the customer," and that intent applies at least as much to the discounted price as to the
base — applying their mode at load and a hardcoded one at quote would put the configurable
knob where nothing is at stake and a fixed rule where the money is.

**A note for implementers, so nobody expects load-time quantization to do work it doesn't.**
Because more decimal places than the currency supports is a load *error* rather than a silent
round (*The CSV contract*), `12.34 × 100 = 1234` is exact and the mode never fires. At load,
quantization only does something real when the currency has a **rounding increment** — CHF at
0.05, where `12.34` snaps to `12.35`. For every currency without one, load-time quantization is
an exact scale-up and the mode is moot. It earns its configurability at quote time.

Tax rounding is explicitly *not* governed by this. See *Arithmetic rounding*.

### Charm — pricing policy

**Charm snapping** applies to the **unit** amount only, never to a line total, and runs **at
quote time**, after markup and discounts (*Line computation*). Two constraints pin it there.
It must come after adjustments, because a discounted price is a price the customer sees and it
should end in `.99` too — snapping the base and then discounting produces $10.79, which is
what `to9` exists to prevent. And it must come before the quantity multiply, because `to9` on a
line total is incoherent: a $9.99 unit at quantity 3 gives $29.97, snapped to $29.99, which is
not a charm price and no longer equals unit × quantity. Applying it after tax is worse still —
the unit price, the subtotal and the total become three mutually inconsistent numbers on one
invoice. Charmed unit, then exact multiply, is the only ordering where every displayed figure
reconciles *and* every displayed price is a charm price.

A charm candidate is a minor-unit integer whose digit at `charm_position` *p* is the charm
digit *d* (4 or 9) and whose lower digits are all 9:

```
candidate(k) = k·10^(p+1) + d·10^p + (10^p − 1)
```

The result is the **nearest** candidate — not the next one upward. "Round up to the next value
ending in 9" maps $12.00 to $12.09, where every seller means $11.99. Ties resolve **downward**;
charm pricing exists to look cheaper. `charm_position` defaults to `max(0, exponent − 1)`.

| Input | Currency | Behavior | *p* | Candidates | Result |
| --- | --- | --- | --- | --- | --- |
| $12.34 | USD (exp 2) | `to9` | 1 (default) | $11.99, $12.99 | **$11.99** |
| $12.34 | USD | `to9` | 0 | 1229, 1239 | **$12.29** (tie → down) |
| $12.34 | USD | `to4` | 1 | $11.49, $12.49 | **$12.49** |
| $12.00 | USD | `to9` | 1 | $11.99, $12.99 | **$11.99** |
| ₦15,943 | NGN (exp 0) | `to9` | 2 | ₦14,999, ₦15,999 | **₦15,999** |
| $0.02 | USD | `to9` | 1 | −$0.01, $0.99 | **load error** |

The last row is why compilation bounds the unit price rather than merely quantizing it: the
nearest candidate to 2 minor units is −1, and a negative price must be impossible rather than
merely unlikely. Since charm now runs at quote time, the check is applied to the load-time
*floor* — the unit with every discount and no markup — so the seller still learns at load, and
is told to set `charm_position: 0` or `charm: none`. `charm(0) = 0` by definition, so a fully
discounted line stays free instead of snapping.

**Charm and rounding increments are mutually unsatisfiable**, and the combination is a load
error (`ERR_CHARM_INCREMENT_CONFLICT`). An increment of 0.05 means every representable amount
ends in 0 or 5; charm candidates end in 4 or 9 by construction. No value satisfies both — CHF
with `charm: to9` describes a price that cannot exist, so whichever operation ran last would
silently win. `charm != none` therefore requires an increment of 1. This is the one place the
two mechanisms interact at all, and the interaction is a contradiction rather than an ordering
question.

### Arithmetic rounding (at quote time)

Rates produce fractions of a minor unit, so rounding at quote time is unavoidable. What *is*
avoidable is leaving it implicit — the choice of where to round changes totals, so the points
are enumerated and the mode is fixed.

Two modes, split by whether the value is a *price* (the seller's call) or a *tax* (not).

- **Adjustment results use the row's `quantization` mode** — the same rule that landed the base
  amount on the currency's grid, since these values need to land on it for the same reason.
- **Tax results use half away from zero, always**, with float representation error corrected
  first. Not configurable: letting a seller pick a tax-rounding mode is an invitation to a
  compliance problem, and a tax authority is not interested in the catalog's charm strategy.

**The four points**, and nowhere else:

1. **The combined unit rate, applied once**, to `baseUnitMinor`, quantized with the row's mode.
   All rate adjustments — markup, fee and discount alike — are summed *as exact rates first*
   into a single net factor `(1 + Σmarkup + Σfee − Σdiscount)`, multiplied, and quantized once.
   Quantizing each adjustment separately and summing makes the total depend on the order they
   are visited: two 5% discounts on 999 minor units give `50 + 50 = 100` applied separately but
   `round(999 × 0.10) = 100` combined, and at other values they diverge. One base and one
   quantization is order-independent, which goal #4 requires. Charm then snaps this result.
2. **Each `amount` adjustment**, which is already an integer after load-time quantization —
   multiplied by quantity when `adjustment_basis` is `unit`, applied once to the line when it
   is `line`. Exact.
3. **Each tax line, individually**, against its own base, half away from zero. Taxes round per
   line rather than on the summed rate because they are itemized on invoices and each line must
   reconcile on its own. This differs deliberately from adjustments, which are not separately
   itemized and which follow the row's mode.
4. **The inclusive-tax extraction**, `gross − round(gross ÷ (1 + rate))`, computed on the
   post-adjustment gross, half away from zero.

Note that point 1 lands *before* charm, so for a row with `charm` set, the snapping usually
subsumes the quantization entirely — the mode matters most for the default `charm: none`,
which is exactly where a seller's `floor`/`ceil` intent has nothing else to express it.

Every other operation — `unitMinor × quantity`, summing line totals into a group total,
summing groups into `dueNow` — is exact integer addition and multiplication with no rounding.
Because rounding only ever happens on a rate application, and each line's components are
integers that were rounded when produced, the invariant holds: displayed components always sum
to the displayed total.

**Bounds.** All monetary values are integer minor units held in JavaScript numbers, valid to
`Number.MAX_SAFE_INTEGER`. A `unitMinor × quantity` product exceeding it is
`ERR_AMOUNT_OVERFLOW` at quote time, and a `baseUnitMinor` exceeding `2^40` is a load error —
about ₦1.1 trillion, comfortably above any real price and comfortably below the point where
intermediate products lose precision.

### Currency metadata

`CurrencyMeta` is optional. The minor-unit exponent derives from
`Intl.NumberFormat(locale, { style: "currency", currency: code }).resolvedOptions()
.maximumFractionDigits`, which also gives free code validation. Two things the derivation does
not cover, which is why the override stays: `Intl` supplies no rounding increment, so cash
rounding (CHF at 0.05) must be authored; and a symbol from `formatToParts` is locale-dependent
— a guess about the reader rather than a fact about the currency — so `currency_symbol` remains
authored data.

## Line computation

The pipeline order is fixed:

```
[load]  parse → quantize                                   ⇒ baseUnitMinor
[quote] baseUnitMinor → unit adjustments → charm           ⇒ unitMinor
        unitMinor × quantity → line adjustments → tax
```

**Charm is applied last among the things that shape the unit price** — after markup and after
discounts. A discounted price is still a price the customer sees, and a seller who asked for
endings in `.99` means the number on the page, not an internal base that markup and discount
then destroy. A 20% reseller markup on $12.34 must produce $14.99, not $14.39.

This is why charm cannot be a load-time operation: discounts are query-dependent (constraints,
quantity band, effective window), so the value being snapped isn't known until the query is.
The cost is small and does not breach goal #6 — charm is a divmod and two comparisons on
integers, with no parsing, allocation, or `Intl` involved. Quantization stays at load, where it
belongs, and the charm *bounds* are still proven at load (compilation step 8).

**Unit-scoped versus line-scoped adjustments.** Everything that can be expressed per unit is
applied per unit, before charm:

- `rate` adjustments of every kind (`markup`, `discount`, `fee`) apply to the unit.
- `amount` adjustments with `adjustment_basis: unit` apply to the unit.
- `amount` adjustments with `adjustment_basis: line` (the default) are inherently line-scoped —
  a $5-off-the-order coupon cannot be pushed onto a unit without dividing by quantity, which
  would break integer exactness. These apply **after** charm, to the line total. A coupon does
  not produce a charm-priced line, and nobody expects it to.

**All rate adjustments share one base**, the pre-adjustment unit amount, and combine additively:

```
adjustedUnit = baseUnit × (1 + Σmarkup + Σfee − Σdiscount)
unitMinor    = charm(round(adjustedUnit))
```

They are *not* applied sequentially. Sequential application makes the result depend on the
order the kinds are visited — a 10% markup then a 10% discount is not a 10% discount then a 10%
markup — and a spreadsheet author has no way to express an intended order. A common base is
commutative, which is what goal #4 requires. Within a kind, stackable rows sum and
non-stackable rows compete, the single most-favorable-to-the-buyer one winning per kind
(largest discount, smallest fee/markup).

**Charm of zero is zero.** A fully discounted unit stays free rather than snapping to the
nearest charm candidate, which for `to9` at position 1 would be −$0.01. This is a definitional
carve-out, not a clamp: the charm function is defined as the identity at zero. Every other
input is proven non-negative after snapping by the load-time bound check.

No clamping occurs anywhere, because load-time validation proved no clamp is needed.
- **Tax.** Computed on the post-adjustment taxable amount. `exclusive` adds to the total;
  `inclusive` is extracted from the price rather than added; `unspecified` follows the
  configurable `defaultTaxBehavior` (default `exclusive`) — a policy, not a definition, and one
  that silently inflates a total when the catalog didn't say to. Multiple tax rows apply
  additively on the same base unless `tax_compound` is set, which Quebec (GST + QST) and
  several LATAM regimes require.

  Two running totals are maintained: tax **charged** (which includes inclusive tax, because it
  is real tax) and tax **added** (which does not, because it is already in the price).
  Conflating them reports zero tax on inclusive-tax quotes.

  **Inclusive tax × discount:** a discount reduces a gross that already contains tax, so tax is
  **recomputed from the discounted gross**, reducing net and tax proportionally. Worked: unit
  gross 1199 minor, 7.5% inclusive, 10% discount → discount 120, gross 1079, tax
  `1079 − round(1079/1.075) = 75`, total 1079.

### Worked example, end to end

`.ng` at `price_amount 12.34` USD, `charm to9` (p = 1), quantity 3, a stackable 10% discount,
7.5% exclusive tax:

| Step | When | Computation | Minor units |
| --- | --- | --- | --- |
| parse | load | `"12.34"` → 12.34 major | — |
| quantize | load | 12.34 × 100 | `baseUnitMinor` 1234 |
| unit adjustments | quote | 1234 × (1 − 0.10) = 1110.6 → round | 1111 |
| charm `to9` p=1 | quote | nearest of 1099, 1199 | **`unitMinor` 1099** ($10.99) |
| × quantity 3 | quote | exact integer multiply | subtotal 3297 |
| tax 7.5% exclusive | quote | round(247.275) = 247 | **total 3544** ($35.44) |

Unit × quantity = $10.99 × 3 = $32.97 = the subtotal. Every displayed figure reconciles, and
the discounted price the customer sees is itself a charm price.

The same line with **no** discount charms 1234 to 1199 — so the list price a browsing customer
sees is $11.99, and the discounted price is $10.99. Both are charm prices, which is the point.

Contrast with charming before adjustments, which the earlier ordering would have produced:
1234 → 1199 → less 10% → 1079 → **$10.79**. A price ending in 79 is what a seller who
configured `to9` was trying to avoid.

## Cart pricing and the public API

```ts
class Quotes {
  constructor(config: CatalogConfig, options?: {
    currencies?: CurrencyMeta[];          // optional overrides; exponents derive from Intl
    defaultTaxBehavior?: "inclusive" | "exclusive";
    normalizeSku?: (raw: string) => string;
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
  groups: PeriodTotal[];                  // { frequency, interval, subtotal, adjustments, taxable, tax, total }
  dueNow: Money;                          // one-time group + first charge of each recurring group
  currency: string;
  asOf: string;
  catalogHash: string;
}
```

Three things this shape settles:

- **Currency lives on the cart.** A mixed-currency cart isn't rejected by a check; it has
  nowhere to be expressed. Summing across currencies without FX is undefined, and the type
  system should say so.
- **Totals group by billing period.** A cart holding a one-time registration and a monthly
  subscription has no single meaningful total, so there is no `CartQuote.total` field to
  misread. `groups` replaces it, with `dueNow` for the common checkout rendering. Note the
  deliberate asymmetry: mixed **currency** is impossible while mixed **frequency** is grouped —
  currencies have no relationship without FX, while billing periods have an obvious one
  (separate buckets on the same invoice).
- **A failing line fails the cart.** `quoteCart` throws on the first unpriceable line rather
  than returning a partial result. Per-line result unions are the right shape for a catalog
  browser; for a checkout, a cart that silently prices four of five items is how a customer
  gets charged for something they didn't get, or doesn't get charged for something they did.
  The error names the offending line index and SKU. A caller that genuinely wants
  best-effort behavior calls `quote()` per line and handles its own failures.
- **`asOf` is explicit and recorded.** Filtering effective windows against an implicit `now()`
  makes quotes unreproducible from an audit log, un-backdatable, and untestable without clock
  mocking. Together with `catalogHash`, a stored quote identifies both of its inputs.

SKU normalization is data-first: `product_aliases` handles the ordinary case (`.ng` ≡ `ng`)
declaratively, compiled into the alias map. The `normalizeSku` hook remains for genuinely
algorithmic normalization. It does not violate goal #3 — it is caller-owned and
construction-time, so it cannot arrive from untrusted spreadsheet input — but for catalogs
using it, reproducibility depends on application code as well as on the catalog hash, and it
runs on every line, so it must be O(1) and allocation-light.

## Errors

All failures are typed subclasses of `QuoteError` with a stable string `.code`, so callers
branch on the code rather than on message text.

**Load-time** (all collected into one `CatalogError`, which carries `issues: Issue[]` with
row, column, value, and a suggested fix):

`ERR_CSV_SHAPE`, `ERR_UNKNOWN_COLUMN`, `ERR_DUPLICATE_COLUMN`, `ERR_BAD_NUMBER`,
`ERR_RATE_OUT_OF_RANGE`, `ERR_BAD_DATE`, `ERR_BAD_BOOLEAN`, `ERR_UNSUPPORTED_CURRENCY`,
`ERR_NEGATIVE_AMOUNT`, `ERR_AMOUNT_TOO_LARGE`, `ERR_INVALID_FREQUENCY`,
`ERR_IDENTITY_CONFLICT`, `ERR_ALIAS_CONFLICT`, `ERR_PRICE_ID_CONFLICT`,
`ERR_DUPLICATE_ADJUSTMENT`, `ERR_AMBIGUOUS_PRICE`, `ERR_QUANTITY_GAP`, `ERR_WINDOW_GAP`,
`ERR_INVERTED_RANGE`, `ERR_CHARM_UNDERFLOW`, `ERR_CHARM_INCREMENT_CONFLICT`,
`ERR_DISCOUNT_EXCEEDS_PRICE`,
`ERR_MIXED_STACK_TYPES`, `ERR_CONSTRAINT_SYNTAX`, `ERR_CONSTRAINT_UNKNOWN_FIELD`,
`ERR_CONSTRAINT_CART_SCOPE`, `ERR_CONSTRAINT_ON_PRICE`.

`ERR_AMBIGUOUS_PRICE` carries both row numbers, the axis on which they conflict, and the
overlapping range, because "two prices conflict" without those is not actionable on a 200-row
sheet.

**Quote-time** (deliberately few — most classes of error were made unreachable at load):
`ERR_UNKNOWN_SKU` (unknown or inactive), `ERR_NO_PRICE` (nothing covers this quantity or date),
`ERR_INVALID_REQUEST` (non-positive or fractional quantity), `ERR_CURRENCY_NOT_IN_CATALOG`,
`ERR_AMOUNT_OVERFLOW`.

## Scenario catalog

These are the shapes the design must express. Each is a test.

**1. Minimal.** Two columns, one row.
```csv
product_sku,price_amount
.ng,10.00
```
Everything else comes from defaults. Proves goal #1.

**2. Variant override.** The canonical case.
```csv
product_sku,product_variant,price_amount
.ng,,10.00
.ng,transfer,8.00
```
The blank variant is a wildcard whose region strictly contains the `transfer` row's, so the
override dominates and the catalog loads. Query `(.ng, transfer)` → $8; `(.ng, create)` → $10.

**3. Quantity tiers, and the boundary.**
```csv
product_sku,min_quantity,max_quantity,price_amount
.ng,1,1,16.00
.ng,2,,15.00
```
Interesting because of the boundary: quantity 2 must hit the second row, not the first, and the
bands must be adjacent with no overlap and no gap. Test quantities 1, 2, 3.

**4. Multi-currency without FX.**
```csv
product_sku,currency,price_amount,charm,charm_position
.ng,USD,12.34,to9,1
.ng,NGN,15943,to9,2
```
Two independent price points, no conversion. Exercises exponent 0 (NGN has no minor unit), so
`unitMinor` for NGN is 15999 and for USD is 1199. A cart in `EUR` raises
`ERR_CURRENCY_NOT_IN_CATALOG`.

**5. Country-specific price with wildcard fallback.**
```csv
product_sku,country_code,price_amount
.ng,,10.00
.ng,NG,8.00
```
Same dominance shape as variants, on a different axis. Also the setup for the ambiguity case in
*Adversarial 6*.

**6. Effective-window rollover.**
```csv
product_sku,price_effective_start,price_effective_end,price_amount
.ng,,2026-01-01,10.00
.ng,2026-01-01,,12.00
```
`_end` is exclusive, so the windows abut exactly with no overlap and no gap. The decisive test
is `asOf = 2026-01-01T00:00:00Z` — it must resolve to $12, and the same cart at
`2025-12-31T23:59:59Z` to $10. This is the case that is impossible to test without explicit
`asOf`.

**7. Bundles — and the direct answer to "can a bundle be a different price when feature X is
included?"**

Not through `product_features`. Features are descriptive: putting them in the resolution path
would add an unbounded, set-valued wildcard axis, which multiplies probe count, makes the
dominance check a subset lattice rather than interval containment, and gives the seller a
second way to express something they can already express. The design deliberately keeps them
out of pricing.

The mechanism that *does* work, and is the intended one, is **the variant axis**: a bundle is
the same product configured differently.

```csv
product_sku,product_variant,price_amount,product_features
.ng,,10.00,privacy=no
.ng,with-privacy,13.00,privacy=yes
```
The buyer picks a variant; the price follows; `product_features` remains available for display.
This covers most of what people mean by "bundle": an option that changes the price.

When the bundle is a genuinely different thing — different components, different tax treatment,
its own SKU on an invoice — model it as its own product:

```csv
product_sku,product_name,price_amount,product_tags
.ng,.ng domain,10.00,domain
hosting-basic,Basic hosting,60.00,hosting
ng-plus-hosting,.ng + hosting,55.00,domain;hosting;bundle
```

What is **not** supported, and should be stated rather than discovered: the engine will not
detect that a cart containing `.ng` *and* `hosting-basic` should be repriced as
`ng-plus-hosting`. That is cross-line logic, which breaks per-line independence and O(1)
pricing. Cart composition is the caller's job — it has the UI context to say "add both and
save $15" — and the engine's job is to price whatever composition it is handed. The cart-shaped
API means adding cross-line rules later is an extension, not a redesign.

**8. Charm reconciliation, and charm after adjustments.** Scenario 4's USD row at quantity 3:
undiscounted, unit $11.99 and line $35.97. Add a 10% discount and the unit becomes $10.99 with
line $32.97 — *not* $10.79, which is what charming before the discount would give. Two
properties to assert:
- `unitMinor × quantity === lineSubtotal` for every quantity and charm setting.
- The final unit price is always a charm candidate when `charm` is set and the unit is
  non-zero — including after markup, after discount, and after both.

Add a 20% markup with no discount: base 1234 → 1480.8 → 1481 → charm → **$14.99**. The
same catalog charming first would give $14.39.

**9. Inclusive tax with a discount.** NG VAT at 7.5% inclusive, 10% off. Asserts that tax
*charged* is non-zero while tax *added* is zero, and that the total equals the discounted
gross. The regression this locks: conflating the two totals reports zero tax.

**10. Compound tax.** Quebec GST 5% + QST 9.975% with `tax_compound` on the second. Asserts the
second is computed on base + first, and that the same rows with `tax_compound` off produce the
additive result.

**11. Free tier.** `price_amount` of `0` with `charm: none`. A zero price is legal and must not
be confused with a blank cell (which inherits the default). A zero total is a valid quote, not
an error.

**12. Mixed frequency in one cart.** A one-time registration and a monthly subscription.
Asserts two entries in `groups`, no single total, and `dueNow` = one-time total + first
month.

**13. 100% discount.** A `rate` discount of exactly `1.0` → total exactly zero, no error. And
`1.01` → `ERR_RATE_OUT_OF_RANGE` at load. The boundary is the test.

**14. Fee and discount on the same price.** Different kinds, so both apply; asserts a fee
survives a discount that zeroes the subtotal, and that the total is still non-negative.

**15. One price, several adjustments.** The row-merge case, which is how the flat schema
composes at all:
```csv
product_sku,price_amount,adjustment_kind,adjustment_type,adjustment_value,adjustment_label
.ng,10.00,discount,rate,0.10,Launch offer
.ng,10.00,fee,amount,1.50,ICANN fee
```
Two rows, one price, two adjustments — and specifically **not** an ambiguity error. The
negative control belongs beside it: change the second row's `price_amount` to `11.00` and the
catalog must fail with `ERR_AMBIGUOUS_PRICE`. A third row repeating the `discount` fact
verbatim must fail with `ERR_DUPLICATE_ADJUSTMENT` rather than discounting twice.

**16. A mid-tier price change.** The false-positive control for overlap detection:
```csv
product_sku,min_quantity,max_quantity,price_effective_start,price_effective_end,price_amount
.ng,1,10,,2026-01-01,16.00
.ng,1,10,2026-01-01,,17.00
.ng,11,,,2026-01-01,15.00
.ng,11,,2026-01-01,,16.00
```
Quantity intervals overlap pairwise and windows overlap pairwise, but no *rectangle* overlaps
another. Must load. This is the case a one-dimensional overlap scan wrongly rejects.

**17. Context-driven eligibility.** `adjustment_constraints: customer_tier=!=free` with
`context: { customer_tier: "pro" }` — and the same cart with the key absent, which must fail
the constraint rather than throw.

## Adversarial catalogs

The worst mistakes a business owner actually makes. Each is a test asserting a specific error
code, and together they are the argument for goal #4 — every one of these prices something
wrong under a lenient engine.

**1. The missing zero.** The single most expensive typo in retail.
```csv
product_sku,price_amount
.ng,50.00
.ng,5.00
```
Lenient engines take the cheaper row and sell at a 90% discount forever. Here: two identical
regions with different prices → `ERR_AMBIGUOUS_PRICE` at load, naming both rows.

**2. Percentage confusion.** `tax_rate,7.5` meaning 7.5%. A 750% tax turns a $10 domain into
$85. → `ERR_RATE_OUT_OF_RANGE`, suggesting `0.075`. Same guard on `adjustment_value`, where
`10` meaning "10% off" would otherwise be a 1000% discount.

**3. The decimal comma.** A seller in Lagos or Berlin types `12,50` in an unquoted CSV. Every
column after it shifts by one, so `currency` receives `50`, `country_code` receives `USD`, and
in a lenient parser the row half-succeeds. → `ERR_CSV_SHAPE` on field count, before any field
is interpreted. If quoted (`"12,50"`), → `ERR_BAD_NUMBER`.

**4. Currency symbols and thousands separators.** `$12.34`, `1,234.00`, `₦15 943`. All
`ERR_BAD_NUMBER` (or `ERR_CSV_SHAPE` for the unquoted comma). Never parsed leniently — `$12.34`
silently becoming `12.34` today means `12,34` silently becoming `12` tomorrow.

**5. Overlapping quantity tiers.** The off-by-one everyone writes.
```csv
product_sku,min_quantity,max_quantity,price_amount
.ng,1,10,16.00
.ng,5,20,15.00
```
→ `ERR_AMBIGUOUS_PRICE` naming the `[5,10]` overlap. And the mirror-image typo:
```csv
.ng,1,10,16.00
.ng,20,,15.00
```
→ `ERR_QUANTITY_GAP` — quantities 11–19 are unsellable.

**6. Crossed axes.** The subtle one.
```csv
product_sku,product_variant,country_code,price_amount
.ng,transfer,,8.00
.ng,,NG,9.00
```
A Nigerian customer transferring a domain matches both, and neither is more specific. A ladder
would silently pick one. → `ERR_AMBIGUOUS_PRICE`, with the fix in the message: add an explicit
`(transfer, NG)` row.

**7. The forgotten end date.** A seller adds a new price and forgets to close the old one:
```csv
product_sku,price_effective_start,price_effective_end,price_amount
.ng,,,10.00
.ng,2026-01-01,,12.00
```
Both windows are open, so from 2026-01-01 they overlap forever. → `ERR_AMBIGUOUS_PRICE`. The
inverse — closing the old one a month before the new one starts → `ERR_WINDOW_GAP`.

**8. Inverted ranges.** `min_quantity: 10, max_quantity: 2`, or `price_effective_end` before
`price_effective_start`. → `ERR_INVERTED_RANGE`. A lenient engine matches nothing and the
product silently disappears from sale.

**9. Renamed in one place.** The seller renames a product but only fixes the first row:
```csv
product_sku,product_name,product_variant,price_amount
.ng,Nigeria Domain,,10.00
.ng,.ng Domain,transfer,8.00
```
→ `ERR_IDENTITY_CONFLICT` naming both rows and both names. Under a "first occurrence wins"
rule, re-sorting the sheet would change the product's displayed name.

**10. A discount bigger than the product.** `adjustment_type: amount, adjustment_value: 15` on
a $10 product. → `ERR_DISCOUNT_EXCEEDS_PRICE` at load, computed against
`unitMinor × min_quantity`. Never a runtime clamp, and never a negative line.

**11. Stacked discounts past 100%.** Three stackable 40% discounts on one price. → load error
on the sum. Individually each is legal, which is what makes it worth checking.

**12. A negative fee.** `adjustment_kind: fee, adjustment_value: -5`, meaning "$5 off". → load
error telling them to use `kind: discount`. Otherwise the sign convention silently inverts
somewhere downstream.

**13. Charm underflow.** A $0.02 add-on with the catalog default `charm: to9`. → 
`ERR_CHARM_UNDERFLOW` rather than a −$0.01 price. Catalog-wide charm defaults make this
reachable without the seller touching the row.

**14. Excel's helpfulness.** A date column autoformatted to the serial `46236`; a SKU pasted
with a trailing non-breaking space; a constraint cell autocorrected from `!=free` to `≠free` or
with smart quotes; a leading `'` Excel adds to force text. Trailing whitespace and the BOM are
normalized (they cannot change meaning); the rest are errors naming what happened, because a
silently unmatched constraint is a discount that never applies and nobody notices.

**15. Column typos.** `price_ammount`, `min_qty`, `contry_code`. → `ERR_UNKNOWN_COLUMN` with
the nearest match. This is why unknown columns error rather than being ignored: an ignored
`price_ammount` column means every row falls back to the default price.

**16. Constraint in the wrong place.** `quantity=>=10` written in a price row's constraint cell
when they meant `min_quantity`. → `ERR_CONSTRAINT_ON_PRICE`.

**17. Duplicated header.** Two `currency` columns after a bad merge. → `ERR_DUPLICATE_COLUMN`
rather than last-one-wins.

**18. The undetectable one.** A seller types `1594300` for NGN meaning kobo, when the column is
naira. Nothing in the schema can distinguish this from a legitimately expensive product, and
this design does not pretend otherwise. The mitigation is opt-in: a `price_sanity_range` in
`CatalogDefaults` (per currency) that errors on amounts outside it. Off by default, because a
guess about plausible prices is not something the library can make — but a seller who sets it
once catches an entire class of magnitude errors. Documented as the known limit of static
validation.

## Testing strategy

- **CSV contract**: every rule in that section as a positive and negative case — BOM, CRLF,
  quoted commas, field-count mismatch, blank vs `""`, NBSP trimming, typographic characters,
  Excel date serials.
- **Constraint grammar**: each operator; AND across keys; OR-sets; relational-on-string errors;
  unknown field errors with suggestions; cart-scoped keys rejected; constraint-on-price
  rejected; a known field absent from the query fails the constraint without throwing.
- **Compilation**: defaulting; identity agreement; content-derived IDs stable across a row
  shuffle — shuffle the input rows and assert a byte-identical `catalogHash`; explicit
  `price_id` honored; identical rows deduped while price-differing rows error.
- **Row merging**: Scenario 15 and its two negative controls; merge is order-independent
  (shuffle the two rows, assert an identical adjustment list); a price with one adjustment and
  one tax authored across two rows; a redundant fully-duplicate row adding nothing.
- **Ambiguity and coverage**: every case in the *Adversarial* section, each asserting its
  specific error code and that the reported row numbers are correct. Plus the positive
  controls from *Scenarios* 2, 3, 5, 6, 15 and 16, which must load — a rule this strict has to
  be shown not to reject legitimate catalogs, and the 2-D case (16) is the one a naive
  implementation gets wrong.
- **Detection algorithm specifically**, since it is the part most likely to be implemented
  narrowly: the crossed-axes pair must be caught even though the two rows occupy different
  index buckets; a row more specific on `variant` but wider on quantity must error rather than
  dominate; a gap must be reported per time slab, so a hole that exists only in one window and
  is covered in another is still an error.
- **Probing**: for each of the four lattice positions, a catalog where only that position
  matches; a query resolving to `(variant, *)` while a `(*, country)` row exists for a
  *different* country (legal — the regions are disjoint, so no ambiguity error and the probe
  order is never exercised).
- **Money**: every row of the charm table; the reconciliation property
  (`unitMinor × quantity === lineSubtotal`) across quantities 1–5, both charm modes, and both
  exponent-0 and exponent-2 currencies; quantization modes; rounding increments; the
  safe-integer bounds at load and at quote.
- **Arithmetic rounding**: each of the four rounding points hit individually; the
  order-independence case — two stackable 5% discounts on 999 minor units must give the same
  total in either authoring order, and must equal a single 10% discount; a markup and a
  discount on one price must give the same result in either authoring order, which is the
  common-base rule; per-line tax rounding where rounding the summed rate instead would differ
  by a minor unit; the components of every quote summing exactly to its total, asserted as a
  property across generated carts.
- **Charm ordering**: Scenario 8's markup and discount cases, asserting the post-adjustment
  price is a charm candidate rather than the pre-adjustment one; `charm(0) = 0` under a 100%
  discount; the load-time floor check firing for a low-priced row whose *base* charms fine but
  whose fully-discounted floor would snap negative — the case that only exists because charm
  moved to quote time; `ERR_CHARM_INCREMENT_CONFLICT` for CHF with `to9`.
- **Quantization applied at both points**: a `floor` row and a `ceil` row with identical inputs
  must produce different discounted units — the assertion that the row's mode reaches quote
  time at all. A CHF row (0.05 increment) must snap at load *and* after a discount, landing on
  a 0.05 boundary both times. And a tax on a `floor` row must still round half away from zero,
  proving the tax carve-out is real rather than inherited.
- **Known-hard cases** that a from-scratch implementation reintroduces for free, each as a
  named regression test:
  - **Unbounded-range comparison.** Ranking quantity bands by width computes
    `Infinity − Infinity = NaN` when a bounded tier meets an unbounded rule, and every
    comparison then silently returns "equal." A `min_quantity: 5` tier must beat an unbounded
    row. The region model avoids this by testing containment rather than measuring width, but
    the test stays.
  - **Inclusive-tax double-counting.** Tax charged must include inclusive tax; tax added must
    not. A quote with only inclusive tax must report non-zero tax and a total equal to the
    price.
  - **Half-cent rounding.** `79.8 × 0.075` is exactly `5.985` but floats give `5.984999…`.
    Representation error must be corrected before rounding so a true half rounds up.
  - **Period-ratio off-by-one.** `365.2425 / 30.436875` is exactly 12 but can land a hair
    above, ceiling to 13 and fabricating a thirteenth monthly charge. Anywhere a period ratio
    is ceilinged needs an epsilon.
- **Cart**: multi-line carts; frequency-grouped totals and `dueNow`; a cart whose currency has
  no matching row; an unpriceable line failing the whole cart with the line index named; the
  same cart at two `asOf` values spanning an effective-window boundary.
- **Performance**: a benchmark asserting quote latency is flat from 100 to 100,000 price rows —
  the operational definition of goal #6. Plus an allocation-count assertion on the hot path, to
  catch a regression that reintroduces per-quote parsing.
- **Property tests**: for arbitrary valid catalogs and carts — the total is never negative; the
  total is zero only when every component is zero or fully discounted; unit × quantity always
  equals the subtotal; row order never changes any output.

## Verification

1. The test suite above passes.
2. A two-column CSV (`product_sku,price_amount`) prices successfully with defaults filling
   everything else — goal #1 holds.
3. Every adversarial catalog above throws at load with the expected code, and no adversarial
   catalog produces a quote — goal #4 holds.
4. Shuffle a 50-row catalog's rows: byte-identical `catalogHash`, identical quotes — goals #4
   and #8 hold.
5. Price a cart, then replay it from `(catalogHash, asOf, lines)`: identical result — goal #8
   holds.
6. The 100 → 100,000-row benchmark is flat, and a profile of the hot path shows no string
   parsing, no `Date` construction, and no `Intl` construction — goal #6 holds.
7. Trace the canonical `.ng` scenario by hand through the region model and the money pipeline,
   confirming the intended winners.
