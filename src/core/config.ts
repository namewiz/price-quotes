import { CompiledCatalog } from './catalog';
import type { RateTable } from './currency';
import { InvalidRequestError } from './errors';
import { DEFAULT_INTERVAL, normalizeInterval, type Interval } from './interval';
import type { CurrencyMeta } from './money';
import type { DiscountConfig, DiscountPolicy, Markup, QuotesConfig, TaxResolver, TaxRule } from './types';

/** A `QuotesConfig` with every default filled in and the catalog compiled. */
export interface EngineConfig {
  catalog: CompiledCatalog;
  currencies: CurrencyMeta[];
  rates: RateTable;
  baseCurrency: string;
  taxes: TaxRule[] | TaxResolver;
  markup?: Markup;
  discounts: Record<string, DiscountConfig>;
  roundingPolicy: 'per-step' | 'final';
  minChargeableTotal?: Record<string, number>;
  defaults: {
    variant?: string;
    interval: Interval;
    term: number;
    quantity: number;
    discountPolicy: DiscountPolicy;
  };
}

export function normalizeConfig (config: QuotesConfig): EngineConfig {
  const baseCurrency = (config.baseCurrency ?? 'USD').toUpperCase();
  const currencies = config.currencies.map((c) => ({ ...c, code: c.code.toUpperCase() }));

  if (!currencies.some((c) => c.code === baseCurrency)) {
    throw new InvalidRequestError(
      `baseCurrency '${baseCurrency}' must appear in the currencies list (got: ${currencies.map((c) => c.code).join(', ') || 'none'})`
    );
  }

  const discounts: Record<string, DiscountConfig> = {};
  for (const [code, conf] of Object.entries(config.discounts ?? {})) {
    discounts[code.toUpperCase()] = conf;
  }

  return {
    catalog: new CompiledCatalog(config.catalog),
    currencies,
    rates: config.rates ?? {},
    baseCurrency,
    taxes: config.taxes ?? [],
    markup: config.markup,
    discounts,
    roundingPolicy: config.roundingPolicy ?? 'per-step',
    minChargeableTotal: config.minChargeableTotal,
    defaults: {
      variant: config.defaults?.variant,
      interval: normalizeInterval(config.defaults?.interval, DEFAULT_INTERVAL),
      term: config.defaults?.term ?? 1,
      quantity: config.defaults?.quantity ?? 1,
      discountPolicy: config.defaults?.discountPolicy ?? 'max',
    },
  };
}
