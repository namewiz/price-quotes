// Line computation and the public Quotes API.

import {
  Adjustment, AppliedCharge, AppliedTax, Band, BillingPeriod, CartLine, CartQuote, CartRequest, CatalogConfig,
  LineQuote, LineQuoteDebug, Price, Tax,
} from "./types.js";
import { QuoteError } from "./errors.js";
import { evaluateConstraint, EvalContext } from "./parse.js";
import { quantize, charmPrice } from "./primitives.js";

// ---- Price resolution ----
// Price resolution: alias normalize, then probe the specificity lattice, then band-select.

export function normalizeSku(config: CatalogConfig, raw: string, hook?: (raw: string) => string): string {
  const candidate = hook ? hook(raw) : raw;
  const sku = config.index.aliasToSku.get(candidate);
  if (!sku) {
    throw new QuoteError("ERR_UNKNOWN_SKU", `unknown SKU "${raw}"`);
  }
  return sku;
}

export interface ResolveQuery {
  sku: string;
  currency: string;
  billingPeriod: BillingPeriod;
  variant?: string;
  country?: string;
  quantity: number;
  asOf: number;
}

function bucketKey(sku: string, currency: string, billingPeriod: BillingPeriod, variant: string, country: string): string {
  return `${sku}|${currency}|${billingPeriod}|${variant}|${country}`;
}

function selectBand(bands: Band[], quantity: number, asOf: number): Band | undefined {
  return bands.find(
    (b) =>
      quantity >= b.minQuantity &&
      (b.maxQuantity === null || quantity <= b.maxQuantity) &&
      asOf >= b.effectiveStart &&
      (b.effectiveEnd === null || asOf < b.effectiveEnd),
  );
}

/** Probes (variant, country) -> (variant, *) -> (*, country) -> (*, *), first hit wins. */
export function resolvePrice(config: CatalogConfig, q: ResolveQuery): Price {
  const v = q.variant ?? "*";
  const c = q.country ?? "*";
  const candidates: [string, string][] = [[v, c]];
  if (v !== "*") candidates.push([v, "*"]);
  if (c !== "*") candidates.push(["*", c]);
  candidates.push(["*", "*"]);

  for (const [variant, country] of candidates) {
    const bucket = config.index.buckets.get(bucketKey(q.sku, q.currency, q.billingPeriod, variant, country));
    if (!bucket) continue;
    const band = selectBand(bucket.bands, q.quantity, q.asOf);
    if (band) return band.price;
  }
  throw new QuoteError("ERR_NO_PRICE", `no price covers sku=${q.sku} quantity=${q.quantity} at the given asOf`);
}

// ---- Line computation and the public Quotes API ----

export interface QuotesOptions {
  defaultTaxBehavior?: "inclusive" | "exclusive";
  normalizeSku?: (raw: string) => string;
  /** When true, every `LineQuote` gets a populated `debug` breakdown. Default false. */
  debug?: boolean;
}

function billingPeriodOf(frequency: "one-time" | "recurring", interval?: "month" | "year"): "one-time" | "recurring:month" | "recurring:year" {
  if (frequency === "one-time") return "one-time";
  if (!interval) throw new QuoteError("ERR_INVALID_REQUEST", "recurring lines require an interval");
  return `recurring:${interval}`;
}

function combineKind(adjustments: Adjustment[], kind: "discount" | "markup" | "fee", type: "rate" | "amount", pickBest: (a: number, b: number) => number): number {
  const ofKind = adjustments.filter((a) => a.kind === kind && a.type === type);
  const stackable = ofKind.filter((a) => a.stackable);
  const nonStackable = ofKind.filter((a) => !a.stackable);
  const stackSum = stackable.reduce((s, a) => s + a.value, 0);
  const best = nonStackable.reduce<number | null>((acc, a) => (acc === null ? a.value : pickBest(acc, a.value)), null);
  return stackSum + (best ?? 0);
}

/** Informational per-entry dollar amount for a charge, against whichever base it was applied to. */
function chargeAmount(a: Adjustment, base: number, quantity: number): number {
  if (a.type === "amount") return a.basis === "line" ? a.value : a.value * quantity;
  return Math.round(base * a.value) * quantity;
}

function toAppliedCharges(adjustments: Adjustment[], base: number, quantity: number): AppliedCharge[] {
  return adjustments.map((a) => ({ id: a.id, label: a.label, amount: chargeAmount(a, base, quantity) }));
}

function computeLine(
  config: CatalogConfig,
  line: CartLine,
  currency: string,
  asOf: number,
  cartContext: Record<string, string>,
  taxBehaviorDefault: "inclusive" | "exclusive",
  normalizeHook: ((raw: string) => string) | undefined,
  debug: boolean,
): LineQuote {
  if (!Number.isInteger(line.quantity) || line.quantity < 1) {
    throw new QuoteError("ERR_INVALID_REQUEST", `line "${line.ref ?? line.sku}" has an invalid quantity: ${line.quantity}`);
  }
  const frequency = line.frequency ?? "one-time";
  const billingPeriod = billingPeriodOf(frequency, line.interval);

  let sku: string;
  try {
    sku = normalizeSku(config, line.sku, normalizeHook);
  } catch {
    throw new QuoteError("ERR_UNKNOWN_SKU", `line "${line.ref ?? line.sku}": unknown SKU "${line.sku}"`);
  }
  const product = config.products.find((p) => p.sku === sku);
  if (!product || product.status === "inactive") {
    throw new QuoteError("ERR_UNKNOWN_SKU", `line "${line.ref ?? line.sku}": unknown or inactive SKU "${line.sku}"`);
  }
  if (!config.currencies.has(currency)) {
    throw new QuoteError("ERR_CURRENCY_NOT_IN_CATALOG", `currency "${currency}" has no price rows in this catalog`);
  }

  const price: Price = resolvePrice(config, {
    sku, currency, billingPeriod, variant: line.variant, country: line.country, quantity: line.quantity, asOf,
  });

  const preAdjustmentSubtotal = price.baseUnitMinor * line.quantity;
  const ctx: EvalContext = {
    ...cartContext,
    sku, variant: line.variant, currency, frequency, country_code: line.country,
    quantity: line.quantity, line_subtotal: preAdjustmentSubtotal,
  };

  const eligibleAdjustments = price.adjustments.filter((a) => !a.constraints || evaluateConstraint(a.constraints, ctx));
  const eligibleTaxes = price.taxes.filter((t) => !t.constraints || evaluateConstraint(t.constraints, ctx));

  const meta = config.currencies.get(currency)!;
  const unitBasisAdjustments = eligibleAdjustments.filter((a) => a.type === "amount" && a.basis === "unit");
  const lineBasisAdjustments = eligibleAdjustments.filter((a) => a.type === "amount" && a.basis === "line");

  // Stage 1 - markup: applied to the raw catalog price, folded into `unit.list`, never itemized
  // outside debug mode (business margin, not a customer-facing line item). No charm here — charm
  // is sale-price psychology, not the sticker price. Markup is always unit-basis (§3 of the
  // line-quote-shape design) — `adjustmentBasis` for a markup row is forced to "unit" at load.
  const markupRate = combineKind(eligibleAdjustments, "markup", "rate", Math.min);
  const markupAmountUnit = combineKind(unitBasisAdjustments, "markup", "amount", Math.min);
  const unitList = quantize(price.baseUnitMinor * (1 + markupRate) + markupAmountUnit, meta.increment, price.quantization);
  const extendedList = unitList * line.quantity;

  // Stage 2 - fee/discount: applied on top of `unit.list`, then charm -> `unit.sale`.
  const feeRate = combineKind(eligibleAdjustments, "fee", "rate", Math.min);
  const discountRate = combineKind(eligibleAdjustments, "discount", "rate", Math.max);
  const netRateFactor = 1 + feeRate - discountRate;
  const rateAdjustedUnit = quantize(unitList * netRateFactor, meta.increment, price.quantization);

  const feeAmountUnit = combineKind(unitBasisAdjustments, "fee", "amount", Math.min);
  const discountAmountUnit = combineKind(unitBasisAdjustments, "discount", "amount", Math.max);
  const unitBeforeCharm = Math.max(0, rateAdjustedUnit + feeAmountUnit - discountAmountUnit);

  const unitSale = charmPrice(unitBeforeCharm, price.charm, price.charmPosition);
  const extendedSale = unitSale * line.quantity;
  if (!Number.isSafeInteger(extendedSale)) {
    throw new QuoteError("ERR_AMOUNT_OVERFLOW", `line "${line.ref ?? line.sku}": unit x quantity exceeds the safe integer range`);
  }

  // Line-scoped: `amount` adjustments with basis "line" (the default for discount/fee), applied after charm.
  const feeLine = combineKind(lineBasisAdjustments, "fee", "amount", Math.min);
  const discountLine = combineKind(lineBasisAdjustments, "discount", "amount", Math.max);
  const lineNet = feeLine - discountLine;
  const taxableMinor = Math.max(0, extendedSale + lineNet);

  // `basis` only has meaning for `amount` adjustments — a `rate` adjustment always applies at the
  // unit level (Stage 2), so it is itemized as unit-basis regardless of its (irrelevant) basis field.
  const discountAdjustments = eligibleAdjustments.filter((a) => a.kind === "discount" && (a.type === "rate" || a.basis === "unit"));
  const feeAdjustments = eligibleAdjustments.filter((a) => a.kind === "fee" && (a.type === "rate" || a.basis === "unit"));
  const lineDiscountAdjustments = eligibleAdjustments.filter((a) => a.kind === "discount" && a.type === "amount" && a.basis === "line");
  const lineFeeAdjustments = eligibleAdjustments.filter((a) => a.kind === "fee" && a.type === "amount" && a.basis === "line");
  const markupAdjustments = eligibleAdjustments.filter((a) => a.kind === "markup");
  const discounts = toAppliedCharges(discountAdjustments, unitList, line.quantity);
  const fees = toAppliedCharges(feeAdjustments, unitList, line.quantity);
  const lineDiscounts = toAppliedCharges(lineDiscountAdjustments, unitList, line.quantity);
  const lineFees = toAppliedCharges(lineFeeAdjustments, unitList, line.quantity);

  let taxChargedMinor = 0;
  let taxAddedMinor = 0;
  const taxes: AppliedTax[] = [];
  const inclusiveTaxes: AppliedTax[] = [];
  let compoundBase = taxableMinor;
  for (const t of eligibleTaxes) {
    const behavior = t.behavior === "unspecified" ? taxBehaviorDefault : t.behavior;
    const base = t.compound ? compoundBase : taxableMinor;
    let charged: number;
    let added: number;
    if (behavior === "inclusive") {
      charged = base - quantize(base / (1 + t.rate), meta.increment, meta.roundingMode);
      added = 0;
    } else {
      charged = quantize(base * t.rate, meta.increment, meta.roundingMode);
      added = charged;
    }
    taxChargedMinor += charged;
    taxAddedMinor += added;
    compoundBase += added;
    if (added > 0) {
      taxes.push({ id: t.id, label: t.label, rate: t.rate, amount: added });
    } else {
      inclusiveTaxes.push({ id: t.id, label: t.label, rate: t.rate, amount: charged });
    }
  }

  const total = taxableMinor + taxAddedMinor;

  let debugInfo: LineQuoteDebug | undefined;
  if (debug) {
    debugInfo = {
      cost: price.baseUnitMinor,
      markup: toAppliedCharges(markupAdjustments, price.baseUnitMinor, line.quantity),
      tax: { inclusive: inclusiveTaxes, liability: taxChargedMinor },
    };
  }

  return {
    ref: line.ref, sku, priceId: price.id, quantity: line.quantity, variant: price.variant, country: price.country,
    currency, frequency, interval: line.interval,
    unit: { list: unitList, sale: unitSale },
    extended: { list: extendedList, sale: extendedSale },
    adjustments: { discounts, fees, lineDiscounts, lineFees, lineNet },
    tax: { base: taxableMinor, amount: taxAddedMinor, charges: taxes },
    total,
    debug: debugInfo,
  };
}

export class Quotes {
  constructor(private config: CatalogConfig, private options: QuotesOptions = {}) {}

  quote(line: CartLine, currency: string, asOf: Date = new Date()): LineQuote {
    return computeLine(
      this.config, line, currency, asOf.getTime(), {}, this.options.defaultTaxBehavior ?? "exclusive",
      this.options.normalizeSku, this.options.debug ?? false,
    );
  }

  quoteCart(request: CartRequest): CartQuote {
    const asOfDate = request.asOf ?? new Date();
    const asOf = asOfDate.getTime();
    const lines: LineQuote[] = [];
    for (let i = 0; i < request.lines.length; i++) {
      try {
        lines.push(
          computeLine(
            this.config, request.lines[i], request.currency, asOf, request.context ?? {},
            this.options.defaultTaxBehavior ?? "exclusive", this.options.normalizeSku, this.options.debug ?? false,
          ),
        );
      } catch (e) {
        if (e instanceof QuoteError) {
          throw new QuoteError(e.code, `line ${i} (sku "${request.lines[i].sku}"): ${e.message}`);
        }
        throw e;
      }
    }

    const amountDue = lines.reduce((s, l) => s + l.total, 0);

    return { lines, amountDue, currency: request.currency, asOf: asOfDate.toISOString(), catalogHash: this.config.hash };
  }
}
