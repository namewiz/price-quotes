import assert from 'node:assert/strict';
import test from 'node:test';

import { Quotes, UnknownSkuError, toMajor } from '../dist/index.js';
import {
  DEFAULT_VAT_RATE,
  buildDomainsConfig,
  domainsPreset,
  normalizeExtension,
  parseUnifiedPricesCsv,
} from '../dist/presets/domains/index.js';
import { softwarePreset, softwareQuotes } from '../dist/presets/software/index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CREATE_CSV = `tld,provider,currency,amount
com,openprovider,USD,10
com,openprovider,NGN,15000
com,namecheap,USD,12
ng,nira,USD,20
xyz,namecheap,USD,2
`;

const RENEW_CSV = `tld,provider,currency,amount
com,openprovider,USD,14
`;

const TRANSFER_CSV = `tld,provider,currency,amount
com,openprovider,USD,11
`;

const RATES = [
  { countryCode: 'NG', currencyName: 'Nigerian Naira', currencySymbol: '₦', currencyCode: 'NGN', exchangeRate: 1600, inverseRate: 1 / 1600 },
];

function fakeFetch (log = []) {
  return async (url) => {
    log.push(url);
    if (url.includes('create')) return new Response(CREATE_CSV);
    if (url.includes('renew')) return new Response(RENEW_CSV);
    if (url.includes('transfer')) return new Response(TRANSFER_CSV);
    if (url.includes('exchange-rates')) return new Response(JSON.stringify(RATES));
    return new Response('not found', { status: 404 });
  };
}

const FIXTURE_DATA = {
  create: parseUnifiedPricesCsv(CREATE_CSV),
  renew: parseUnifiedPricesCsv(RENEW_CSV),
  transfer: parseUnifiedPricesCsv(TRANSFER_CSV),
  rates: RATES,
};

// ---------------------------------------------------------------------------
// CSV parsing
// ---------------------------------------------------------------------------

test('the cheapest provider row wins, and its owner is recorded', () => {
  const parsed = parseUnifiedPricesCsv(CREATE_CSV);
  assert.equal(parsed.prices.com.USD, 10, 'openprovider at 10 beats namecheap at 12');
  assert.equal(parsed.providers.com, 'openprovider');
  assert.equal(parsed.prices.com.NGN, 15000);
});

test('malformed rows are skipped rather than poisoning the table', () => {
  const parsed = parseUnifiedPricesCsv('tld,provider,currency,amount\nbad,row\ncom,op,USD,0\ncom,op,USD,9\nnet,op,USD,notanumber\n');
  assert.equal(parsed.prices.com.USD, 9);
  assert.equal(parsed.prices.net, undefined);
});

// ---------------------------------------------------------------------------
// Lazy, injectable loading
// ---------------------------------------------------------------------------

test('constructing a preset performs no I/O', async () => {
  const log = [];
  const preset = domainsPreset({ fetch: fakeFetch(log), cache: false });
  assert.equal(log.length, 0, 'nothing should be fetched until load() is called');
  assert.equal(preset.isLoaded, false);
  assert.throws(() => preset.config, /call `await preset.load\(\)`/);

  await preset.load();
  assert.ok(log.length > 0);
  assert.equal(preset.isLoaded, true);
});

test('load() is memoized and safe to call concurrently', async () => {
  const log = [];
  const preset = domainsPreset({ fetch: fakeFetch(log), cache: false });
  await Promise.all([preset.load(), preset.load(), preset.load()]);
  await preset.load();
  // One fetch per source, regardless of how many callers raced.
  assert.equal(log.length, 4, `expected 4 fetches, got ${log.length}: ${log.join(', ')}`);
});

test('a shared cache stops separate presets refetching the same sources', async () => {
  const log = [];
  const cache = new Map();
  const fetchImpl = fakeFetch(log);
  await domainsPreset({ fetch: fetchImpl, cache }).load();
  await domainsPreset({ fetch: fetchImpl, cache }).load();
  assert.equal(log.length, 4, 'the second preset should hit the cache');
});

test('a failed load does not poison the cache and can be retried', async () => {
  let attempt = 0;
  const fetchImpl = async (url) => {
    attempt += 1;
    if (attempt <= 1) throw Object.assign(new Error('boom'), { cause: { code: 'ENOTFOUND' } });
    return fakeFetch([])(url);
  };
  const cache = new Map();
  const failing = domainsPreset({ fetch: fetchImpl, cache });
  await assert.rejects(() => failing.load(), /failed to load remote pricing data/);
  // A transient blip must not permanently break the process.
  const config = await domainsPreset({ fetch: fetchImpl, cache }).load();
  assert.ok(config.catalog.products.length > 0);
});

test('pre-loaded data bypasses the network entirely', async () => {
  const log = [];
  const preset = domainsPreset({ data: FIXTURE_DATA, fetch: fakeFetch(log) });
  await preset.load();
  assert.equal(log.length, 0);
  assert.ok(preset.config.catalog.products.some((p) => p.sku === 'com'));
});

test('network diagnostics are preserved', async () => {
  const preset = domainsPreset({
    cache: false,
    fetch: async () => new Response('nope', { status: 429, statusText: 'Too Many Requests' }),
  });
  await assert.rejects(() => preset.load(), /rate limited by the remote host/);
});

// ---------------------------------------------------------------------------
// Domains catalog
// ---------------------------------------------------------------------------

test('extensions normalize by stripping leading dots and lowercasing', () => {
  assert.equal(normalizeExtension('.COM'), 'com');
  assert.equal(normalizeExtension('..ng'), 'ng');
  assert.equal(normalizeExtension('  org '), 'org');
  // Domains are not parsed; there is no longest-suffix matching.
  assert.equal(normalizeExtension('example.com'), 'example.com');
});

test('domains preset prices a create quote with 7.5% VAT by default', async () => {
  const q = new Quotes(buildDomainsConfig(FIXTURE_DATA));
  const quote = await q.quote({ sku: '.COM', currency: 'USD' });
  assert.equal(quote.request.sku, 'com');
  assert.equal(quote.variant, 'create');
  assert.equal(quote.subtotal.minor, 1000);
  assert.equal(quote.taxes[0].rate, DEFAULT_VAT_RATE);
  assert.equal(quote.tax.minor, 75);
  assert.equal(quote.total.minor, 1075);
  assert.equal(quote.product.metadata.provider, 'openprovider');
});

test('vatRate: 0 disables tax', async () => {
  const q = new Quotes(buildDomainsConfig(FIXTURE_DATA, { vatRate: 0 }));
  const quote = await q.quote({ sku: 'com', currency: 'USD' });
  assert.equal(quote.tax.minor, 0);
  assert.equal(quote.total.minor, 1000);
});

test('NGN quotes in whole naira using the directly quoted price', async () => {
  const q = new Quotes(buildDomainsConfig(FIXTURE_DATA, { vatRate: 0 }));
  const quote = await q.quote({ sku: 'com', currency: 'NGN' });
  assert.equal(quote.explain.rateSource, 'direct');
  assert.equal(toMajor(quote.currency, quote.total.minor), 15000);
  assert.equal(quote.total.minor % 100, 0, 'no kobo');
});

test('a TLD without a direct NGN price converts via the exchange rate', async () => {
  const q = new Quotes(buildDomainsConfig(FIXTURE_DATA, { vatRate: 0 }));
  const quote = await q.quote({ sku: 'ng', currency: 'NGN' });
  assert.equal(quote.explain.rateSource, 'fx');
  assert.equal(toMajor(quote.currency, quote.total.minor), 20 * 1600);
});

test('renew and transfer use their own feed prices; restore falls back to create', async () => {
  const q = new Quotes(buildDomainsConfig(FIXTURE_DATA, { vatRate: 0 }));
  assert.equal((await q.quote({ sku: 'com', variant: 'create', currency: 'USD' })).subtotal.minor, 1000);
  assert.equal((await q.quote({ sku: 'com', variant: 'renew', currency: 'USD' })).subtotal.minor, 1400);
  assert.equal((await q.quote({ sku: 'com', variant: 'transfer', currency: 'USD' })).subtotal.minor, 1100);
  // The feed publishes no restore prices, so restore is priced as create -- as before.
  assert.equal((await q.quote({ sku: 'com', variant: 'restore', currency: 'USD' })).subtotal.minor, 1000);
});

test('a variant price row merges with create rather than replacing it', async () => {
  // The renew feed quotes only USD for com, so the NGN price falls back to the create row
  // and the quote still resolves rather than erroring.
  const q = new Quotes(buildDomainsConfig(FIXTURE_DATA, { vatRate: 0 }));
  const renewUsd = await q.quote({ sku: 'com', variant: 'renew', currency: 'USD' });
  assert.equal(toMajor(renewUsd.currency, renewUsd.subtotal.minor), 14);

  const renewNgn = await q.quote({ sku: 'com', variant: 'renew', currency: 'NGN' });
  assert.equal(toMajor(renewNgn.currency, renewNgn.subtotal.minor), 15000);
});

test('a directly quoted currency price wins over a variant uplift in that currency', async () => {
  // com renews at $14 vs $10 to create, but the create row quotes NGN directly at 15000.
  // A directly quoted price is authoritative for its currency by design (see resolveRate),
  // so the NGN renew quote is 15000 -- identical to create, with the USD uplift not
  // reflected in NGN. This is an inherent consequence of letting source data pin a
  // currency's price directly; the fix is to publish an NGN renew row in the feed, not to
  // second-guess a directly quoted price in the engine.
  const q = new Quotes(buildDomainsConfig(FIXTURE_DATA, { vatRate: 0 }));
  const createNgn = await q.quote({ sku: 'com', variant: 'create', currency: 'NGN' });
  const renewNgn = await q.quote({ sku: 'com', variant: 'renew', currency: 'NGN' });
  assert.equal(renewNgn.subtotal.minor, createNgn.subtotal.minor);
  assert.equal(renewNgn.explain.rateSource, 'direct');
});

test('a TLD with no create price does not exist', async () => {
  const q = new Quotes(buildDomainsConfig(FIXTURE_DATA));
  await assert.rejects(() => q.quote({ sku: 'nosuchtld', currency: 'USD' }), UnknownSkuError);
});

test('domains declare no substitutable variants, so no lifecycle swaps are suggested', async () => {
  const q = new Quotes(buildDomainsConfig(FIXTURE_DATA, { vatRate: 0 }));
  const quote = await q.quote({ sku: 'com', variant: 'create', currency: 'USD' }, { explore: true });
  assert.equal(quote.insights.length, 0, 'renew is cheaper than create, and must never be offered as a saving');
});

test('preset.quotes() returns a ready engine', async () => {
  const engine = await domainsPreset({ data: FIXTURE_DATA }).quotes();
  assert.deepEqual(engine.listSkus(), ['com', 'ng', 'xyz']);
  assert.equal(engine.hasSku('.COM'), true);
  assert.equal(engine.hasSku('nope'), false);
  assert.deepEqual(engine.listCurrencies(), ['USD', 'NGN']);
});

test('currencyOverrides can restore kobo-level NGN pricing', async () => {
  const q = new Quotes(buildDomainsConfig(FIXTURE_DATA, { vatRate: 0.075, currencyOverrides: { NGN: { roundingIncrement: 1 } } }));
  const quote = await q.quote({ sku: 'com', currency: 'NGN' });
  assert.equal(quote.tax.minor, 112500, '15000 x 7.5% = 1125.00 exactly');
});

// ---------------------------------------------------------------------------
// Software preset
// ---------------------------------------------------------------------------

test('software preset prices per-seat monthly and annual plans', async () => {
  const q = softwareQuotes({ plans: [{ id: 'pro', monthly: 10, annual: 100 }] });
  const monthly = await q.quote({ sku: 'pro', currency: 'USD', interval: 'month', quantity: 3 });
  assert.equal(monthly.subtotal.minor, 3000);
  const annual = await q.quote({ sku: 'pro', currency: 'USD', interval: 'year', quantity: 3 });
  assert.equal(annual.subtotal.minor, 30000);
});

test('software preset surfaces the annual-vs-monthly saving', async () => {
  const q = softwareQuotes({ plans: [{ id: 'pro', monthly: 10, annual: 100 }] });
  const quote = await q.quote({ sku: 'pro', currency: 'USD', interval: 'month' }, { explore: true });
  const insight = quote.insights.find((i) => i.kind === 'interval-upgrade');
  assert.ok(insight);
  assert.equal(insight.savings.amount.minor, 2000);
});

test('software seat tiers drive volume pricing and insights', async () => {
  const q = softwareQuotes({
    plans: [{ id: 'pro', monthly: 10, seatTiers: [{ minSeats: 5, monthly: 8 }, { minSeats: 20, monthly: 6 }] }],
  });
  assert.equal((await q.quote({ sku: 'pro', currency: 'USD', quantity: 4 })).unitPrice.minor, 1000);
  assert.equal((await q.quote({ sku: 'pro', currency: 'USD', quantity: 5 })).unitPrice.minor, 800);
  assert.equal((await q.quote({ sku: 'pro', currency: 'USD', quantity: 25 })).unitPrice.minor, 600);

  const quote = await q.quote({ sku: 'pro', currency: 'USD', quantity: 4 }, { explore: true });
  const insight = quote.insights.find((i) => i.kind === 'volume-tier' || i.kind === 'tier-threshold');
  assert.ok(insight, 'crossing the 5-seat tier should be surfaced');
});

test('software term tiers drive multi-year insights', async () => {
  const q = softwareQuotes({ plans: [{ id: 'pro', annual: 100, termTiers: [{ minYears: 3, annual: 75 }] }] });
  assert.equal((await q.quote({ sku: 'pro', currency: 'USD', interval: 'year', term: 3 })).unitPrice.minor, 7500);

  const quote = await q.quote({ sku: 'pro', currency: 'USD', interval: 'year', term: 1 }, { explore: true });
  const insight = quote.insights.find((i) => i.kind === 'term-upgrade');
  assert.ok(insight);
  assert.equal(insight.savings.amount.minor, 7500, '3 x $100 vs 3 x $75');
});

test('software preset rejects a plan with no prices', () => {
  assert.throws(() => softwarePreset({ plans: [{ id: 'ghost' }] }), /declares no monthly, annual or perpetual price/);
});

test('a perpetual plan is priced as a one-time purchase', async () => {
  const q = softwareQuotes({ plans: [{ id: 'app', perpetual: 200 }] });
  const quote = await q.quote({ sku: 'app', currency: 'USD' });
  assert.equal(quote.total.minor, 20000);
  assert.equal(quote.rate, undefined, 'a perpetual licence has no per-day rate');
});
