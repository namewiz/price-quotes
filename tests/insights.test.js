import assert from 'node:assert/strict';
import test from 'node:test';

import { Quotes, formatInsight } from '../dist/index.js';

const USD = { code: 'USD', symbol: '$', exponent: 2 };

/** A plan billable monthly or annually, where annual is cheaper per unit time. */
function subscription (extra = {}) {
  return new Quotes({
    catalog: {
      products: [{ sku: 'pro', variants: [{ id: 'sub' }], intervals: [{ unit: 'month' }, { unit: 'year' }] }],
      rules: [
        { sku: 'pro', interval: 'month', amount: { USD: 10 } },
        { sku: 'pro', interval: 'year', amount: { USD: 100 } },
      ],
    },
    currencies: [USD],
    taxes: [],
    ...extra,
  });
}

function insightOf (quote, kind) {
  return quote.insights.find((i) => i.kind === kind);
}

// ---------------------------------------------------------------------------
// The headline cases from the brief
// ---------------------------------------------------------------------------

test('exploration is off by default', async () => {
  const quote = await subscription().quote({ sku: 'pro', currency: 'USD', interval: 'month' });
  assert.deepEqual(quote.insights, []);
  assert.deepEqual(quote.alternatives, []);
});

test('yearly beating monthly x12 is surfaced, with the horizon stated', async () => {
  const quote = await subscription().quote({ sku: 'pro', currency: 'USD', interval: 'month' }, { explore: true });

  const insight = insightOf(quote, 'interval-upgrade');
  assert.ok(insight, 'expected an interval-upgrade insight');
  assert.equal(insight.savings.baselineCost.minor, 12000, '12 x $10');
  assert.equal(insight.savings.alternativeCost.minor, 10000, '$100');
  assert.equal(insight.savings.amount.minor, 2000, '$20 saved');
  assert.ok(Math.abs(insight.savings.percent - 0.1667) < 0.001);
  assert.equal(insight.strength, 'strong');
  assert.equal(insight.dominant, false, 'the annual plan costs more up front');
  assert.equal(Math.round(insight.savings.horizonDays), 365);

  // The saving is conditional on staying a year, and the output must say so.
  assert.ok(insight.assumes.some((a) => a.includes('365 days')), `assumes: ${JSON.stringify(insight.assumes)}`);
  assert.ok(insight.providesExtra.days > 300);
});

test('buying more can cost less outright, and that is flagged as dominant', async () => {
  // 1 unit at list costs $50; crossing the 5-unit tier makes 5 units cost $45 total.
  const q = new Quotes({
    catalog: {
      products: [{ sku: 'license', variants: [{ id: 'buy' }], intervals: [{ unit: 'once' }] }],
      rules: [
        { sku: 'license', amount: { USD: 50 } },
        { sku: 'license', minQuantity: 5, amount: { USD: 9 } },
      ],
    },
    currencies: [USD],
    taxes: [],
  });

  const quote = await q.quote({ sku: 'license', currency: 'USD', quantity: 1 }, { explore: true });
  const insight = insightOf(quote, 'volume-tier');
  assert.ok(insight, 'expected a volume-tier insight');
  assert.equal(insight.dominant, true, '5 units cost less in absolute terms than 1');
  assert.equal(insight.strength, 'dominant');
  assert.equal(insight.savings.amount.minor, 500, '$50 -> $45');
  assert.equal(insight.providesExtra.quantity, 4);
  assert.ok(insight.assumes.some((a) => a.includes('4 more unit')));
});

test('two-unit net savings are surfaced', async () => {
  const q = new Quotes({
    catalog: {
      products: [{ sku: 'seat', variants: [{ id: 'buy' }], intervals: [{ unit: 'once' }] }],
      rules: [
        { sku: 'seat', amount: { USD: 100 } },
        { sku: 'seat', minQuantity: 2, amount: { USD: 40 } },
      ],
    },
    currencies: [USD],
    taxes: [],
  });
  const quote = await q.quote({ sku: 'seat', currency: 'USD', quantity: 1 }, { explore: true });
  const insight = insightOf(quote, 'volume-tier');
  assert.ok(insight);
  assert.equal(insight.quote.total.minor, 8000, '2 x $40');
  assert.equal(insight.savings.amount.minor, 2000, '$100 -> $80');
  assert.equal(insight.dominant, true);
});

test('multi-year terms are surfaced as term upgrades', async () => {
  const q = new Quotes({
    catalog: {
      products: [{ sku: 'pro', variants: [{ id: 'sub' }], intervals: [{ unit: 'year' }] }],
      rules: [
        { sku: 'pro', interval: 'year', amount: { USD: 100 } },
        { sku: 'pro', interval: 'year', minTerm: 3, amount: { USD: 70 } },
      ],
    },
    currencies: [USD],
    taxes: [],
  });
  const quote = await q.quote({ sku: 'pro', currency: 'USD', term: 1 }, { explore: true });
  const insight = insightOf(quote, 'term-upgrade');
  assert.ok(insight, 'expected a term-upgrade insight');
  assert.equal(insight.savings.baselineCost.minor, 30000, '3 x $100 to cover 3 years');
  assert.equal(insight.savings.alternativeCost.minor, 21000, '3 x $70');
  assert.equal(insight.savings.amount.minor, 9000);
});

// ---------------------------------------------------------------------------
// Comparability: the safety property
// ---------------------------------------------------------------------------

test('lifecycle variants are never suggested as savings', async () => {
  // renew is genuinely cheaper than create, but telling someone registering a new domain
  // to "renew instead" is a category error. No substitutionGroup => never compared.
  const q = new Quotes({
    catalog: {
      products: [{ sku: 'com', variants: [{ id: 'create' }, { id: 'renew' }], intervals: [{ unit: 'year' }] }],
      rules: [
        { sku: 'com', variant: 'create', amount: { USD: 20 } },
        { sku: 'com', variant: 'renew', amount: { USD: 5 } },
      ],
    },
    currencies: [USD],
    taxes: [],
  });
  const quote = await q.quote({ sku: 'com', variant: 'create', currency: 'USD' }, { explore: true });
  assert.equal(quote.insights.length, 0, `expected no insights, got ${JSON.stringify(quote.insights.map((i) => i.kind))}`);
});

test('variants are compared only when config declares them substitutable', async () => {
  const q = new Quotes({
    catalog: {
      products: [{
        sku: 'ticket',
        variants: [
          { id: 'gate', substitutionGroup: 'entry' },
          { id: 'advance', substitutionGroup: 'entry' },
        ],
        intervals: [{ unit: 'once' }],
      }],
      rules: [
        { sku: 'ticket', variant: 'gate', amount: { USD: 30 } },
        { sku: 'ticket', variant: 'advance', amount: { USD: 20 } },
      ],
    },
    currencies: [USD],
    taxes: [],
  });
  const quote = await q.quote({ sku: 'ticket', variant: 'gate', currency: 'USD' }, { explore: true });
  const insight = insightOf(quote, 'variant-swap');
  assert.ok(insight, 'declared substitution group should be compared');
  assert.equal(insight.alternative.variant, 'advance');
  assert.equal(insight.savings.amount.minor, 1000);
});

test('an ineligible variant is never suggested', async () => {
  const q = new Quotes({
    catalog: {
      products: [{
        sku: 'ide',
        variants: [
          { id: 'retail', substitutionGroup: 'licence' },
          { id: 'academic', substitutionGroup: 'licence', requires: (ctx) => ctx.context?.edu === true },
        ],
        intervals: [{ unit: 'year' }],
      }],
      rules: [
        { sku: 'ide', variant: 'retail', amount: { USD: 100 } },
        { sku: 'ide', variant: 'academic', amount: { USD: 20 } },
      ],
    },
    currencies: [USD],
    taxes: [],
  });

  const ineligible = await q.quote({ sku: 'ide', variant: 'retail', currency: 'USD' }, { explore: true });
  assert.equal(ineligible.insights.length, 0, 'academic pricing must not be dangled at someone who cannot use it');

  const eligible = await q.quote({ sku: 'ide', variant: 'retail', currency: 'USD', context: { edu: true } }, { explore: true });
  assert.ok(insightOf(eligible, 'variant-swap'));
});

test('shorter terms and smaller quantities are never suggested as savings', async () => {
  const q = new Quotes({
    catalog: {
      products: [{ sku: 'pro', variants: [{ id: 'sub' }], intervals: [{ unit: 'year' }] }],
      rules: [
        { sku: 'pro', interval: 'year', amount: { USD: 100 } },
        { sku: 'pro', interval: 'year', minTerm: 3, amount: { USD: 70 } },
      ],
    },
    currencies: [USD],
    taxes: [],
  });
  // Asking for 3 years must not yield "buy 1 year, it's cheaper" -- it is less, not cheaper.
  const quote = await q.quote({ sku: 'pro', currency: 'USD', term: 3 }, { explore: true });
  assert.equal(quote.insights.filter((i) => i.kind === 'term-upgrade').length, 0);
});

// ---------------------------------------------------------------------------
// Honesty
// ---------------------------------------------------------------------------

test('a perpetual licence is never compared to a subscription, at any horizon', async () => {
  const q = new Quotes({
    catalog: {
      products: [{ sku: 'app', variants: [{ id: 'sub' }], intervals: [{ unit: 'month' }, { unit: 'once' }] }],
      rules: [
        { sku: 'app', interval: 'month', amount: { USD: 10 } },
        { sku: 'app', interval: 'once', amount: { USD: 200 } },
      ],
    },
    currencies: [USD],
    taxes: [],
  });

  const noHorizon = await q.quote({ sku: 'app', currency: 'USD', interval: 'month' }, { explore: true });
  assert.equal(noHorizon.insights.length, 0, 'no natural horizon exists, so refuse to invent one');

  // An explicit horizon does not unlock it either: at 3 years the subscription looks
  // worse, at 1 year it looks better, so the horizon would be deciding the answer rather
  // than revealing it.
  const longHorizon = await q.quote({ sku: 'app', currency: 'USD', interval: 'month' }, { explore: { horizonDays: 365 * 3 } });
  assert.equal(longHorizon.insights.length, 0);
  const shortHorizon = await q.quote({ sku: 'app', currency: 'USD', interval: 'month' }, { explore: { horizonDays: 30 } });
  assert.equal(shortHorizon.insights.length, 0);
});

test('an explicit horizon still applies to recurring-vs-recurring comparisons', async () => {
  const quote = await subscription().quote(
    { sku: 'pro', currency: 'USD', interval: 'month' },
    { explore: { horizonDays: 365.2425 * 2 } }
  );
  const insight = insightOf(quote, 'interval-upgrade');
  assert.ok(insight);
  assert.equal(insight.savings.baselineCost.minor, 24000, '24 monthly payments');
  assert.equal(insight.savings.alternativeCost.minor, 20000, '2 annual payments');
});

test('a tier that costs more but lowers the unit price reports zero savings, not a fake one', async () => {
  const q = new Quotes({
    catalog: {
      products: [{ sku: 'seat', variants: [{ id: 'buy' }], intervals: [{ unit: 'once' }] }],
      rules: [
        { sku: 'seat', amount: { USD: 10 } },
        { sku: 'seat', minQuantity: 5, amount: { USD: 8 } },
      ],
    },
    currencies: [USD],
    taxes: [],
  });
  const quote = await q.quote({ sku: 'seat', currency: 'USD', quantity: 1 }, { explore: true });
  const insight = insightOf(quote, 'tier-threshold');
  assert.ok(insight, 'expected a tier-threshold insight');
  assert.equal(insight.savings.amount.minor, 0, 'buying 5 costs more than buying 1; that is not a saving');
  assert.equal(insight.threshold.extraCost.minor, 3000, '$40 - $10');
  assert.equal(insight.threshold.unitPriceFrom.minor, 1000);
  assert.equal(insight.threshold.unitPriceTo.minor, 800);
  assert.ok(Math.abs(insight.threshold.unitPriceDropPercent - 0.2) < 1e-9);
  assert.equal(insight.dominant, false);
});

test('insights are ranked with dominant savings first', async () => {
  const q = new Quotes({
    catalog: {
      products: [{ sku: 'thing', variants: [{ id: 'buy' }], intervals: [{ unit: 'month' }, { unit: 'year' }] }],
      rules: [
        { sku: 'thing', interval: 'month', amount: { USD: 10 } },
        { sku: 'thing', interval: 'year', amount: { USD: 100 } },
        { sku: 'thing', interval: 'month', minQuantity: 2, amount: { USD: 4 } },
      ],
    },
    currencies: [USD],
    taxes: [],
  });
  const quote = await q.quote({ sku: 'thing', currency: 'USD', interval: 'month', quantity: 1 }, { explore: true });
  assert.ok(quote.insights.length >= 2);
  assert.equal(quote.insights[0].strength, 'dominant', 'buying 2 for $8 beats 1 for $10 outright');
  assert.equal(quote.insights[0].kind, 'volume-tier');
});

// ---------------------------------------------------------------------------
// Cost control
// ---------------------------------------------------------------------------

test('minSavingsPercent suppresses noise', async () => {
  const q = new Quotes({
    catalog: {
      products: [{ sku: 'pro', variants: [{ id: 'sub' }], intervals: [{ unit: 'month' }, { unit: 'year' }] }],
      rules: [
        { sku: 'pro', interval: 'month', amount: { USD: 10 } },
        // $119.88/yr vs $120 monthly: a 0.1% saving nobody cares about.
        { sku: 'pro', interval: 'year', amount: { USD: 119.88 } },
      ],
    },
    currencies: [USD],
    taxes: [],
  });
  const noisy = await q.quote({ sku: 'pro', currency: 'USD', interval: 'month' }, { explore: { minSavingsPercent: 0 } });
  assert.equal(noisy.insights.length, 1);
  const quiet = await q.quote({ sku: 'pro', currency: 'USD', interval: 'month' }, { explore: true });
  assert.equal(quiet.insights.length, 0, 'below the 1% default floor');
});

test('maxCandidates caps how many counterfactuals get priced', async () => {
  const rules = [{ sku: 'seat', amount: { USD: 100 } }];
  for (let n = 2; n <= 40; n++) rules.push({ sku: 'seat', minQuantity: n, amount: { USD: 100 - n } });
  const q = new Quotes({
    catalog: {
      products: [{ sku: 'seat', variants: [{ id: 'buy' }], intervals: [{ unit: 'once' }] }],
      rules,
    },
    currencies: [USD],
    taxes: [],
  });
  const capped = await q.quote({ sku: 'seat', currency: 'USD', quantity: 1 }, { explore: { maxCandidates: 3 } });
  assert.ok(capped.alternatives.length <= 3);
});

test('exploration reuses eligibility results rather than re-running callbacks per candidate', async () => {
  let calls = 0;
  const q = subscription({
    discounts: {
      PROMO: {
        rate: 0.1,
        isEligible: () => { calls += 1; return true; },
      },
    },
  });
  await q.quote({ sku: 'pro', currency: 'USD', interval: 'month', discountCodes: ['PROMO'] }, { explore: true });
  // One call for the baseline, one for the differently-priced annual candidate -- not one
  // per axis explored.
  assert.ok(calls <= 2, `expected memoized eligibility, got ${calls} calls`);
});

test('unrequested discount codes are not revealed unless explicitly asked for', async () => {
  const q = subscription({ discounts: { SECRET: { rate: 0.5 } } });

  const guarded = await q.quote({ sku: 'pro', currency: 'USD', interval: 'month' }, { explore: true });
  assert.equal(insightOf(guarded, 'discount-available'), undefined, 'must not leak codes by default');

  const opted = await q.quote({ sku: 'pro', currency: 'USD', interval: 'month' }, { explore: { discounts: true } });
  const insight = insightOf(opted, 'discount-available');
  assert.ok(insight);
  assert.equal(insight.quote.total.minor, 500);
});

test('explore options can disable individual axes', async () => {
  const quote = await subscription().quote(
    { sku: 'pro', currency: 'USD', interval: 'month' },
    { explore: { intervals: false } }
  );
  assert.equal(quote.insights.length, 0);
});

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

test('formatInsight renders the saving and its caveats', async () => {
  const quote = await subscription().quote({ sku: 'pro', currency: 'USD', interval: 'month' }, { explore: true });
  const text = formatInsight(insightOf(quote, 'interval-upgrade'));
  assert.match(text, /Switch to yearly billing/);
  assert.match(text, /\$20\.00/);
  assert.match(text, /17%/);
  assert.match(text, /assumes/);
});
