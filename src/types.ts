// Types for the CSV-catalog-driven quote engine.

/** Integer minor-unit amount. Validated at construction sites (see money.ts). */
export type Money = number;

/** Positive integer. Validated at the API boundary (see quotes.ts). */
export type Quantity = number;

export type Frequency = "one-time" | "recurring";
export type FrequencyInterval = "month" | "year";
/** Normalized single-token billing period axis. */
export type BillingPeriod = "one-time" | "recurring:month" | "recurring:year";

export type Quantization = "nearest" | "floor" | "ceil";
export type Charm = "none" | "to4" | "to9";
export type TaxBehavior = "inclusive" | "exclusive" | "unspecified";
export type AdjustmentKind = "discount" | "markup" | "fee";
export type AdjustmentType = "rate" | "amount";
export type AdjustmentBasis = "unit" | "line";
export type ProductStatus = "active" | "inactive";

/** Raw authoring row: one flat record. Optional fields may be omitted entirely
 * (from a JS object) or blank (from CSV) — both mean "use the default." */
export interface CatalogRowInput {
  product_sku: string;
  product_aliases?: string[] | string;
  product_name?: string;
  product_description?: string;
  product_status?: ProductStatus;
  product_family?: string;
  product_category?: string;
  product_type?: string;
  product_features?: Record<string, string> | string;
  product_tags?: string[] | string;
  created_at?: string;
  updated_at?: string;
  created_by?: string;

  price_id?: string;
  price_amount: number | string;
  product_variant?: string;
  price_effective_start?: string;
  price_effective_end?: string | null;
  min_quantity?: number | string;
  max_quantity?: number | string | null;
  currency?: string;
  currency_symbol?: string;
  currency_separator?: string;
  /** Currency-level rounding grid, in major units (e.g. "1" for NGN, "0.05" for CHF). See `CurrencyMeta.increment`. */
  currency_rounding?: number | string;
  /** Currency-level rounding mode for that grid. Default "nearest". See `CurrencyMeta.roundingMode`. */
  currency_rounding_mode?: Quantization;
  country_code?: string;
  locale?: string;
  quantization?: Quantization;
  charm?: Charm;
  charm_position?: number | string;
  frequency?: Frequency;
  frequency_interval?: FrequencyInterval | null;

  tax_id?: string;
  tax_label?: string;
  tax_rate?: number | string;
  tax_behavior?: TaxBehavior;
  tax_compound?: boolean | string;
  tax_constraints?: string;

  adjustment_id?: string;
  adjustment_kind?: AdjustmentKind;
  adjustment_label?: string;
  adjustment_type?: AdjustmentType;
  adjustment_basis?: AdjustmentBasis;
  adjustment_value?: number | string;
  adjustment_start?: string;
  adjustment_end?: string | null;
  adjustment_stackable?: boolean | string;
  adjustment_constraints?: string;

  /** 1-based source row number, for diagnostics. Set by the CSV parser. */
  __row?: number;
}

export interface CurrencyMetaInput {
  code: string;
  /** Minor-unit rounding increment, in minor units. Default 1 (no cash rounding). */
  increment?: number;
  /** Rounding mode applied at that increment, to both prices and tax. Default "nearest". */
  roundingMode?: Quantization;
  symbol?: string;
  locale?: string;
}

export interface CurrencyMeta {
  code: string;
  exponent: number;
  increment: number;
  roundingMode: Quantization;
  symbol?: string;
}

export interface CatalogDefaults extends Partial<Omit<CatalogRowInput, "product_sku" | "price_amount" | "__row">> {
  /** Per-currency [min, max] major-unit sanity range. Off by default (Adversarial 18). */
  price_sanity_range?: Record<string, [number, number]>;
  /**
   * Per-currency metadata overrides (rounding increment/mode, symbol) — take precedence over the
   * catalog's own `currency_rounding`/`currency_rounding_mode` columns when set. Exponents always
   * derive from Intl; increments have no Intl source, so a currency lacking both this and a
   * `currency_rounding` row falls back to increment 1 (no cash rounding).
   */
  currencies?: Record<string, CurrencyMetaInput>;
}

// ---- Constraint grammar ----

export type ConstraintOp = "=" | "!=" | ">" | ">=" | "<" | "<=" | "..";

export interface ConstraintClause {
  field: string;
  op: ConstraintOp;
  /** For "=" with multiple values this is an OR-set; for ".." a [lo, hi] tuple. */
  values: string[];
}

export interface ConstraintExpr {
  source: string;
  clauses: ConstraintClause[];
}

// ---- Compiled catalog ----

export interface Product {
  sku: string;
  aliases: string[];
  name: string;
  description: string;
  status: ProductStatus;
  family: string;
  category: string;
  type: string;
  features: Record<string, string>;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  createdBy: string;
}

export interface Tax {
  id: string;
  label: string;
  rate: number;
  behavior: TaxBehavior;
  compound: boolean;
  constraints: ConstraintExpr | null;
}

export interface Adjustment {
  id: string;
  kind: AdjustmentKind;
  label: string;
  type: AdjustmentType;
  basis: AdjustmentBasis;
  /** rate: fraction in [0,1]. amount: integer minor units (quantized at load). */
  value: number;
  stackable: boolean;
  constraints: ConstraintExpr | null;
}

export interface Price {
  id: string;
  sku: string;
  currency: string;
  /** null = wildcard (matches any variant) */
  variant: string | null;
  /** null = wildcard (matches any country) */
  country: string | null;
  minQuantity: number;
  maxQuantity: number | null;
  effectiveStart: number; // epoch ms, inclusive
  effectiveEnd: number | null; // epoch ms, exclusive
  billingPeriod: BillingPeriod;
  frequencyInterval: FrequencyInterval | null;
  baseUnitMinor: number;
  quantization: Quantization;
  charm: Charm;
  charmPosition: number;
  taxes: Tax[];
  adjustments: Adjustment[];
}

export interface Band {
  minQuantity: number;
  maxQuantity: number | null;
  effectiveStart: number;
  effectiveEnd: number | null;
  price: Price;
}

export interface PriceBucket {
  bands: Band[];
}

export interface PriceIndex {
  aliasToSku: Map<string, string>;
  /** key = sku + currency + billingPeriod + variant + country, delimited ("*" for wildcard axes) */
  buckets: Map<string, PriceBucket>;
}

export interface CatalogConfig {
  products: Product[];
  prices: Price[];
  index: PriceIndex;
  hash: string;
  currencies: Map<string, CurrencyMeta>;
}

// ---- Cart / quote API ----

export interface CartLine {
  sku: string;
  quantity: number;
  variant?: string;
  frequency?: Frequency;
  interval?: FrequencyInterval;
  country?: string;
  ref?: string;
}

export interface CartRequest {
  currency: string;
  lines: CartLine[];
  asOf?: Date;
  context?: Record<string, string>;
}

/** A discount, fee, markup, or line-level charge, as shown to a customer. Integer minor units. */
export interface AppliedCharge {
  id: string;
  label: string;
  amount: number;
}

/** A tax that actually adds to the customer's bill (exclusive behavior). Integer minor units. */
export interface AppliedTax {
  id: string;
  label: string;
  rate: number;
  amount: number;
}

/**
 * Debug-only breakdown, populated when `QuotesOptions.debug` is true. Surfaces business
 * internals that are deliberately hidden from the plain `LineQuote` shape: the raw catalog
 * cost, any markup baked into `unit.list`, and any tax already baked into the price.
 */
export interface LineQuoteDebug {
  /** `Price.baseUnitMinor` — the raw catalog price, before markup. */
  cost: number;
  /** Markup entries folded into `unit.list`; never shown outside debug mode. */
  markup: AppliedCharge[];
  tax: {
    /** Taxes baked into the price (never added to the bill), with their extracted amount. */
    inclusive: AppliedTax[];
    /** Total real tax owed: exclusive taxes plus the extracted portion of inclusive ones. */
    liability: number;
  };
}

export interface LineQuote {
  ref?: string;
  sku: string;
  priceId: string;
  quantity: number;
  variant: string | null;
  country: string | null;
  currency: string;
  frequency: Frequency;
  interval?: FrequencyInterval;
  /** Per-unit amounts. `list` has any markup folded in; `sale` is what's actually charged. */
  unit: { list: number; sale: number };
  /** `unit.* × quantity`. */
  extended: { list: number; sale: number };
  adjustments: {
    /** Unit-basis discounts, valued against `unit.list`. */
    discounts: AppliedCharge[];
    /** Unit-basis fees. */
    fees: AppliedCharge[];
    /** Line-basis discounts. */
    lineDiscounts: AppliedCharge[];
    /** Line-basis fees. */
    lineFees: AppliedCharge[];
    /** `sum(lineFees) − sum(lineDiscounts)`. Signed. */
    lineNet: number;
  };
  tax: {
    /** The amount tax was computed on: `extended.sale + adjustments.lineNet`. */
    base: number;
    /** Total added to the bill; 0 when all applicable tax is inclusive. */
    amount: number;
    /** Only taxes that add to the bill. Inclusive (baked-in) taxes are omitted — see `debug`. */
    charges: AppliedTax[];
  };
  /** `tax.base + tax.amount`. */
  total: number;
  debug?: LineQuoteDebug;
}

export interface CartQuote {
  lines: LineQuote[];
  amountDue: number;
  currency: string;
  asOf: string;
  catalogHash: string;
}
