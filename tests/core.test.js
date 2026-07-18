import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BelowMinimumChargeError,
  InvalidRequestError,
  NoPriceError,
  Quotes,
  UnknownSkuError,
  UnknownVariantError,
  UnsupportedCurrencyError,
  VariantNotEligibleError,
  formatMoney,
  quantize,
  toMajor,
} from '../dist/index.js';

const USD = { code: 'USD', symbol: '$', exponent: 2 };
const NGN = { code: 'NGN', symbol: '₦', exponent: 2, roundingIncrement: 100 };
const JPY = { code: 'JPY', symbol: '¥', exponent: 0 };

function simple (overrides = {}) {
  return new Quotes({
    catalog: {
      products: [{ sku: 'widget', groups: ['goods'], variants: [{ id: 'buy' }], intervals: [{ unit: 'once' }] }],
      rules: [{ sku: 'widget', amount: { USD: 10 } }],
    },
    currencies: [USD],
    taxes: [],
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Money and rounding
// ---------------------------------------------------------------------------

test('quantize applies the currency rounding increment', () => {
  assert.equal(quantize(USD, 1299.4), 1299);
  assert.equal(quantize(USD, 1299.5), 1300);
  // NGN quotes in whole naira: 100 minor units.
  assert.equal(quantize(NGN, 1250), 1300);
  assert.equal(quantize(NGN, 1249), 1200);
});

test('quantize corrects float representation error before rounding', () => {
  // 79.8 * 0.075 is exactly 5.985, but floats give 5.984999999999999. The old engine
  // rounded that artifact down to 5.98; a half-cent must round up.
  assert.equal(quantize(USD, 79.8 * 0.075 * 100), 599);
});

test('currencies with no minor unit round to whole units', () => {
  assert.equal(quantize(JPY, 1250.6), 1251);
  assert.equal(toMajor(JPY, 1251), 1251);
});

test('formatMoney shows only digits the rounding increment can express', () => {
  assert.equal(formatMoney(USD, { currency: 'USD', minor: 1299 }), '$12.99');
  assert.equal(formatMoney(NGN, { currency: 'NGN', minor: 2150000 }), '₦21,500');
});

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

test('prices a minimal one-time product', async () => {
  const quote = await simple().quote({ sku: 'widget', currency: 'USD' });
  assert.equal(quote.unitPrice.minor, 1000);
  assert.equal(quote.subtotal.minor, 1000);
  assert.equal(quote.total.minor, 1000);
  assert.equal(quote.variant, 'buy');
  assert.deepEqual(quote.insights, []);
});

test('subtotal is unitPrice x quantity x term', async () => {
  const q = new Quotes({
    catalog: {
      products: [{ sku: 'seat', variants: [{ id: 'sub' }], intervals: [{ unit: 'year' }] }],
      rules: [{ sku: 'seat', amount: { USD: 10 } }],
    },
    currencies: [USD],
    taxes: [],
  });
  const quote = await q.quote({ sku: 'seat', currency: 'USD', quantity: 3, term: 2 });
  assert.equal(quote.unitPrice.minor, 1000);
  assert.equal(quote.subtotal.minor, 6000);
});

test("per: 'line' rules ignore quantity", async () => {
  const q = new Quotes({
    catalog: {
      products: [{ sku: 'setup', variants: [{ id: 'buy' }], intervals: [{ unit: 'once' }] }],
      rules: [{ sku: 'setup', amount: { USD: 50 }, per: 'line' }],
    },
    currencies: [USD],
    taxes: [],
  });
  const quote = await q.quote({ sku: 'setup', currency: 'USD', quantity: 10 });
  assert.equal(quote.subtotal.minor, 5000);
});

test('markup is applied before discount and tax', async () => {
  const q = simple({
    markup: { type: 'percentage', value: 0.25 },
    taxes: [{ id: 'vat', name: 'VAT', rate: 0.1 }],
    discounts: { HALF: { rate: 0.5 } },
  });
  const quote = await q.quote({ sku: 'widget', currency: 'USD', discountCodes: ['HALF'] });
  assert.equal(quote.subtotal.minor, 1250, 'markup raises the base');
  assert.equal(quote.discount.minor, 625, 'discount applies to the marked-up base');
  assert.equal(quote.tax.minor, 63, 'tax applies to the discounted subtotal');
  assert.equal(quote.total.minor, 688);
});

test('fixed markup is expressed in the base currency', async () => {
  const q = simple({ markup: { type: 'fixed', value: 5 } });
  const quote = await q.quote({ sku: 'widget', currency: 'USD' });
  assert.equal(quote.subtotal.minor, 1500);
});

test('explain reports the matched rule and how the rate was derived', async () => {
  const quote = await simple().quote({ sku: 'widget', currency: 'USD' });
  assert.equal(quote.explain.rateSource, 'identity');
  assert.equal(quote.explain.baseAmount, 10);
  assert.equal(quote.explain.markedAmount, 10);
  assert.equal(quote.explain.ruleIndex, 0);
  assert.ok(quote.explain.steps.some((s) => s.label === 'total'));
});

// ---------------------------------------------------------------------------
// Currency
// ---------------------------------------------------------------------------

test('a price quoted directly in the target currency defines its own rate', async () => {
  const q = new Quotes({
    catalog: {
      products: [{ sku: 'com', variants: [{ id: 'create' }], intervals: [{ unit: 'year' }] }],
      rules: [{ sku: 'com', amount: { USD: 10, NGN: 1500 } }],
    },
    currencies: [USD, { ...NGN, roundingIncrement: 1 }],
    rates: { NGN: 150 },
    taxes: [],
  });
  const ngn = await q.quote({ sku: 'com', currency: 'NGN' });
  assert.equal(ngn.subtotal.minor, 150000, 'uses the direct NGN price, not USD x rate');
  assert.equal(ngn.explain.rateSource, 'direct');
});

test('falls back to the exchange rate when the currency is not quoted directly', async () => {
  const q = new Quotes({
    catalog: {
      products: [{ sku: 'com', variants: [{ id: 'create' }], intervals: [{ unit: 'year' }] }],
      rules: [{ sku: 'com', amount: { USD: 12 } }],
    },
    currencies: [USD, { ...NGN, roundingIncrement: 1 }],
    rates: { NGN: 150 },
    taxes: [],
  });
  const ngn = await q.quote({ sku: 'com', currency: 'NGN' });
  assert.equal(ngn.subtotal.minor, 180000);
  assert.equal(ngn.explain.rateSource, 'fx');
});

test('NGN rounds to whole naira by default', async () => {
  const q = new Quotes({
    catalog: {
      products: [{ sku: 'com', variants: [{ id: 'create' }], intervals: [{ unit: 'year' }] }],
      rules: [{ sku: 'com', amount: { USD: 10 } }],
    },
    currencies: [USD, NGN],
    rates: { NGN: 1500.6 },
    taxes: [],
  });
  const ngn = await q.quote({ sku: 'com', currency: 'NGN' });
  assert.equal(ngn.subtotal.minor % 100, 0, 'no kobo');
  assert.equal(toMajor(NGN, ngn.subtotal.minor), 15006);
});

// ---------------------------------------------------------------------------
// Rule precedence
// ---------------------------------------------------------------------------

test('rule precedence: exact sku beats group beats wildcard', async () => {
  const q = new Quotes({
    catalog: {
      products: [{ sku: 'com', groups: ['tld'], variants: [{ id: 'create' }], intervals: [{ unit: 'year' }] }],
      rules: [
        { amount: { USD: 30 } },
        { group: 'tld', amount: { USD: 20 } },
        { sku: 'com', amount: { USD: 10 } },
      ],
    },
    currencies: [USD],
    taxes: [],
  });
  assert.equal((await q.quote({ sku: 'com', currency: 'USD' })).subtotal.minor, 1000);
});

test('rule precedence: an explicit variant beats a wildcard-variant rule', async () => {
  const q = new Quotes({
    catalog: {
      products: [{ sku: 'com', variants: [{ id: 'create' }, { id: 'renew' }], intervals: [{ unit: 'year' }] }],
      rules: [
        { sku: 'com', amount: { USD: 10 } },
        { sku: 'com', variant: 'renew', amount: { USD: 14 } },
      ],
    },
    currencies: [USD],
    taxes: [],
  });
  assert.equal((await q.quote({ sku: 'com', variant: 'create', currency: 'USD' })).subtotal.minor, 1000);
  assert.equal((await q.quote({ sku: 'com', variant: 'renew', currency: 'USD' })).subtotal.minor, 1400);
});

test('rule precedence: a quantity tier beats the unbounded list price', async () => {
  const q = new Quotes({
    catalog: {
      products: [{ sku: 'seat', variants: [{ id: 'sub' }], intervals: [{ unit: 'month' }] }],
      rules: [
        { sku: 'seat', amount: { USD: 10 } },
        { sku: 'seat', minQuantity: 5, amount: { USD: 8 } },
      ],
    },
    currencies: [USD],
    taxes: [],
  });
  assert.equal((await q.quote({ sku: 'seat', currency: 'USD', quantity: 1 })).unitPrice.minor, 1000);
  assert.equal((await q.quote({ sku: 'seat', currency: 'USD', quantity: 5 })).unitPrice.minor, 800);
});

test('rule precedence: the higher matching tier wins when tiers overlap', async () => {
  const q = new Quotes({
    catalog: {
      products: [{ sku: 'seat', variants: [{ id: 'sub' }], intervals: [{ unit: 'month' }] }],
      rules: [
        { sku: 'seat', amount: { USD: 10 } },
        { sku: 'seat', minQuantity: 5, amount: { USD: 8 } },
        { sku: 'seat', minQuantity: 10, amount: { USD: 6 } },
      ],
    },
    currencies: [USD],
    taxes: [],
  });
  assert.equal((await q.quote({ sku: 'seat', currency: 'USD', quantity: 12 })).unitPrice.minor, 600);
});

test('rule precedence: later declaration wins an otherwise exact tie', async () => {
  const q = new Quotes({
    catalog: {
      products: [{ sku: 'com', variants: [{ id: 'create' }], intervals: [{ unit: 'year' }] }],
      rules: [
        { sku: 'com', amount: { USD: 10 } },
        { sku: 'com', amount: { USD: 12 } },
      ],
    },
    currencies: [USD],
    taxes: [],
  });
  assert.equal((await q.quote({ sku: 'com', currency: 'USD' })).subtotal.minor, 1200);
});

// ---------------------------------------------------------------------------
// Discounts
// ---------------------------------------------------------------------------

test('max policy applies only the highest discount; stack sums them', async () => {
  const discounts = {
    SMALL: { rate: 0.05 },
    BIG: { rate: 0.2 },
  };
  const q = simple({ discounts });
  const max = await q.quote({ sku: 'widget', currency: 'USD', discountCodes: ['SMALL', 'BIG'] });
  assert.equal(max.discount.minor, 200);
  assert.deepEqual(max.discounts.filter((d) => d.applied).map((d) => d.code), ['BIG']);

  const stacked = await q.quote({ sku: 'widget', currency: 'USD', discountCodes: ['SMALL', 'BIG'], discountPolicy: 'stack' });
  assert.equal(stacked.discount.minor, 250);
});

test('discounts are clamped to the subtotal so the total can never go negative', async () => {
  const q = simple({ discounts: { A: { rate: 0.8 }, B: { rate: 0.8 } }, taxes: [{ id: 'vat', name: 'VAT', rate: 0.1 }] });
  const quote = await q.quote({ sku: 'widget', currency: 'USD', discountCodes: ['A', 'B'], discountPolicy: 'stack' });
  assert.equal(quote.discount.minor, 1000);
  assert.equal(quote.taxable.minor, 0);
  assert.equal(quote.total.minor, 0);
});

test('discount date windows are honoured', async () => {
  const q = simple({ discounts: { XMAS: { rate: 0.5, startAt: '2024-12-01T00:00:00Z', endAt: '2024-12-26T00:00:00Z' } } });
  const inside = await q.quote({ sku: 'widget', currency: 'USD', discountCodes: ['XMAS'], now: Date.parse('2024-12-10T00:00:00Z') });
  assert.equal(inside.discount.minor, 500);
  const outside = await q.quote({ sku: 'widget', currency: 'USD', discountCodes: ['XMAS'], now: Date.parse('2025-01-10T00:00:00Z') });
  assert.equal(outside.discount.minor, 0);
});

test('request context reaches eligibility callbacks', async () => {
  // This is what makes tasks.yml task 1's emailDomain/countryCode constraints unnecessary
  // as first-class config fields.
  const seen = [];
  const q = simple({
    discounts: {
      CORP: {
        rate: 0.3,
        isEligible: (ctx) => {
          seen.push(ctx.context);
          return String(ctx.context?.email ?? '').endsWith('@acme.com');
        },
      },
    },
  });
  const yes = await q.quote({ sku: 'widget', currency: 'USD', discountCodes: ['CORP'], context: { email: 'a@acme.com' } });
  assert.equal(yes.discount.minor, 300);
  const no = await q.quote({ sku: 'widget', currency: 'USD', discountCodes: ['CORP'], context: { email: 'a@other.com' } });
  assert.equal(no.discount.minor, 0);
  assert.deepEqual(seen[0], { email: 'a@acme.com' });
});

test('a throwing eligibility callback skips the discount rather than failing the quote', async () => {
  const q = simple({ discounts: { BOOM: { rate: 0.5, isEligible: () => { throw new Error('nope'); } } } });
  const quote = await q.quote({ sku: 'widget', currency: 'USD', discountCodes: ['BOOM'] });
  assert.equal(quote.discount.minor, 0);
});

test('discount selectors filter by sku and variant', async () => {
  const q = new Quotes({
    catalog: {
      products: [
        { sku: 'com', groups: ['tld'], variants: [{ id: 'create' }, { id: 'renew' }], intervals: [{ unit: 'year' }] },
        { sku: 'xyz', groups: ['tld'], variants: [{ id: 'create' }], intervals: [{ unit: 'year' }] },
      ],
      rules: [{ group: 'tld', amount: { USD: 10 } }],
    },
    currencies: [USD],
    taxes: [],
    discounts: { NEWONLY: { rate: 0.5, skus: ['com'], variants: ['create'] } },
  });
  assert.equal((await q.quote({ sku: 'com', variant: 'create', currency: 'USD', discountCodes: ['NEWONLY'] })).discount.minor, 500);
  assert.equal((await q.quote({ sku: 'com', variant: 'renew', currency: 'USD', discountCodes: ['NEWONLY'] })).discount.minor, 0);
  assert.equal((await q.quote({ sku: 'xyz', variant: 'create', currency: 'USD', discountCodes: ['NEWONLY'] })).discount.minor, 0);
});

// ---------------------------------------------------------------------------
// Tax
// ---------------------------------------------------------------------------

test('multiple tax lines are itemized and summed', async () => {
  const q = simple({ taxes: [{ id: 'gst', name: 'GST', rate: 0.05 }, { id: 'pst', name: 'PST', rate: 0.07 }] });
  const quote = await q.quote({ sku: 'widget', currency: 'USD' });
  assert.equal(quote.taxes.length, 2);
  assert.equal(quote.taxes[0].amount.minor, 50);
  assert.equal(quote.taxes[1].amount.minor, 70);
  assert.equal(quote.tax.minor, 120);
  assert.equal(quote.total.minor, 1120);
});

test('a compound tax stacks on top of the preceding tax', async () => {
  const q = simple({ taxes: [{ id: 'gst', name: 'GST', rate: 0.05 }, { id: 'pst', name: 'PST', rate: 0.1, compound: true }] });
  const quote = await q.quote({ sku: 'widget', currency: 'USD' });
  // PST is charged on 10.00 + 0.50 rather than on 10.00.
  assert.equal(quote.taxes[1].amount.minor, 105);
  assert.equal(quote.total.minor, 1155);
});

test('an inclusive tax is extracted rather than added', async () => {
  const q = simple({ taxes: [{ id: 'vat', name: 'VAT', rate: 0.2, inclusive: true }] });
  const quote = await q.quote({ sku: 'widget', currency: 'USD' });
  assert.equal(quote.total.minor, 1000, 'the listed price already contained the tax');
  assert.equal(quote.tax.minor, 167);
});

test("basis: 'base' taxes the pre-discount amount", async () => {
  const q = simple({ taxes: [{ id: 'vat', name: 'VAT', rate: 0.1, basis: 'base' }], discounts: { HALF: { rate: 0.5 } } });
  const quote = await q.quote({ sku: 'widget', currency: 'USD', discountCodes: ['HALF'] });
  assert.equal(quote.tax.minor, 100, 'taxed on 10.00, not on 5.00');
  assert.equal(quote.total.minor, 600);
});

test('appliesTo scopes a tax to particular products', async () => {
  const q = new Quotes({
    catalog: {
      products: [
        { sku: 'book', groups: ['zero-rated'], variants: [{ id: 'buy' }], intervals: [{ unit: 'once' }] },
        { sku: 'gadget', groups: ['standard'], variants: [{ id: 'buy' }], intervals: [{ unit: 'once' }] },
      ],
      rules: [{ amount: { USD: 10 } }],
    },
    currencies: [USD],
    taxes: [{ id: 'vat', name: 'VAT', rate: 0.2, appliesTo: { groups: ['standard'] } }],
  });
  assert.equal((await q.quote({ sku: 'book', currency: 'USD' })).tax.minor, 0);
  assert.equal((await q.quote({ sku: 'gadget', currency: 'USD' })).tax.minor, 200);
});

test('a tax resolver can decide rules per request', async () => {
  const q = simple({
    taxes: (ctx) => (ctx.context?.country === 'NG' ? [{ id: 'vat', name: 'VAT', rate: 0.075 }] : []),
  });
  assert.equal((await q.quote({ sku: 'widget', currency: 'USD', context: { country: 'NG' } })).tax.minor, 75);
  assert.equal((await q.quote({ sku: 'widget', currency: 'USD', context: { country: 'US' } })).tax.minor, 0);
});

// ---------------------------------------------------------------------------
// Errors and validation
// ---------------------------------------------------------------------------

test('unknown sku, variant and currency raise typed errors with stable codes', async () => {
  const q = simple();
  await assert.rejects(() => q.quote({ sku: 'nope', currency: 'USD' }), (e) => e instanceof UnknownSkuError && e.code === 'ERR_UNKNOWN_SKU');
  await assert.rejects(() => q.quote({ sku: 'widget', variant: 'lease', currency: 'USD' }), (e) => e instanceof UnknownVariantError && e.code === 'ERR_UNKNOWN_VARIANT');
  await assert.rejects(() => q.quote({ sku: 'widget', currency: 'JPY' }), (e) => e instanceof UnsupportedCurrencyError && e.code === 'ERR_UNSUPPORTED_CURRENCY');
});

test('a product with no matching price rule raises NoPriceError', async () => {
  const q = new Quotes({
    catalog: {
      products: [{ sku: 'ghost', variants: [{ id: 'buy' }], intervals: [{ unit: 'once' }] }],
      rules: [{ sku: 'other', amount: { USD: 1 } }],
    },
    currencies: [USD],
    taxes: [],
  });
  await assert.rejects(() => q.quote({ sku: 'ghost', currency: 'USD' }), (e) => e instanceof NoPriceError);
});

test('quantity and term must be positive integers, and term must be 1 for one-time prices', async () => {
  const q = simple();
  await assert.rejects(() => q.quote({ sku: 'widget', currency: 'USD', quantity: 0 }), InvalidRequestError);
  await assert.rejects(() => q.quote({ sku: 'widget', currency: 'USD', quantity: 1.5 }), InvalidRequestError);
  await assert.rejects(() => q.quote({ sku: 'widget', currency: 'USD', term: 2 }), InvalidRequestError);
});

test('an ineligible restricted variant is rejected', async () => {
  const q = new Quotes({
    catalog: {
      products: [{ sku: 'ide', variants: [{ id: 'academic', requires: (ctx) => ctx.context?.edu === true }], intervals: [{ unit: 'year' }] }],
      rules: [{ sku: 'ide', amount: { USD: 10 } }],
    },
    currencies: [USD],
    taxes: [],
  });
  await assert.rejects(() => q.quote({ sku: 'ide', currency: 'USD' }), VariantNotEligibleError);
  assert.equal((await q.quote({ sku: 'ide', currency: 'USD', context: { edu: true } })).total.minor, 1000);
});

test('minChargeableTotal is a per-currency floor, and zero totals are legal without it', async () => {
  const free = simple({ discounts: { FREE: { rate: 1 } } });
  assert.equal((await free.quote({ sku: 'widget', currency: 'USD', discountCodes: ['FREE'] })).total.minor, 0);

  const floored = simple({ discounts: { FREE: { rate: 1 } }, minChargeableTotal: { USD: 0.5 } });
  await assert.rejects(
    () => floored.quote({ sku: 'widget', currency: 'USD', discountCodes: ['FREE'] }),
    (e) => e instanceof BelowMinimumChargeError && e.code === 'ERR_BELOW_MINIMUM_CHARGE'
  );
});

test('baseCurrency must be present in the currencies list', () => {
  assert.throws(
    () => new Quotes({ catalog: { products: [], rules: [] }, currencies: [USD], baseCurrency: 'EUR' }),
    InvalidRequestError
  );
});

// ---------------------------------------------------------------------------
// Normalized rate
// ---------------------------------------------------------------------------

test('normalized rate expresses cost per unit per day/month/year', async () => {
  const q = new Quotes({
    catalog: {
      products: [{ sku: 'pro', variants: [{ id: 'sub' }], intervals: [{ unit: 'year' }] }],
      rules: [{ sku: 'pro', amount: { USD: 365.2425 } }],
    },
    currencies: [USD],
    taxes: [],
  });
  const quote = await q.quote({ sku: 'pro', currency: 'USD' });
  assert.ok(Math.abs(quote.rate.perUnitPerDay - 1) < 0.001);
  assert.ok(Math.abs(quote.rate.perUnitPerYear - 365.2425) < 0.01);
});

test('one-time purchases have no normalized rate', async () => {
  const quote = await simple().quote({ sku: 'widget', currency: 'USD' });
  assert.equal(quote.rate, undefined);
});
