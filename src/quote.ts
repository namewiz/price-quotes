// Line computation and the public Quotes API. See design-docs/design-v2.md,
// "Line computation" and "Cart pricing and the public API".

import {
  Adjustment, AppliedAdjustment, AppliedTax, CartLine, CartQuote, CartRequest, CatalogConfig,
  LineQuote, PeriodTotal, Price, Tax,
} from "./types.js";
import { QuoteError } from "./errors.js";
import { evaluateConstraint, EvalContext } from "./constraints.js";
import { quantize, charmPrice, roundTax } from "./money.js";
import { normalizeSku, resolvePrice } from "./resolve.js";

export interface QuotesOptions {
  defaultTaxBehavior?: "inclusive" | "exclusive";
  normalizeSku?: (raw: string) => string;
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

function computeLine(
  config: CatalogConfig,
  line: CartLine,
  currency: string,
  asOf: number,
  cartContext: Record<string, string>,
  taxBehaviorDefault: "inclusive" | "exclusive",
  normalizeHook?: (raw: string) => string,
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

  // Unit-scoped: all rates share one base and combine additively (goal #4 - order independence).
  const markupRate = combineKind(eligibleAdjustments, "markup", "rate", Math.min);
  const feeRate = combineKind(eligibleAdjustments, "fee", "rate", Math.min);
  const discountRate = combineKind(eligibleAdjustments, "discount", "rate", Math.max);
  const netRateFactor = 1 + markupRate + feeRate - discountRate;
  const rateAdjustedUnit = quantize(price.baseUnitMinor * netRateFactor, meta.increment, price.quantization);

  const unitBasisAdjustments = eligibleAdjustments.filter((a) => a.type === "amount" && a.basis === "unit");
  const markupAmountUnit = combineKind(unitBasisAdjustments, "markup", "amount", Math.min);
  const feeAmountUnit = combineKind(unitBasisAdjustments, "fee", "amount", Math.min);
  const discountAmountUnit = combineKind(unitBasisAdjustments, "discount", "amount", Math.max);
  const unitBeforeCharm = Math.max(0, rateAdjustedUnit + markupAmountUnit + feeAmountUnit - discountAmountUnit);

  const unitMinor = charmPrice(unitBeforeCharm, price.charm, price.charmPosition);
  const subtotalMinor = unitMinor * line.quantity;
  if (!Number.isSafeInteger(subtotalMinor)) {
    throw new QuoteError("ERR_AMOUNT_OVERFLOW", `line "${line.ref ?? line.sku}": unit x quantity exceeds the safe integer range`);
  }

  // Line-scoped: `amount` adjustments with basis "line" (the default), applied after charm.
  const lineAdjustments = eligibleAdjustments.filter((a) => a.type === "amount" && a.basis === "line");
  const markupLine = combineKind(lineAdjustments, "markup", "amount", Math.min);
  const feeLine = combineKind(lineAdjustments, "fee", "amount", Math.min);
  const discountLine = combineKind(lineAdjustments, "discount", "amount", Math.max);
  const lineAdjustmentsMinor = markupLine + feeLine - discountLine;
  const taxableMinor = Math.max(0, subtotalMinor + lineAdjustmentsMinor);

  const appliedAdjustments: AppliedAdjustment[] = eligibleAdjustments.map((a) => {
    let amountMinor: number;
    if (a.type === "amount") {
      amountMinor = a.basis === "line" ? a.value : a.value * line.quantity;
    } else {
      amountMinor = Math.round(price.baseUnitMinor * a.value) * line.quantity;
    }
    return { id: a.id, kind: a.kind, label: a.label, amountMinor };
  });

  let taxChargedMinor = 0;
  let taxAddedMinor = 0;
  const appliedTaxes: AppliedTax[] = [];
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
    appliedTaxes.push({ id: t.id, label: t.label, rate: t.rate, chargedMinor: charged, addedMinor: added });
  }

  const totalMinor = taxableMinor + taxAddedMinor;

  return {
    ref: line.ref, sku, priceId: price.id, quantity: line.quantity, variant: price.variant, country: price.country,
    currency, frequency, interval: line.interval, listUnitMinor: price.baseUnitMinor, unitMinor, subtotalMinor,
    adjustments: appliedAdjustments, lineAdjustmentsMinor, taxes: appliedTaxes, taxChargedMinor, taxAddedMinor, totalMinor,
  };
}

function roundTaxNet(gross: number, rate: number): number {
  return roundTax(gross / (1 + rate));
}

export class Quotes {
  constructor(private config: CatalogConfig, private options: QuotesOptions = {}) {}

  quote(line: CartLine, currency: string, asOf: Date = new Date()): LineQuote {
    return computeLine(this.config, line, currency, asOf.getTime(), {}, this.options.defaultTaxBehavior ?? "exclusive", this.options.normalizeSku);
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
            this.options.defaultTaxBehavior ?? "exclusive", this.options.normalizeSku,
          ),
        );
      } catch (e) {
        if (e instanceof QuoteError) {
          throw new QuoteError(e.code, `line ${i} (sku "${request.lines[i].sku}"): ${e.message}`);
        }
        throw e;
      }
    }

    const groupMap = new Map<string, PeriodTotal>();
    for (const l of lines) {
      const key = `${l.frequency}:${l.interval ?? ""}`;
      let g = groupMap.get(key);
      if (!g) {
        g = { frequency: l.frequency, interval: l.interval, subtotalMinor: 0, adjustmentsMinor: 0, taxableMinor: 0, taxMinor: 0, totalMinor: 0 };
        groupMap.set(key, g);
      }
      g.subtotalMinor += l.subtotalMinor;
      g.adjustmentsMinor += l.lineAdjustmentsMinor;
      g.taxableMinor += l.subtotalMinor + l.lineAdjustmentsMinor;
      g.taxMinor += l.taxAddedMinor;
      g.totalMinor += l.totalMinor;
    }
    const groups = [...groupMap.values()];
    const dueNowMinor = groups.reduce((s, g) => s + g.totalMinor, 0);

    return { lines, groups, dueNowMinor, currency: request.currency, asOf: asOfDate.toISOString(), catalogHash: this.config.hash };
  }
}
