// Step 7-8 of Compilation: quantize at load, then validate merged taxes/adjustments and bound
// the unit price (charm floor/ceiling proof).

import { PriceDraft } from "./merge.js";
import { Adjustment, CurrencyMeta, Price, Tax } from "./types.js";
import { Issue } from "./errors.js";
import { quantize, charmPrice, MAX_BASE_UNIT_MINOR } from "./money.js";

export function compilePrices(drafts: PriceDraft[], currencies: Map<string, CurrencyMeta>): { prices: Price[]; issues: Issue[] } {
  const issues: Issue[] = [];
  const prices: Price[] = [];

  for (const d of drafts) {
    const meta = currencies.get(d.currency)!;
    const rawBase = d.priceAmount * 10 ** meta.exponent;
    const baseUnitMinor = quantize(rawBase, meta.increment, d.quantization);

    if (baseUnitMinor > MAX_BASE_UNIT_MINOR) {
      issues.push({
        code: "ERR_AMOUNT_TOO_LARGE", row: d.rows[0], column: "price_amount",
        message: `price "${d.id}" exceeds the maximum representable amount`,
      });
      continue;
    }
    if (d.charm !== "none" && meta.increment !== 1) {
      issues.push({
        code: "ERR_CHARM_INCREMENT_CONFLICT", row: d.rows[0], column: "charm",
        message: `charm "${d.charm}" is incompatible with ${d.currency}'s rounding increment (${meta.increment}); charm requires an increment of 1`,
      });
      continue;
    }

    const adjustments: Adjustment[] = [...d.adjustments.values()]
      .map((a) => ({
        id: a.id, kind: a.kind, label: a.label, type: a.type, basis: a.basis, stackable: a.stackable,
        constraints: a.constraints,
        value: a.type === "amount" ? quantize(a.value * 10 ** meta.exponent, meta.increment, d.quantization) : a.value,
      }))
      .sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));

    let ok = true;
    for (const kind of ["discount", "markup", "fee"] as const) {
      const ofKind = adjustments.filter((a) => a.kind === kind);
      const stackable = ofKind.filter((a) => a.stackable);
      const stackableTypes = new Set(stackable.map((a) => a.type));
      if (stackableTypes.size > 1) {
        issues.push({
          code: "ERR_MIXED_STACK_TYPES", row: d.rows[0], column: "adjustment_type",
          message: `price "${d.id}" mixes rate and amount ${kind} adjustments that are both stackable`,
        });
        ok = false;
      }
      const stackableRateSum = stackable.filter((a) => a.type === "rate").reduce((s, a) => s + a.value, 0);
      if (kind === "discount" && stackableRateSum > 1) {
        issues.push({
          code: "ERR_RATE_OUT_OF_RANGE", row: d.rows[0], column: "adjustment_value",
          message: `price "${d.id}"'s stackable discount rates sum to ${stackableRateSum}, above 1.0`,
        });
        ok = false;
      }
      for (const a of ofKind.filter((a) => a.type === "amount")) {
        if (kind === "discount" && a.value > baseUnitMinor * d.minQuantity) {
          issues.push({
            code: "ERR_DISCOUNT_EXCEEDS_PRICE", row: d.rows[0], column: "adjustment_value",
            message: `discount "${a.id}" (${a.value} minor units) exceeds the smallest line it could apply to (${baseUnitMinor * d.minQuantity})`,
          });
          ok = false;
        }
      }
    }
    if (!ok) continue;

    // Load-time bound: floor = base with every discount applied and no markup.
    const totalDiscountRate = adjustments.filter((a) => a.kind === "discount" && a.type === "rate").reduce((s, a) => s + a.value, 0);
    const unitAmountDiscounts = adjustments
      .filter((a) => a.kind === "discount" && a.type === "amount" && a.basis === "unit")
      .reduce((s, a) => s + a.value, 0);
    const floorAdjusted = Math.round(baseUnitMinor * (1 - Math.min(1, totalDiscountRate))) - unitAmountDiscounts;
    const floorUnit = Math.max(0, floorAdjusted);
    const floorCharmed = charmPrice(floorUnit, d.charm, d.charmPosition);
    if (floorCharmed < 0) {
      issues.push({
        code: "ERR_CHARM_UNDERFLOW", row: d.rows[0], column: "charm",
        message: `price "${d.id}"'s fully-discounted floor (${floorUnit} minor units) would charm to a negative amount under "${d.charm}" at position ${d.charmPosition}`,
        suggestion: `lower charm_position or set charm: none`,
      });
      continue;
    }

    const taxes: Tax[] = [...d.taxes.values()]
      .map((t) => ({ id: t.id, label: t.label, rate: t.rate, behavior: t.behavior, compound: t.compound, constraints: t.constraints }))
      .sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));

    prices.push({
      id: d.id, sku: d.sku, currency: d.currency, variant: d.variant, country: d.country,
      minQuantity: d.minQuantity, maxQuantity: d.maxQuantity,
      effectiveStart: d.effectiveStart ?? -Infinity, effectiveEnd: d.effectiveEnd,
      billingPeriod: d.billingPeriod,
      frequencyInterval: d.billingPeriod === "recurring:month" ? "month" : d.billingPeriod === "recurring:year" ? "year" : null,
      baseUnitMinor, quantization: d.quantization, charm: d.charm, charmPosition: d.charmPosition,
      taxes, adjustments,
    });
  }

  return { prices, issues };
}
