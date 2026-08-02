// Line computation and the public Quotes API.

import {
  Adjustment, AppliedCharge, AppliedTax, CartLine, CartQuote, CartRequest, CatalogConfig,
  LineQuote, LineQuoteDebug, Price, Tax,
} from "./types.js";
import { QuoteError } from "./errors.js";
import { evaluateConstraint, EvalContext } from "./constraints.js";
import { quantize, charmPrice, roundTax } from "./money.js";
import { normalizeSku, resolvePrice } from "./resolve.js";

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

  // Stage 1 - markup: applied to the raw catalog price, folded into `unitPrice`, never itemized
  // outside debug mode (business margin, not a customer-facing line item). No charm here — charm
  // is sale-price psychology, not the sticker price.
  const markupRate = combineKind(eligibleAdjustments, "markup", "rate", Math.min);
  const markupAmountUnit = combineKind(unitBasisAdjustments, "markup", "amount", Math.min);
  const unitPrice = quantize(price.baseUnitMinor * (1 + markupRate) + markupAmountUnit, meta.increment, price.quantization);
  const extendedUnitPrice = unitPrice * line.quantity;
  const markupAmountLine = combineKind(lineBasisAdjustments, "markup", "amount", Math.min);

  // Stage 2 - fee/discount: applied on top of `unitPrice`, then charm -> `salePrice`.
  const feeRate = combineKind(eligibleAdjustments, "fee", "rate", Math.min);
  const discountRate = combineKind(eligibleAdjustments, "discount", "rate", Math.max);
  const netRateFactor = 1 + feeRate - discountRate;
  const rateAdjustedUnit = quantize(unitPrice * netRateFactor, meta.increment, price.quantization);

  const feeAmountUnit = combineKind(unitBasisAdjustments, "fee", "amount", Math.min);
  const discountAmountUnit = combineKind(unitBasisAdjustments, "discount", "amount", Math.max);
  const unitBeforeCharm = Math.max(0, rateAdjustedUnit + feeAmountUnit - discountAmountUnit);

  const salePrice = charmPrice(unitBeforeCharm, price.charm, price.charmPosition);
  const extendedSalePrice = salePrice * line.quantity;
  if (!Number.isSafeInteger(extendedSalePrice)) {
    throw new QuoteError("ERR_AMOUNT_OVERFLOW", `line "${line.ref ?? line.sku}": unit x quantity exceeds the safe integer range`);
  }

  // Line-scoped: `amount` adjustments with basis "line" (the default), applied after charm.
  const feeLine = combineKind(lineBasisAdjustments, "fee", "amount", Math.min);
  const discountLine = combineKind(lineBasisAdjustments, "discount", "amount", Math.max);
  const netLineAdjustment = feeLine - discountLine;
  const taxableMinor = Math.max(0, extendedSalePrice + netLineAdjustment + markupAmountLine);

  const discountAdjustments = eligibleAdjustments.filter((a) => a.kind === "discount");
  const feeAdjustments = eligibleAdjustments.filter((a) => a.kind === "fee");
  const markupAdjustments = eligibleAdjustments.filter((a) => a.kind === "markup");
  const discounts = toAppliedCharges(discountAdjustments, unitPrice, line.quantity);
  const fees = toAppliedCharges(feeAdjustments, unitPrice, line.quantity);

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
      charged = base - roundTaxNet(base, t.rate);
      added = 0;
    } else {
      charged = roundTax(base * t.rate);
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
      costPrice: price.baseUnitMinor,
      markup: toAppliedCharges(markupAdjustments, price.baseUnitMinor, line.quantity),
      unitPrice,
      inclusiveTaxes,
      taxLiability: taxChargedMinor,
    };
  }

  return {
    ref: line.ref, sku, priceId: price.id, quantity: line.quantity, variant: price.variant, country: price.country,
    currency, frequency, interval: line.interval, unitPrice, extendedUnitPrice, salePrice, extendedSalePrice,
    discounts, fees, netLineAdjustment, taxes, tax: taxAddedMinor, total, debug: debugInfo,
  };
}

function roundTaxNet(gross: number, rate: number): number {
  return roundTax(gross / (1 + rate));
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
