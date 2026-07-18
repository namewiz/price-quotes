# Price Quotes — design

**Status:** Implemented
**Date:** 2026-07-18

## Goal

A generic quote engine for any product type — software licences, subscriptions, physical
goods, services, domains. A client describes a product, its variants, its prices and its
tax treatment in config, then asks for a quote in a given currency, interval and quantity.

The output is *also smart*: it surfaces when a different but equivalent purchase shape
(annual instead of monthly, 5 units instead of 1) would cost less — without ever
suggesting something that isn't actually the same thing.

## Non-goals

Worth naming, because the gravitational pull of "a generic pricing library" is to reinvent
Stripe:

- Not an invoicing or payments system. No invoice objects, no payment state, no dunning.
- No proration, mid-cycle upgrades, or subscription lifecycle state. The engine prices a
  hypothetical purchase; it doesn't know what the customer already owns.
- No tax compliance. It applies tax rules it is handed. It does not determine nexus,
  validate VAT IDs, or maintain a jurisdiction registry.
- No live FX. Rates are data passed in.
- No persistence, no catalog CRUD, no admin UI.

## The model

### Products and variants

A product is a thing you can buy, identified by a SKU. A variant is a *mode* of buying that
same product — `new` / `upgrade` / `academic` for software; `standard` vs `expedited` for a
service; `create` / `renew` / `transfer` for a domain.

```ts
interface Product {
  sku: string;
  name?: string;
  groups?: string[];              // tags for bulk rules, e.g. 'seats', 'addon'
  variants: Variant[];
  intervals?: Interval[];         // which are purchasable
  metadata?: Record<string, unknown>;
}

interface Variant {
  id: string;
  substitutionGroup?: string;     // see "comparability" below — default: none
  requires?: EligibilityCallback; // e.g. academic pricing needs a .edu address
}
```

### The three axes

"Buying more" means three different things, and savings can come from any of them
independently:

1. **`interval`** — the billing unit: `once`, `day`, `week`, `month`, `year`. Comparing
   *across* intervals is the "annual plan beats monthly × 12" case.
2. **`term`** — how many intervals are bought at once. A 2-year commitment is
   `interval: year, term: 2`. Per-interval price often drops as term rises.
3. **`quantity`** — how many units. 5 seats, 3 licences. Per-unit price often drops as
   quantity rises.

Pre-tax subtotal is `unitPrice × quantity × term`, modulo tier pricing on either axis.

### Price rules

Prices are a flat list of rules with optional selectors. An omitted selector matches
anything.

```ts
interface PriceRule {
  // selectors
  sku?: string | string[];
  group?: string;
  variant?: string | string[];
  interval?: IntervalUnit;
  minQuantity?: number;  maxQuantity?: number;   // volume tiers
  minTerm?: number;      maxTerm?: number;       // term tiers
  // payload
  amount: number | Record<string, number>;       // major units, per currency
  per?: 'unit' | 'line';                         // default 'unit'
}
```

Resolution picks the most specific match, by an explicit precedence ladder rather than
magic specificity weights:

1. exact `sku` beats `group` beats wildcard
2. narrower quantity range beats wider
3. narrower term range beats wider
4. explicit `variant` beats wildcard
5. explicit `interval` beats wildcard
6. declaration order — later wins

The rule that won is reported in `quote.explain.matchedRule`. A flexible matcher without an
explanation trail is a support burden; this is not optional.

### Tax

Rules, with a resolver escape hatch for anything real-world:

```ts
interface TaxRule {
  id: string;
  name: string;                   // 'VAT', 'GST', 'PST'
  rate: number;
  jurisdiction?: string;
  appliesTo?: { skus?: string[]; groups?: string[]; variants?: string[] };
  inclusive?: boolean;            // price already contains the tax
  compound?: boolean;             // stacks on top of prior taxes, not on the base
  basis?: 'subtotal' | 'base';    // default 'subtotal' (post-discount)
}

type TaxResolver = (ctx: TaxContext) => TaxRule[] | Promise<TaxRule[]>;
```

Output carries `taxes: TaxLine[]` so a caller can itemize, plus a summed `tax`. Inclusive
tax is reported in `tax` but does not raise `total`, because it is already inside the
listed price.

### Money and rounding

Money is an integer count of **minor units**: `{ currency: 'USD', minor: 1299 }`. A single
`number` of major units does not survive contact with the real world — JPY has no minor
unit, KWD has three, and float cents accumulate error.

- Per-currency metadata: `{ code, symbol, exponent, roundingIncrement? }`. A currency that
  is only ever quoted in whole units (e.g. NGN in practice) sets `roundingIncrement: 100` —
  a real currency policy rather than a global flag.
- Intermediate math (FX especially) runs at extra precision and quantizes only at defined
  boundaries: after markup, after discount, after each tax line.
- `roundingPolicy: 'per-step'` (default) quantizes at each of those boundaries so every
  reported line is a whole, self-consistent amount; `'final'` keeps full precision until
  the total.

## The smart layer

This is the genuinely novel part, and the part most likely to go wrong.

### Comparability is the hard problem, not the arithmetic

The naive version — price every alternative, report anything cheaper — produces confident
nonsense. An `academic` licence is cheaper than a `retail` one, but suggesting it to a
customer who can't use it is a category error, not a saving.

So the engine only compares configurations that deliver **the same value, differing only in
amount**:

- **`interval`, `term`, and `quantity` are safely comparable by default.** More of the same
  thing is still the same thing.
- **Variants are NOT comparable by default.** A variant only enters the comparison set if
  config explicitly declares it substitutable via `substitutionGroup`. This default is the
  single most important safety property of the feature, and it should not be relaxed
  casually.

### Honest counterfactuals

Comparing an annual plan to a monthly one assumes the customer keeps it for a year. That is
an assumption, not a fact, and the output says so rather than quietly baking it in.

- Comparison happens over an explicit **horizon** (`horizonDays`), defaulting to the
  longest candidate's duration.
- Every insight carries `assumes: string[]` — e.g. `["you keep this for 365 days"]`.
- When the horizon isn't a clean multiple of a candidate's duration, the customer buys
  *more than they asked for*. That is flagged as `providesExtra`, and the insight reports
  both the horizon-normalized cost and what is actually purchased.
- One-time and recurring options are never compared. A perpetual purchase has no natural
  horizon, so whichever horizon was chosen would decide the answer by itself — even an
  explicit `horizonDays` does not unlock it.
- Normalization uses fixed average durations (`year = 365.2425d`, `month = 30.436875d`)
  because this is rate math, not invoice scheduling. Deterministic, and documented.

### Two classes of saving

- **Dominant** — the alternative costs less *in absolute terms* than what was asked for.
  Buying 5 units at the tier price totals less than 1 unit at list. Rare, always surfaced
  loudly.
- **Rate** — the alternative costs more absolutely but less per unit per day. The standard
  annual-plan upsell. Surfaced, but honestly framed.

Plus a near-miss case, **`tier-threshold`**, where adding a unit or two crosses into a
cheaper bracket. It reports `savings.amount: 0` (paying more to get more is not a saving)
plus a `threshold.extraCost` and the unit-price drop.

### Shape

```ts
interface Insight {
  kind: 'interval-upgrade' | 'term-upgrade' | 'volume-tier'
      | 'tier-threshold' | 'variant-swap' | 'discount-available';
  strength: 'dominant' | 'strong' | 'info';
  alternative: ResolvedRequest;
  quote: Quote;                  // the fully priced counterfactual
  savings: {
    currency: string; amount: Money; percent: number;
    horizonDays: number | null; baselineCost: Money; alternativeCost: Money;
  };
  dominant: boolean;
  providesExtra?: { days?: number; quantity?: number };
  assumes: string[];
}
```

Core returns structured data only. Message formatting stays out of core — a
`formatInsight()` helper ships alongside, and i18n is the caller's problem.

### Cost control

Exploration prices N extra quotes and may re-run caller-supplied async eligibility
callbacks. That is bounded:

- **Opt-in.** `quote(req)` prices one thing; `quote(req, { explore: true })` does the
  counterfactual work.
- Candidates come only from what the catalog actually declares — real tier breakpoints and
  purchasable intervals — never a synthesized sweep.
- `maxCandidates` (default 24) with deterministic ordering; `minSavingsPercent` (default
  1%) to suppress noise.
- Eligibility results are memoized per `quote()` call. This makes `isEligible`
  contractually side-effect-free.

```ts
interface ExploreOptions {
  intervals?: boolean | IntervalUnit[];
  terms?: boolean | number[];
  quantities?: boolean | number[];
  variants?: boolean;            // only honours declared substitution groups
  discounts?: boolean;           // opt-in: reveals codes the customer wasn't offered
  horizonDays?: number;          // recurring-vs-recurring only
  maxCandidates?: number;
  minSavingsPercent?: number;
}
```

## Architecture

```
src/
  core/
    money.ts       — minor-unit arithmetic, rounding policy, currency metadata
    currency.ts    — FX resolution and conversion
    interval.ts    — interval durations, horizon normalization
    catalog.ts     — product/variant/rule resolution + precedence ladder
    pricing.ts     — the pipeline: resolve → markup → discount → tax → round
    insights.ts    — counterfactual enumeration and comparison
    errors.ts
    types.ts
  presets/
    software/      — seats, plans, seat tiers, multi-year term tiers
    domains/       — TLD normalization, registrar dataset loader, FX, VAT default
  index.ts
```

The invariant that keeps this honest: **`core/` imports nothing from `presets/`, and does
no I/O.** It takes in-memory catalogs and returns quotes. Every product-specific assumption
lives behind the preset boundary — a preset is just a helper that builds a `QuotesConfig`.

## API

```ts
import { Quotes, formatInsight } from 'price-quotes';

const q = new Quotes({
  catalog: {
    products: [{ sku: 'pro', variants: [{ id: 'sub' }], intervals: [{ unit: 'month' }, { unit: 'year' }] }],
    rules: [
      { sku: 'pro', interval: 'month', amount: { USD: 10 } },
      { sku: 'pro', interval: 'year',  amount: { USD: 100 } },   // 2 months free
      { sku: 'pro', minQuantity: 5,    amount: { USD: 8 } },
    ],
  },
  currencies: [{ code: 'USD', symbol: '$', exponent: 2 }],
  taxes: [{ id: 'vat', name: 'VAT', rate: 0.2 }],
});

const quote = await q.quote({ sku: 'pro', currency: 'USD', interval: 'month' }, { explore: true });
// quote(month × 1) with explore → interval-upgrade insight: save $20/yr (16.7%)
```

A preset is the same thing with the config pre-built. The domains preset additionally owns
its data loading, lazily and injectably, so importing it does no I/O:

```ts
import { domainsPreset } from 'price-quotes/presets/domains';

const preset = domainsPreset({ fetch: customFetch });  // injectable
await preset.load();                                    // explicit, lazy, not at import
const q = new Quotes(preset.config);
```

## Design decisions

- **Typed errors, not native.** Everything extends `QuoteError` and carries a stable
  `code`. A library whose job is to sit inside checkout flows benefits from callers
  branching on `err.code` rather than string-matching messages.
- **Zero totals are legal.** Free tiers and 100%-off promos are real, so there is no
  blanket "total must be > 0" rule. Discounts are always clamped to the subtotal (a total
  can never go negative), and an optional per-currency `minChargeableTotal` floor throws
  `BelowMinimumChargeError` when set.
- **No first-class user-metadata fields on discounts.** Email domain, country code and
  referrer are not config fields; they ride on `QuoteRequest.context`, which is forwarded
  verbatim to every `isEligible` callback and to the tax resolver. Corporate and geo
  discounts fall out of that with no new surface area.
- **`minChargeableTotal` is `Record<string, number>`**, not a bare number. A floor is a
  real amount of money — `0.01` means different things in USD and NGN, and converting it
  would make the floor drift with the exchange rate.
- **`isEligible` must be side-effect-free.** Exploration may consult it for several
  candidates per call; results are memoized within a call, but the callback still runs more
  than once per quote.
- **Config ergonomics deferred.** No `defineCatalog()` builder yet; the raw `PriceRule[]`
  plus presets carry it.

## Implementation notes

Bugs the tests caught, worth remembering because they are easy to reintroduce:

- **Precedence NaN.** Ranking rules by range *width* gives `Infinity - Infinity = NaN` when
  comparing `minQuantity: 5` against an unbounded rule — every comparison returned NaN and
  the tier silently lost. Fixed by ranking pinned-bound count first, then finite width,
  then the higher lower bound.
- **Horizon off-by-one.** `365.2425 / 30.436875` is exactly 12, but can land a hair above
  it in float, ceiling to 13 — which would have invented a 13th monthly payment and
  fabricated a saving. Fixed with an epsilon.
- **Inclusive tax double-counting.** `quote.tax` must count inclusive tax (it is real tax)
  while `quote.total` must not (it is already in the price). Two running totals; the first
  draft conflated them and reported zero tax on inclusive-tax quotes.
- **Half-cent rounding.** `79.8 × 0.075` is exactly `5.985`, but floats give
  `5.984999999999998`. Quantization corrects representation error before rounding so a true
  half rounds up rather than down.

A note on the domains preset: when a variant's price row quotes only one currency but the
base row quotes another currency directly, the directly quoted price is authoritative for
its currency, so a per-variant uplift may not be reflected in that currency. This is an
inherent consequence of letting source data pin a currency's price; the fix is better
source data, not second-guessing a direct quote in the engine. Locked by a test.

## Risks

- **Over-generalizing.** Two independent presets (software, domains) exercise the core along
  genuinely different axes — flat per-SKU pricing with direct multi-currency quotes on one
  side, seat/term tiers with FX conversion on the other. If a third product shape doesn't
  fit, the core is what should bend.
- **Insight nonsense.** Mitigated by variants being non-comparable by default — the
  conservative default is the whole safety story.
- **Exploration cost.** Mitigated by opt-in, catalog-derived candidates, caps, memoization.
- **Config verbosity scaring off simple users.** Mitigated by presets: the common cases stay
  a few lines.
