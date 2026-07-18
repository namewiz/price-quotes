import type { RateTable } from './currency';
import type { Interval, IntervalUnit } from './interval';
import type { CurrencyMeta, Money } from './money';

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

/**
 * A price, expressed as major units per currency (`{ USD: 12.99, NGN: 20000 }`),
 * or a bare number meaning "this many major units of the base currency".
 */
export type PriceAmount = number | Record<string, number>;

export interface Variant {
  id: string;
  name?: string;
  /**
   * Variants are only ever compared against each other for savings when they share a
   * substitution group. Leaving this undefined (the default) means "never suggest
   * swapping to this" — which is what stops the engine telling someone registering a new
   * domain that `renew` is cheaper. Only set it for variants that deliver genuinely
   * equivalent value.
   */
  substitutionGroup?: string;
  /** Gate for restricted variants, e.g. academic pricing requiring a .edu address. */
  requires?: EligibilityCallback;
}

export interface Product {
  sku: string;
  name?: string;
  /** Tags for bulk price rules, e.g. 'gtld', 'cctld'. */
  groups?: string[];
  variants: Variant[];
  /** Which intervals are purchasable. Also bounds interval exploration. */
  intervals?: Interval[];
  /** Arbitrary passthrough, surfaced on the quote. The domains preset puts `provider` here. */
  metadata?: Record<string, unknown>;
}

export interface PriceRule {
  // --- selectors (omitted = matches anything) ---
  sku?: string | string[];
  group?: string;
  variant?: string | string[];
  interval?: IntervalUnit;
  /** Volume tier bounds, inclusive. */
  minQuantity?: number;
  maxQuantity?: number;
  /** Term tier bounds, inclusive. */
  minTerm?: number;
  maxTerm?: number;

  // --- payload ---
  amount: PriceAmount;
  /** 'unit' (default) multiplies by quantity; 'line' is a flat charge per line item. */
  per?: 'unit' | 'line';
  /** Free-form label surfaced in `quote.explain` for debugging. */
  label?: string;
}

export interface Catalog {
  products: Product[];
  rules: PriceRule[];
  /** Preset-supplied SKU normalization, e.g. the domains preset strips leading dots. */
  normalizeSku?: (raw: string) => string;
}

// ---------------------------------------------------------------------------
// Markup, discounts, tax
// ---------------------------------------------------------------------------

export type MarkupType = 'percentage' | 'fixed';

export interface Markup {
  type: MarkupType;
  /** A ratio for 'percentage' (0.2 = +20%), or major units of the base currency for 'fixed'. */
  value: number;
}

export interface EligibilityContext {
  sku: string;
  variant: string;
  interval: Interval;
  term: number;
  quantity: number;
  currency: string;
  /** Pre-discount line subtotal, in major units. */
  subtotal: number;
  discountCode?: string;
  /**
   * Opaque caller data forwarded from the request. This is what makes tasks.yml task 1's
   * meta constraints (email domain, country code, referrer) unnecessary as first-class
   * fields — put them here and branch on them in `isEligible`.
   */
  context?: Record<string, unknown>;
}

export type EligibilityCallback = (ctx: EligibilityContext) => boolean | Promise<boolean>;

export interface DiscountConfig {
  /** Fraction off, e.g. 0.1 for 10%. */
  rate: number;
  /** Restrict to these SKUs. Omit for all. */
  skus?: string[];
  /** Restrict to these product groups. Omit for all. */
  groups?: string[];
  /** Restrict to these variants. Omit for all. */
  variants?: string[];
  startAt?: string;
  endAt?: string;
  /**
   * Custom eligibility. Must be side-effect-free: with `explore` enabled it may be
   * consulted for several candidate configurations within one `quote()` call (results are
   * memoized per call, but the callback still runs more than once per quote).
   */
  isEligible?: EligibilityCallback;
}

export type DiscountPolicy = 'stack' | 'max';

export interface TaxRule {
  id: string;
  name: string;
  rate: number;
  jurisdiction?: string;
  appliesTo?: { skus?: string[]; groups?: string[]; variants?: string[] };
  /** The listed price already contains this tax; it is extracted rather than added. */
  inclusive?: boolean;
  /** Stacks on top of previously computed taxes rather than on the bare base. */
  compound?: boolean;
  /** 'subtotal' (default) taxes the post-discount amount; 'base' taxes pre-discount. */
  basis?: 'subtotal' | 'base';
}

export interface TaxContext {
  sku: string;
  groups: string[];
  variant: string;
  currency: string;
  context?: Record<string, unknown>;
}

export type TaxResolver = (ctx: TaxContext) => TaxRule[] | Promise<TaxRule[]>;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface QuotesConfig {
  catalog: Catalog;
  currencies: CurrencyMeta[];
  /** Units of each currency per 1 base unit. */
  rates?: RateTable;
  /** Defaults to 'USD'. */
  baseCurrency?: string;
  taxes?: TaxRule[] | TaxResolver;
  markup?: Markup;
  discounts?: Record<string, DiscountConfig>;
  /**
   * 'per-step' (default) quantizes after each pipeline stage, so every reported line
   * (subtotal, discount, each tax) is a whole, self-consistent amount. 'final' keeps full
   * precision until the total and quantizes only once.
   */
  roundingPolicy?: 'per-step' | 'final';
  /**
   * Optional per-currency floor, in major units keyed by currency code. A quote landing
   * below its currency's floor throws BelowMinimumChargeError. Currencies absent from the
   * map have no floor.
   *
   * Keyed by currency rather than a single number because a floor is a real amount of
   * money: "0.01" means something different in USD and NGN, and converting it would make
   * the floor drift with the exchange rate.
   */
  minChargeableTotal?: Record<string, number>;
  defaults?: {
    variant?: string;
    interval?: Interval;
    term?: number;
    quantity?: number;
    discountPolicy?: DiscountPolicy;
  };
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

export interface QuoteRequest {
  sku: string;
  variant?: string;
  interval?: Interval | IntervalUnit;
  /** How many intervals are bought at once. Defaults to 1. */
  term?: number;
  /** How many units. Defaults to 1. */
  quantity?: number;
  currency: string;
  discountCodes?: string[];
  discountPolicy?: DiscountPolicy;
  now?: number | Date;
  /** Opaque caller data forwarded to eligibility callbacks and the tax resolver. */
  context?: Record<string, unknown>;
}

export interface ResolvedRequest {
  sku: string;
  variant: string;
  interval: Interval;
  term: number;
  quantity: number;
  currency: string;
  context?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export interface DiscountLine {
  code: string;
  rate: number;
  amount: Money;
  /** False when the discount was eligible but lost to a higher one under the 'max' policy. */
  applied: boolean;
}

export interface TaxLine {
  id: string;
  name: string;
  rate: number;
  inclusive: boolean;
  amount: Money;
}

/** Cost per unit, per time. Major units, deliberately unrounded. Absent for one-time prices. */
export interface NormalizedRate {
  currency: string;
  perUnitPerDay: number;
  perUnitPerMonth: number;
  perUnitPerYear: number;
}

export interface Explanation {
  matchedRule: PriceRule;
  ruleIndex: number;
  baseCurrency: string;
  /** Pre-markup price in the base currency, major units. */
  baseAmount: number;
  /** Post-markup price in the base currency, major units. */
  markedAmount: number;
  rate: number;
  rateSource: 'direct' | 'fx' | 'identity';
  roundingPolicy: 'per-step' | 'final';
  steps: Array<{ label: string; minor: number }>;
}

export type InsightKind =
  | 'interval-upgrade'
  | 'term-upgrade'
  | 'volume-tier'
  | 'tier-threshold'
  | 'variant-swap'
  | 'discount-available';

export type InsightStrength = 'dominant' | 'strong' | 'info';

export interface Savings {
  currency: string;
  amount: Money;
  /** Fraction saved against the baseline, e.g. 0.167 for 16.7%. */
  percent: number;
  /** null when both options are one-time purchases and no horizon is needed. */
  horizonDays: number | null;
  baselineCost: Money;
  alternativeCost: Money;
}

export interface Insight {
  kind: InsightKind;
  strength: InsightStrength;
  alternative: ResolvedRequest;
  /** The fully priced counterfactual. */
  quote: Quote;
  savings: Savings;
  /** True when the alternative costs less outright, not merely less per unit per day. */
  dominant: boolean;
  /**
   * Set when the alternative buys more than was asked for — extra coverage in days, extra
   * units, or both. A 3-year registration suggested to someone asking for 1 year is not a
   * like-for-like saving, and the client needs to be able to say so.
   */
  providesExtra?: { days?: number; quantity?: number };
  /** Assumptions the saving depends on, for the client to surface. */
  assumes: string[];
  /** Populated for 'tier-threshold': what it costs to reach the cheaper bracket. */
  threshold?: {
    extraCost: Money;
    unitPriceFrom: Money;
    unitPriceTo: Money;
    unitPriceDropPercent: number;
  };
}

export interface Quote {
  request: ResolvedRequest;
  currency: CurrencyMeta;
  product: { sku: string; name?: string; groups: string[]; metadata?: Record<string, unknown> };
  variant: string;
  /** Price of one unit for one interval, post-markup, pre-discount, pre-tax. */
  unitPrice: Money;
  /** unitPrice x quantity x term (or x term alone for `per: 'line'` rules). */
  subtotal: Money;
  discount: Money;
  discounts: DiscountLine[];
  /** subtotal - discount; the amount tax is normally computed on. */
  taxable: Money;
  taxes: TaxLine[];
  tax: Money;
  total: Money;
  rate?: NormalizedRate;
  explain: Explanation;
  /** Empty unless `explore` was enabled. */
  insights: Insight[];
  /** The priced counterfactuals behind `insights`. Empty unless `explore` was enabled. */
  alternatives: Quote[];
}

export interface ExploreOptions {
  /** Compare other purchasable intervals. Default true. */
  intervals?: boolean | IntervalUnit[];
  /** Compare other term tiers. Default true. */
  terms?: boolean | number[];
  /** Compare other volume tiers. Default true. */
  quantities?: boolean | number[];
  /** Compare substitutable variants. Default true, but only declared groups are eligible. */
  variants?: boolean;
  /**
   * Surface configured discount codes the caller did not pass. Default FALSE: it reveals
   * codes the customer was not offered.
   */
  discounts?: boolean;
  /**
   * Comparison window for recurring options. Defaults to the longest candidate's duration.
   *
   * Does not enable one-time-vs-recurring comparisons: a perpetual licence and a
   * subscription are never compared, at any horizon, because the horizon alone would
   * decide the outcome.
   */
  horizonDays?: number;
  /** Hard cap on priced counterfactuals. Default 24. */
  maxCandidates?: number;
  /** Suppress savings below this fraction. Default 0.01 (1%). */
  minSavingsPercent?: number;
}

export interface QuoteOptions {
  explore?: boolean | ExploreOptions;
}

export type { Interval, IntervalUnit } from './interval';
export type { CurrencyMeta, Money } from './money';
export type { RateTable } from './currency';
