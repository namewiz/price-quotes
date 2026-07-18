# Price Quotes

[![Build](https://github.com/namewiz/price-quotes/actions/workflows/build.yml/badge.svg)](https://github.com/namewiz/price-quotes/actions/workflows/build.yml)
[![Test](https://github.com/namewiz/price-quotes/actions/workflows/test.yml/badge.svg)](https://github.com/namewiz/price-quotes/actions/workflows/test.yml)
[![NPM](http://img.shields.io/npm/v/price-quotes.svg)](https://www.npmjs.com/package/price-quotes)
[![License](https://img.shields.io/npm/l/price-quotes.svg)](https://github.com/namewiz/price-quotes/blob/main/LICENSE)

A generic quote engine for any product type — software licences, subscriptions, physical
goods, services, domains. Describe a product, its variants, its prices and its tax
treatment in config, then ask for a quote in a given currency, interval and quantity.

The output is also *smart*: it tells you when a different but equivalent purchase shape
would cost less — annual instead of monthly, 5 units instead of 1 — without ever
suggesting something that isn't actually the same thing.

## Install

```bash
npm i price-quotes
```

## Quick start

```ts
import { Quotes, formatMoney } from 'price-quotes';

const q = new Quotes({
  catalog: {
    products: [{ sku: 'pro', variants: [{ id: 'sub' }], intervals: [{ unit: 'month' }, { unit: 'year' }] }],
    rules: [
      { sku: 'pro', interval: 'month', amount: { USD: 10 } },
      { sku: 'pro', interval: 'year',  amount: { USD: 100 } },  // 2 months free
      { sku: 'pro', minQuantity: 5,    amount: { USD: 8 } },    // volume tier
    ],
  },
  currencies: [{ code: 'USD', symbol: '$', exponent: 2 }],
  taxes: [{ id: 'vat', name: 'VAT', rate: 0.2 }],
});

const quote = await q.quote({ sku: 'pro', currency: 'USD', interval: 'month' }, { explore: true });

formatMoney(quote.currency, quote.total);   // '$12.00'
quote.rate.perUnitPerYear;                  // 144
quote.insights[0].kind;                     // 'interval-upgrade'
quote.insights[0].savings.amount;           // { currency: 'USD', minor: 2000 } -> $20/yr
```

## The model

### Products and variants

A **product** is a thing you can buy, identified by a SKU. A **variant** is a *mode* of
buying that same product: `subscription` / `academic` for software, `standard` / `expedited`
for a service, `new` / `upgrade` for a licence.

### The three axes

"Buying more" means three different things, and savings can come from any of them
independently:

| Axis | Meaning | Example |
| --- | --- | --- |
| `interval` | the billing unit | `once`, `day`, `week`, `month`, `year` |
| `term` | how many intervals bought at once | a 2-year commitment |
| `quantity` | how many units | 5 seats, 3 licences |

Pre-tax subtotal is `unitPrice × quantity × term`, modulo tier pricing on either axis.

### Price rules

Prices are a flat list of rules with optional selectors. An omitted selector matches
anything, and the most specific rule wins.

```ts
rules: [
  { amount: { USD: 30 } },                                  // catch-all
  { group: 'seats', amount: { USD: 20 } },                  // any product tagged 'seats'
  { sku: 'pro', amount: { USD: 10 } },                      // just 'pro'
  { sku: 'pro', variant: 'academic', amount: { USD: 4 } },  // academic pricing
  { sku: 'pro', interval: 'year', minTerm: 3, amount: { USD: 75 } },  // 3-year commit
  { sku: 'pro', minQuantity: 10, amount: { USD: 6 } },      // 10+ seats
]
```

Precedence ladder, highest first:

1. exact `sku` beats `group` beats wildcard
2. narrower quantity range
3. narrower term range
4. explicit `variant` beats wildcard
5. explicit `interval` beats wildcard
6. declaration order — later wins

The winning rule is always reported in `quote.explain.matchedRule`.

### Money

Amounts are integer **minor units** (`{ currency: 'USD', minor: 1299 }` = $12.99), so JPY
(no minor unit) and KWD (three) work correctly. Each currency carries its own rounding
policy:

```ts
{ code: 'NGN', symbol: '₦', exponent: 2, roundingIncrement: 100 }  // whole naira
{ code: 'JPY', symbol: '¥', exponent: 0 }                          // whole yen
```

Use `toMajor(meta, minor)` for a number and `formatMoney(meta, money)` for display.

### Tax

```ts
taxes: [
  { id: 'gst', name: 'GST', rate: 0.05 },
  { id: 'pst', name: 'PST', rate: 0.10, compound: true },        // stacks on GST
  { id: 'vat', name: 'VAT', rate: 0.20, inclusive: true },       // already in the price
  { id: 'x',   name: 'X',   rate: 0.02, basis: 'base' },         // pre-discount
  { id: 'y',   name: 'Y',   rate: 0.05, appliesTo: { groups: ['standard'] } },
]
```

Or a resolver, for anything that depends on the request:

```ts
taxes: (ctx) => ctx.context?.country === 'NG' ? [{ id: 'vat', name: 'VAT', rate: 0.075 }] : []
```

`quote.taxes` itemizes every line; `quote.tax` is the total tax charged (including
inclusive tax, which is reported but does not raise `quote.total`).

### Discounts

```ts
discounts: {
  WELCOME: { rate: 0.1, skus: ['pro', 'team'], startAt: '2024-01-01T00:00:00Z', endAt: '2024-12-31T23:59:59Z' },
  NEWUSER: { rate: 0.2, variants: ['new'] },
  CORP:    { rate: 0.3, isEligible: (ctx) => String(ctx.context?.email ?? '').endsWith('@acme.com') },
}

await q.quote({ sku: 'pro', currency: 'USD', discountCodes: ['WELCOME', 'NEWUSER'] });
// discountPolicy: 'max' (default) applies the highest; 'stack' sums them
```

`QuoteRequest.context` is opaque caller data forwarded to every eligibility callback and
to the tax resolver — that's where email domain, country code, or referrer live. Discounts
are always clamped to the subtotal, so a total can never go negative. `isEligible` must be
side-effect-free: with `explore` on it may be consulted for several candidates per call
(results are memoized within a call).

## The smart layer

Pass `{ explore: true }` to price counterfactuals and get `insights`.

```ts
import { formatInsight } from 'price-quotes';

const quote = await q.quote({ sku: 'pro', currency: 'USD', interval: 'month' }, { explore: true });

for (const i of quote.insights) {
  console.log(i.strength, formatInsight(i));
}
// strong  Switch to yearly billing and save $20.00 (17%)
//         (assumes you keep this for 365 days, you buy 335 more days of cover than you asked for)
```

| Kind | Meaning |
| --- | --- |
| `interval-upgrade` | a different billing interval costs less over the horizon |
| `term-upgrade` | committing to more intervals costs less |
| `volume-tier` | buying more units costs less |
| `tier-threshold` | buying more costs *more*, but drops the unit price |
| `variant-swap` | a declared-substitutable variant costs less |
| `discount-available` | an unrequested code applies (opt-in only) |

`strength` is `dominant` (costs less outright), `strong` (≥10% saving) or `info`.

### It only compares like with like

This is the important part. Naively reporting "anything cheaper" produces confident
nonsense: an `academic` licence is cheaper than a `retail` one, but suggesting it to a
customer who can't use it is a category error, not a saving.

So:

- **`interval`, `term` and `quantity` are safely comparable.** More of the same thing is
  still the same thing.
- **Variants are never compared unless config says so.** A variant only enters the
  comparison set if it declares a `substitutionGroup`, meaning it delivers genuinely
  equivalent value.
- Ineligible variants are never dangled at customers who can't use them.
- Shorter terms and smaller quantities are never suggested — that's less, not cheaper.
- One-time and recurring options are never compared. A perpetual licence has no natural
  horizon, so whichever one you picked would decide the answer by itself.

### It's honest about assumptions

Comparing annual to monthly×12 assumes the customer stays a year. That's an assumption,
not a fact, so it's in the output:

```ts
insight.savings.horizonDays;  // 365
insight.assumes;              // ['you keep this for 365 days', 'you buy 335 more days of cover...']
insight.providesExtra;        // { days: 335 }
insight.dominant;             // false — the annual plan costs more up front
```

A `tier-threshold` reports `savings.amount` of **zero**, because paying more to get more
is not a saving. What it costs is in `threshold.extraCost`.

### Cost control

```ts
{ explore: {
    intervals: true, terms: true, quantities: true, variants: true,
    discounts: false,        // opt-in: reveals codes the customer wasn't offered
    horizonDays: undefined,  // defaults to the longest candidate's duration
    maxCandidates: 24,
    minSavingsPercent: 0.01,
} }
```

Candidates come only from breakpoints the catalog actually declares — never a synthesized
sweep.

## Presets

A preset is just a helper that builds a `QuotesConfig` for a common shape. The engine has
no built-in knowledge of any of them.

### Software

```ts
import { softwareQuotes } from 'price-quotes/presets/software';

const q = softwareQuotes({
  plans: [{
    id: 'pro',
    monthly: 10, annual: 100, perpetual: 400,
    seatTiers: [{ minSeats: 5, monthly: 8 }, { minSeats: 20, monthly: 6 }],
    termTiers: [{ minYears: 3, annual: 75 }],
  }],
  taxes: [{ id: 'vat', name: 'VAT', rate: 0.2 }],
});

const quote = await q.quote({ sku: 'pro', currency: 'USD', interval: 'month', quantity: 3 }, { explore: true });
```

### Domains

An example preset that prices domain registrations across ~1,800 TLDs from a public
registrar dataset, loaded lazily. **Importing does no I/O**; nothing is fetched until you
call `load()`.

```ts
import { domainsPreset } from 'price-quotes/presets/domains';

const q = await domainsPreset().quotes();
const quote = await q.quote({ sku: 'com', currency: 'NGN' });
```

```ts
const preset = domainsPreset({
  fetch: myFetch,       // injectable HTTP; defaults to global fetch
  cache: myCache,       // or `false` to disable
  data: preloadedData,  // skip the network entirely
  vatRate: 0.075,
  currencies: ['USD', 'NGN'],
});
await preset.load();
const q = new Quotes(preset.config);
```

## Errors

Typed, with stable `code` values so you can branch without string-matching messages.

| Error | Code |
| --- | --- |
| `UnknownSkuError` | `ERR_UNKNOWN_SKU` |
| `UnknownVariantError` | `ERR_UNKNOWN_VARIANT` |
| `VariantNotEligibleError` | `ERR_VARIANT_NOT_ELIGIBLE` |
| `UnsupportedCurrencyError` | `ERR_UNSUPPORTED_CURRENCY` |
| `NoPriceError` | `ERR_NO_PRICE` |
| `InvalidRequestError` | `ERR_INVALID_REQUEST` |
| `BelowMinimumChargeError` | `ERR_BELOW_MINIMUM_CHARGE` |

All extend `QuoteError`. Zero totals are legal (free tiers, 100%-off promos) unless you set
a floor:

```ts
minChargeableTotal: { USD: 0.5, NGN: 100 }   // per currency, in major units
```

## Design

See [design-docs/design.md](design-docs/design.md) for
the architecture, the reasoning behind the comparability rules, and the open questions.

Core invariant: **`src/core/` imports nothing from `src/presets/` and does no I/O.** It
takes an in-memory catalog and returns quotes. Every product-specific assumption lives
behind a preset.

## Testing

```bash
npm test
```

Node's built-in `node:test` runner; builds first.
