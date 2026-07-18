import { Quotes } from '../../core/quotes';
import type {
  Catalog,
  CurrencyMeta,
  DiscountConfig,
  Markup,
  PriceRule,
  Product,
  QuotesConfig,
  RateTable,
  TaxRule,
  Variant,
} from '../../core/types';
import {
  DEFAULT_SOURCES,
  loadDomainData,
  type DomainData,
  type DomainDataSources,
  type ExchangeRateData,
  type FetchLike,
} from './data';

export {
  clearDomainDataCache,
  DEFAULT_SOURCES,
  loadDomainData,
  parseUnifiedPricesCsv,
} from './data';
export type {
  DomainData,
  DomainDataSources,
  DomainPriceTable,
  ExchangeRateData,
  FetchLike,
  LoadOptions,
  ParsedPrices,
} from './data';

export const DEFAULT_VAT_RATE = 0.075;
export const DEFAULT_DOMAIN_CURRENCIES = ['USD', 'NGN'];

/**
 * Domain lifecycle variants.
 *
 * Note that none of these declare a `substitutionGroup`. That is deliberate and is the
 * whole reason the concept exists: `renew` is cheaper than `create`, but suggesting
 * "renew instead" to someone registering a new domain is a category error, not a saving.
 */
export const DOMAIN_VARIANTS: Variant[] = [
  { id: 'create', name: 'Registration' },
  { id: 'renew', name: 'Renewal' },
  { id: 'transfer', name: 'Transfer' },
  { id: 'restore', name: 'Restore' },
];

export type DomainVariant = 'create' | 'renew' | 'transfer' | 'restore';

/** Strips leading dots and lowercases. `.COM`, `..com` and `com` are all `com`. */
export function normalizeExtension (extension: string): string {
  if (!extension) return extension;
  return extension.trim().toLowerCase().replace(/^\.+/, '');
}

export interface DomainsPresetOptions {
  /** Injectable HTTP. Defaults to global fetch. */
  fetch?: FetchLike;
  sources?: Partial<DomainDataSources>;
  cache?: Map<string, Promise<unknown>> | false;
  /** Pre-loaded data; when supplied, no network access happens at all. */
  data?: DomainData;
  /** Single flat VAT rate. Defaults to 7.5%. Pass `0` for none. */
  vatRate?: number;
  /** Uppercase ISO codes to enable. Defaults to ['USD', 'NGN']. */
  currencies?: string[];
  /** Per-currency metadata overrides, e.g. to quote NGN in kobo rather than whole naira. */
  currencyOverrides?: Record<string, Partial<CurrencyMeta>>;
  markup?: Markup;
  discounts?: Record<string, DiscountConfig>;
  roundingPolicy?: 'per-step' | 'final';
  minChargeableTotal?: Record<string, number>;
  baseCurrency?: string;
}

function buildCurrencies (rates: ExchangeRateData[], options: DomainsPresetOptions): CurrencyMeta[] {
  const wanted = (options.currencies ?? DEFAULT_DOMAIN_CURRENCIES).map((c) => c.toUpperCase());
  const base = (options.baseCurrency ?? 'USD').toUpperCase();
  const codes = wanted.includes(base) ? wanted : [base, ...wanted];

  return codes.map((code) => {
    const info = rates.find((r) => r.currencyCode === code);
    const meta: CurrencyMeta = {
      code,
      symbol: code === 'USD' ? '$' : info?.currencySymbol ?? code,
      exponent: 2,
      // Naira are quoted in whole units in practice. This is what the old global
      // `allowFractionalAmounts: false` flag was really trying to express — but as a
      // property of the currency rather than of the call.
      roundingIncrement: code === 'NGN' ? 100 : 1,
      ...options.currencyOverrides?.[code],
    };
    return meta;
  });
}

function buildRateTable (rates: ExchangeRateData[], baseCurrency: string): RateTable {
  const table: RateTable = {};
  for (const rate of rates) {
    if (!rate?.currencyCode) continue;
    if (!Number.isFinite(rate.exchangeRate) || rate.exchangeRate <= 0) continue;
    table[rate.currencyCode.toUpperCase()] = rate.exchangeRate;
  }
  table[baseCurrency] = 1;
  return table;
}

function buildCatalog (data: DomainData): Catalog {
  const products: Product[] = [];
  const rules: PriceRule[] = [];

  const variantTables: Array<[DomainVariant, Record<string, Record<string, number>> | undefined]> = [
    ['renew', data.renew?.prices],
    ['transfer', data.transfer?.prices],
    ['restore', data.restore?.prices],
  ];

  // A TLD exists if it has a create price; that has always been the rule.
  for (const [tld, createMap] of Object.entries(data.create.prices)) {
    if (!createMap || Object.keys(createMap).length === 0) continue;

    const provider = data.create.providers[tld];
    products.push({
      sku: tld,
      groups: ['tld'],
      variants: DOMAIN_VARIANTS,
      intervals: [{ unit: 'year', count: 1 }],
      metadata: provider ? { provider } : undefined,
    });

    // Wildcard-variant rule: any variant without its own feed row is priced as create.
    rules.push({ sku: tld, amount: createMap, label: `create:${tld}` });

    for (const [variant, table] of variantTables) {
      const variantMap = table?.[tld];
      if (!variantMap || Object.keys(variantMap).length === 0) continue;
      // Merged, not replaced: a renew row quoting only NGN still needs a USD price, and
      // the feed expects it to fall back to create. This merge is exactly the kind of
      // source-data quirk that belongs in the preset rather than the engine.
      rules.push({ sku: tld, variant, amount: { ...createMap, ...variantMap }, label: `${variant}:${tld}` });
    }
  }

  return { products, rules, normalizeSku: normalizeExtension };
}

export function buildDomainsConfig (data: DomainData, options: DomainsPresetOptions = {}): QuotesConfig {
  const baseCurrency = (options.baseCurrency ?? 'USD').toUpperCase();
  const vatRate = typeof options.vatRate === 'number' ? options.vatRate : DEFAULT_VAT_RATE;
  const taxes: TaxRule[] = vatRate > 0 ? [{ id: 'vat', name: 'VAT', rate: vatRate }] : [];

  return {
    catalog: buildCatalog(data),
    currencies: buildCurrencies(data.rates, options),
    rates: buildRateTable(data.rates, baseCurrency),
    baseCurrency,
    taxes,
    markup: options.markup,
    discounts: options.discounts ?? {},
    roundingPolicy: options.roundingPolicy ?? 'per-step',
    minChargeableTotal: options.minChargeableTotal,
    defaults: {
      variant: 'create',
      interval: { unit: 'year', count: 1 },
      term: 1,
      quantity: 1,
      discountPolicy: 'max',
    },
  };
}

/**
 * Lazily-loaded domain pricing.
 *
 * Nothing is fetched until `load()` (or `quotes()`) is called, so importing this module
 * is free and works offline.
 */
export class DomainsPreset {
  private readonly options: DomainsPresetOptions;
  private loading?: Promise<QuotesConfig>;
  private loaded?: QuotesConfig;

  constructor (options: DomainsPresetOptions = {}) {
    this.options = options;
  }

  /** Fetches (once) and builds the config. Safe to call concurrently. */
  async load (): Promise<QuotesConfig> {
    if (this.loaded) return this.loaded;
    if (!this.loading) {
      this.loading = (async () => {
        const data =
          this.options.data ??
          (await loadDomainData({
            fetch: this.options.fetch,
            sources: this.options.sources,
            cache: this.options.cache,
          }));
        const config = buildDomainsConfig(data, this.options);
        this.loaded = config;
        return config;
      })().catch((error) => {
        this.loading = undefined; // allow a retry after a transient failure
        throw error;
      });
    }
    return this.loading;
  }

  /** The loaded config. Throws if `load()` has not completed. */
  get config (): QuotesConfig {
    if (!this.loaded) {
      throw new Error('domainsPreset: call `await preset.load()` before reading `.config`');
    }
    return this.loaded;
  }

  get isLoaded (): boolean {
    return this.loaded !== undefined;
  }

  /** Convenience: load and return a ready `Quotes` instance. */
  async quotes (): Promise<Quotes> {
    return new Quotes(await this.load());
  }
}

export function domainsPreset (options: DomainsPresetOptions = {}): DomainsPreset {
  return new DomainsPreset(options);
}
