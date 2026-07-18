import { CompiledCatalog, toAmountMap } from './catalog';
import { findCurrency, fxRate, resolveRate } from './currency';
import { InvalidRequestError, NoPriceError, UnknownVariantError, VariantNotEligibleError, BelowMinimumChargeError } from './errors';
import { durationDays, intervalDays } from './interval';
import { money, quantize, toMajor, toMinor, type CurrencyMeta, type Money } from './money';
import type {
  DiscountConfig,
  DiscountLine,
  EligibilityContext,
  Explanation,
  Markup,
  NormalizedRate,
  Quote,
  ResolvedRequest,
  TaxLine,
  TaxRule,
} from './types';
import type { EngineConfig } from './config';

/**
 * Memoizes eligibility callbacks within a single `quote()` call.
 *
 * Exploration prices many candidates, each of which would otherwise re-run caller-supplied
 * (possibly async, possibly network-bound) callbacks. This is why `isEligible` is
 * documented as needing to be side-effect-free.
 */
export class EligibilityMemo {
  private readonly cache = new Map<string, Promise<boolean>>();

  run (key: string, fn: () => boolean | Promise<boolean>): Promise<boolean> {
    const existing = this.cache.get(key);
    if (existing) return existing;
    const result = Promise.resolve()
      .then(fn)
      .catch(() => false); // a throwing callback means "not eligible", as before
    this.cache.set(key, result);
    return result;
  }
}

export function applyMarkup (baseAmount: number, markup?: Markup): number {
  if (!markup) return baseAmount;
  const value = typeof markup.value === 'number' ? markup.value : 0;
  if (!Number.isFinite(value) || value <= 0) return baseAmount;
  switch (markup.type) {
    case 'percentage':
      return baseAmount + baseAmount * value;
    case 'fixed':
      return baseAmount + value;
    default:
      return baseAmount;
  }
}

function isWithinWindow (conf: DiscountConfig, nowMs: number): boolean {
  if (conf.startAt !== undefined) {
    const start = Date.parse(conf.startAt);
    if (Number.isNaN(start) || nowMs < start) return false;
  }
  if (conf.endAt !== undefined) {
    const end = Date.parse(conf.endAt);
    if (Number.isNaN(end) || nowMs > end) return false;
  }
  return true;
}

function selectorsMatch (conf: DiscountConfig, sku: string, groups: string[], variant: string): boolean {
  if (conf.skus && !conf.skus.includes(sku)) return false;
  if (conf.groups && !conf.groups.some((g) => groups.includes(g))) return false;
  if (conf.variants && !conf.variants.includes(variant)) return false;
  return true;
}

function taxApplies (rule: TaxRule, sku: string, groups: string[], variant: string): boolean {
  const scope = rule.appliesTo;
  if (!scope) return true;
  if (scope.skus && !scope.skus.includes(sku)) return false;
  if (scope.groups && !scope.groups.some((g) => groups.includes(g))) return false;
  if (scope.variants && !scope.variants.includes(variant)) return false;
  return true;
}

export interface PriceContext {
  config: EngineConfig;
  catalog: CompiledCatalog;
  memo: EligibilityMemo;
  nowMs: number;
  discountCodes: string[];
  discountPolicy: 'stack' | 'max';
}

export async function priceQuote (ctx: PriceContext, req: ResolvedRequest): Promise<Quote> {
  const { config, catalog } = ctx;

  if (!Number.isInteger(req.quantity) || req.quantity < 1) {
    throw new InvalidRequestError(`quantity must be a positive integer, got ${req.quantity}`);
  }
  if (!Number.isInteger(req.term) || req.term < 1) {
    throw new InvalidRequestError(`term must be a positive integer, got ${req.term}`);
  }
  if (req.interval.unit === 'once' && req.term !== 1) {
    throw new InvalidRequestError(`term must be 1 for a one-time interval, got ${req.term}`);
  }

  const product = catalog.getProduct(req.sku);
  const groups = product.groups ?? [];
  const variant = catalog.getVariant(product, req.variant);
  if (!variant) throw new UnknownVariantError(product.sku, req.variant);

  const meta = findMeta(config.currencies, req.currency);
  const perStep = config.roundingPolicy === 'per-step';
  const q = (raw: number): number => (perStep ? quantize(meta, raw) : raw);

  // --- resolve the price rule -------------------------------------------------
  const matched = catalog.resolveRule({
    sku: product.sku,
    groups,
    variant: req.variant,
    interval: req.interval.unit,
    quantity: req.quantity,
    term: req.term,
  });

  const amounts = toAmountMap(matched.rule.amount, config.baseCurrency);
  let baseAmount = amounts[config.baseCurrency];
  if (baseAmount === undefined) {
    const direct = amounts[meta.code];
    if (direct === undefined) {
      throw new NoPriceError(`sku=${product.sku} variant=${req.variant} has no ${config.baseCurrency} or ${meta.code} amount`);
    }
    baseAmount = direct / fxRate(config.rates, config.baseCurrency, meta.code);
  }
  if (!(baseAmount > 0)) {
    throw new NoPriceError(`sku=${product.sku} variant=${req.variant} resolved to a non-positive amount`);
  }

  const { rate, source } = resolveRate(amounts, baseAmount, config.baseCurrency, meta.code, config.rates);
  const markedAmount = applyMarkup(baseAmount, config.markup);

  // --- variant eligibility ----------------------------------------------------
  const unitMinor = q(toMinor(meta, markedAmount * rate));
  const lineMinor = matched.rule.per === 'line' ? unitMinor * req.term : unitMinor * req.quantity * req.term;
  const subtotalMinor = q(lineMinor);

  if (variant.requires) {
    const eligibleCtx = eligibilityContext(req, meta, subtotalMinor);
    const ok = await ctx.memo.run(`variant:${product.sku}:${variant.id}:${memoKey(eligibleCtx)}`, () =>
      variant.requires!(eligibleCtx)
    );
    if (!ok) throw new VariantNotEligibleError(product.sku, variant.id);
  }

  // --- discounts --------------------------------------------------------------
  const lines: DiscountLine[] = [];
  const codes = [...new Set(ctx.discountCodes.map((c) => c.toUpperCase()))];
  for (const code of codes) {
    const conf = config.discounts[code];
    if (!conf) continue;
    if (!isWithinWindow(conf, ctx.nowMs)) continue;
    if (!selectorsMatch(conf, product.sku, groups, req.variant)) continue;
    if (conf.isEligible) {
      const eligibleCtx = { ...eligibilityContext(req, meta, subtotalMinor), discountCode: code };
      const ok = await ctx.memo.run(`discount:${code}:${memoKey(eligibleCtx)}`, () => conf.isEligible!(eligibleCtx));
      if (!ok) continue;
    }
    lines.push({ code, rate: conf.rate, amount: money(meta.code, q(subtotalMinor * conf.rate)), applied: false });
  }

  let discountMinor = 0;
  if (lines.length > 0) {
    if (ctx.discountPolicy === 'stack') {
      discountMinor = q(lines.reduce((sum, l) => sum + l.amount.minor, 0));
      for (const l of lines) l.applied = true;
    } else {
      const best = lines.reduce((a, b) => (b.amount.minor > a.amount.minor ? b : a));
      best.applied = true;
      discountMinor = best.amount.minor;
    }
  }
  // Clamp so the total can never go negative, however the discounts stack.
  if (discountMinor > subtotalMinor) discountMinor = subtotalMinor;

  const taxableMinor = q(subtotalMinor - discountMinor);

  // --- tax --------------------------------------------------------------------
  const taxRules = await resolveTaxRules(config, product.sku, groups, req.variant, req.context);
  const taxLines: TaxLine[] = [];
  // Two running totals, because inclusive tax is real tax that must be reported, but it
  // is already inside the listed price and so must not raise what the customer pays.
  let addedMinor = 0; // exclusive tax only: what gets added to the total
  let taxTotalMinor = 0; // every tax line: what the customer is actually charged in tax
  for (const taxRule of taxRules) {
    if (!taxApplies(taxRule, product.sku, groups, req.variant)) continue;
    const basisMinor = taxRule.basis === 'base' ? subtotalMinor : taxableMinor;
    const baseForRule = taxRule.compound ? basisMinor + addedMinor : basisMinor;
    const amountMinor = taxRule.inclusive
      ? q(baseForRule - baseForRule / (1 + taxRule.rate))
      : q(baseForRule * taxRule.rate);
    taxLines.push({
      id: taxRule.id,
      name: taxRule.name,
      rate: taxRule.rate,
      inclusive: taxRule.inclusive ?? false,
      amount: money(meta.code, quantize(meta, amountMinor)),
    });
    taxTotalMinor += amountMinor;
    if (!taxRule.inclusive) addedMinor += amountMinor;
  }

  const totalMinor = quantize(meta, taxableMinor + addedMinor);

  const floor = config.minChargeableTotal?.[meta.code];
  if (floor !== undefined) {
    const minMinor = quantize(meta, toMinor(meta, floor));
    if (totalMinor < minMinor) {
      throw new BelowMinimumChargeError(meta.code, toMajor(meta, totalMinor), floor);
    }
  }

  const explain: Explanation = {
    matchedRule: matched.rule,
    ruleIndex: matched.index,
    baseCurrency: config.baseCurrency,
    baseAmount,
    markedAmount,
    rate,
    rateSource: source,
    roundingPolicy: config.roundingPolicy,
    steps: [
      { label: 'unitPrice', minor: quantize(meta, unitMinor) },
      { label: 'subtotal', minor: quantize(meta, subtotalMinor) },
      { label: 'discount', minor: quantize(meta, discountMinor) },
      { label: 'taxable', minor: quantize(meta, taxableMinor) },
      { label: 'tax', minor: quantize(meta, taxTotalMinor) },
      { label: 'total', minor: totalMinor },
    ],
  };

  const total = money(meta.code, totalMinor);

  return {
    request: req,
    currency: meta,
    product: { sku: product.sku, name: product.name, groups, metadata: product.metadata },
    variant: req.variant,
    unitPrice: money(meta.code, quantize(meta, unitMinor)),
    subtotal: money(meta.code, quantize(meta, subtotalMinor)),
    discount: money(meta.code, quantize(meta, discountMinor)),
    discounts: lines,
    taxable: money(meta.code, quantize(meta, taxableMinor)),
    taxes: taxLines,
    tax: money(meta.code, quantize(meta, taxTotalMinor)),
    total,
    rate: normalizedRate(meta, total, req),
    explain,
    insights: [],
    alternatives: [],
  };
}

function normalizedRate (meta: CurrencyMeta, total: Money, req: ResolvedRequest): NormalizedRate | undefined {
  const days = durationDays(req.interval, req.term);
  if (!Number.isFinite(days) || days <= 0) return undefined;
  const perUnitPerDay = toMajor(meta, total.minor) / (req.quantity * days);
  return {
    currency: meta.code,
    perUnitPerDay,
    perUnitPerMonth: perUnitPerDay * intervalDays({ unit: 'month' }),
    perUnitPerYear: perUnitPerDay * intervalDays({ unit: 'year' }),
  };
}

async function resolveTaxRules (
  config: EngineConfig,
  sku: string,
  groups: string[],
  variant: string,
  context: Record<string, unknown> | undefined
): Promise<TaxRule[]> {
  if (typeof config.taxes === 'function') {
    return config.taxes({ sku, groups, variant, currency: config.baseCurrency, context });
  }
  return config.taxes;
}

function eligibilityContext (req: ResolvedRequest, meta: CurrencyMeta, subtotalMinor: number): EligibilityContext {
  return {
    sku: req.sku,
    variant: req.variant,
    interval: req.interval,
    term: req.term,
    quantity: req.quantity,
    currency: meta.code,
    subtotal: toMajor(meta, subtotalMinor),
    context: req.context,
  };
}

function memoKey (ctx: EligibilityContext): string {
  return [ctx.sku, ctx.variant, ctx.interval.unit, ctx.interval.count ?? 1, ctx.term, ctx.quantity, ctx.currency, ctx.subtotal].join('|');
}

function findMeta (currencies: CurrencyMeta[], code: string): CurrencyMeta {
  return findCurrency(currencies, code);
}
