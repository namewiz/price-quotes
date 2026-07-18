/**
 * Software licensing preset.
 *
 * This exists to prove the core abstraction against a second, genuinely different product
 * shape — seats instead of TLDs, monthly/annual/perpetual instead of a fixed one-year
 * term, volume and multi-year tiers instead of a flat per-TLD price. An abstraction
 * validated by only one consumer is usually just that consumer with the names filed off.
 */
import { Quotes } from '../../core/quotes';
import { USD } from '../../core/money';
import type {
  Catalog,
  CurrencyMeta,
  DiscountConfig,
  Markup,
  PriceAmount,
  PriceRule,
  Product,
  QuotesConfig,
  RateTable,
  TaxResolver,
  TaxRule,
  Variant,
} from '../../core/types';

export interface SoftwareSeatTier {
  /** Applies once the seat count reaches this number. */
  minSeats: number;
  monthly?: PriceAmount;
  annual?: PriceAmount;
  perpetual?: PriceAmount;
}

export interface SoftwareTermTier {
  /** Applies once the customer commits to this many years up front. */
  minYears: number;
  annual: PriceAmount;
}

export interface SoftwarePlanSpec {
  id: string;
  name?: string;
  groups?: string[];
  metadata?: Record<string, unknown>;
  /** Per-seat price for each billing shape. At least one is required. */
  monthly?: PriceAmount;
  annual?: PriceAmount;
  perpetual?: PriceAmount;
  /** Volume pricing. Drives 'volume-tier' and 'tier-threshold' insights. */
  seatTiers?: SoftwareSeatTier[];
  /** Multi-year commitment pricing. Drives 'term-upgrade' insights. */
  termTiers?: SoftwareTermTier[];
  /**
   * Extra variants beyond the default 'subscription' — e.g. academic or upgrade pricing.
   * Leave `substitutionGroup` unset unless the variant genuinely delivers the same value,
   * or the engine will suggest swapping to it as a "saving".
   */
  variants?: Variant[];
}

export interface SoftwarePresetOptions {
  plans: SoftwarePlanSpec[];
  currencies?: CurrencyMeta[];
  baseCurrency?: string;
  rates?: RateTable;
  taxes?: TaxRule[] | TaxResolver;
  markup?: Markup;
  discounts?: Record<string, DiscountConfig>;
  roundingPolicy?: 'per-step' | 'final';
  minChargeableTotal?: Record<string, number>;
}

const DEFAULT_VARIANT: Variant = { id: 'subscription', name: 'Subscription' };

function buildCatalog (plans: SoftwarePlanSpec[]): Catalog {
  const products: Product[] = [];
  const rules: PriceRule[] = [];

  for (const plan of plans) {
    const intervals: Product['intervals'] = [];
    if (plan.monthly !== undefined) intervals.push({ unit: 'month', count: 1 });
    if (plan.annual !== undefined) intervals.push({ unit: 'year', count: 1 });
    if (plan.perpetual !== undefined) intervals.push({ unit: 'once', count: 1 });

    if (intervals.length === 0) {
      throw new Error(`softwarePreset: plan '${plan.id}' declares no monthly, annual or perpetual price`);
    }

    products.push({
      sku: plan.id,
      name: plan.name,
      groups: plan.groups ?? ['software'],
      variants: plan.variants && plan.variants.length > 0 ? plan.variants : [DEFAULT_VARIANT],
      intervals,
      metadata: plan.metadata,
    });

    // List prices.
    if (plan.monthly !== undefined) rules.push({ sku: plan.id, interval: 'month', amount: plan.monthly, label: `${plan.id}:monthly` });
    if (plan.annual !== undefined) rules.push({ sku: plan.id, interval: 'year', amount: plan.annual, label: `${plan.id}:annual` });
    if (plan.perpetual !== undefined) rules.push({ sku: plan.id, interval: 'once', amount: plan.perpetual, label: `${plan.id}:perpetual` });

    // Volume tiers. Each is more specific than the list price by virtue of minQuantity.
    for (const tier of plan.seatTiers ?? []) {
      if (tier.monthly !== undefined) {
        rules.push({ sku: plan.id, interval: 'month', minQuantity: tier.minSeats, amount: tier.monthly, label: `${plan.id}:monthly:${tier.minSeats}+` });
      }
      if (tier.annual !== undefined) {
        rules.push({ sku: plan.id, interval: 'year', minQuantity: tier.minSeats, amount: tier.annual, label: `${plan.id}:annual:${tier.minSeats}+` });
      }
      if (tier.perpetual !== undefined) {
        rules.push({ sku: plan.id, interval: 'once', minQuantity: tier.minSeats, amount: tier.perpetual, label: `${plan.id}:perpetual:${tier.minSeats}+` });
      }
    }

    // Multi-year commitment tiers.
    for (const tier of plan.termTiers ?? []) {
      rules.push({ sku: plan.id, interval: 'year', minTerm: tier.minYears, amount: tier.annual, label: `${plan.id}:annual:${tier.minYears}yr+` });
    }
  }

  return { products, rules, normalizeSku: (raw: string) => raw.trim().toLowerCase() };
}

export function softwarePreset (options: SoftwarePresetOptions): QuotesConfig {
  const baseCurrency = (options.baseCurrency ?? 'USD').toUpperCase();
  const currencies = options.currencies ?? [USD];

  return {
    catalog: buildCatalog(options.plans),
    currencies,
    rates: options.rates ?? {},
    baseCurrency,
    taxes: options.taxes ?? [],
    markup: options.markup,
    discounts: options.discounts ?? {},
    roundingPolicy: options.roundingPolicy ?? 'per-step',
    minChargeableTotal: options.minChargeableTotal,
    defaults: {
      variant: undefined, // falls through to each product's first declared variant
      interval: { unit: 'month', count: 1 },
      term: 1,
      quantity: 1,
      discountPolicy: 'max',
    },
  };
}

/** Convenience: build the config and wrap it in a `Quotes` instance. */
export function softwareQuotes (options: SoftwarePresetOptions): Quotes {
  return new Quotes(softwarePreset(options));
}
