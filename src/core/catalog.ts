import { NoPriceError, UnknownSkuError } from './errors';
import type { IntervalUnit } from './interval';
import type { Catalog, PriceAmount, PriceRule, Product, Variant } from './types';

export interface RuleSelector {
  sku: string;
  groups: string[];
  variant: string;
  interval: IntervalUnit;
  quantity: number;
  term: number;
}

export interface MatchedRule {
  rule: PriceRule;
  index: number;
}

interface IndexedRule {
  rule: PriceRule;
  index: number;
}

/** Normalizes a price payload to major units keyed by uppercase currency code. */
export function toAmountMap (amount: PriceAmount, baseCurrency: string): Record<string, number> {
  if (typeof amount === 'number') {
    return Number.isFinite(amount) && amount > 0 ? { [baseCurrency]: amount } : {};
  }
  const map: Record<string, number> = {};
  for (const [code, value] of Object.entries(amount)) {
    const upper = code?.toUpperCase();
    if (!upper || !Number.isFinite(value) || value <= 0) continue;
    // Duplicate codes collapse to the cheapest, matching the old CSV merge behaviour.
    const existing = map[upper];
    map[upper] = existing === undefined ? value : Math.min(existing, value);
  }
  return map;
}

function asList (value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value : [value];
}

function rangeWidth (min: number | undefined, max: number | undefined): number {
  const lo = min ?? 1;
  const hi = max ?? Infinity;
  return hi - lo;
}

/**
 * Orders two ranges by specificity; positive means `a` is more specific.
 *
 * Width alone is not enough: `minQuantity: 5` and no bounds at all are both infinitely
 * wide, and subtracting gives NaN rather than a verdict. So compare how many bounds are
 * pinned first, then width where both are finite, then the higher lower-bound (a
 * `minQuantity: 10` tier is more specific than a `minQuantity: 5` one).
 */
function compareRange (
  aMin: number | undefined,
  aMax: number | undefined,
  bMin: number | undefined,
  bMax: number | undefined
): number {
  const aBounds = (aMin !== undefined ? 1 : 0) + (aMax !== undefined ? 1 : 0);
  const bBounds = (bMin !== undefined ? 1 : 0) + (bMax !== undefined ? 1 : 0);
  if (aBounds !== bBounds) return aBounds - bBounds;

  const aWidth = rangeWidth(aMin, aMax);
  const bWidth = rangeWidth(bMin, bMax);
  if (Number.isFinite(aWidth) && Number.isFinite(bWidth) && aWidth !== bWidth) return bWidth - aWidth;

  const aLow = aMin ?? 1;
  const bLow = bMin ?? 1;
  if (aLow !== bLow) return aLow - bLow;
  return 0;
}

/**
 * A catalog with rules indexed for lookup and precedence precomputed.
 *
 * Indexing matters: the domains preset produces one product per TLD and a rule per
 * (TLD, variant), which is several thousand rules. A linear scan per quote would be
 * visible in a checkout flow, and the insights engine prices many quotes per call.
 */
export class CompiledCatalog {
  readonly normalizeSku: (raw: string) => string;

  private readonly productsBySku = new Map<string, Product>();
  private readonly rulesBySku = new Map<string, IndexedRule[]>();
  private readonly rulesByGroup = new Map<string, IndexedRule[]>();
  private readonly wildcardRules: IndexedRule[] = [];

  constructor (catalog: Catalog) {
    this.normalizeSku = catalog.normalizeSku ?? ((raw: string) => raw);

    for (const product of catalog.products) {
      this.productsBySku.set(product.sku, product);
    }

    catalog.rules.forEach((rule, index) => {
      const entry: IndexedRule = { rule, index };
      const skus = asList(rule.sku);
      if (skus) {
        for (const sku of skus) push(this.rulesBySku, sku, entry);
      } else if (rule.group) {
        push(this.rulesByGroup, rule.group, entry);
      } else {
        this.wildcardRules.push(entry);
      }
    });
  }

  get products (): Product[] {
    return [...this.productsBySku.values()];
  }

  getProduct (rawSku: string): Product {
    const sku = this.normalizeSku(rawSku);
    const product = this.productsBySku.get(sku);
    if (!product) throw new UnknownSkuError(sku);
    return product;
  }

  hasProduct (rawSku: string): boolean {
    return this.productsBySku.has(this.normalizeSku(rawSku));
  }

  getVariant (product: Product, variantId: string): Variant | undefined {
    return product.variants.find((v) => v.id === variantId);
  }

  /** Every rule that could apply to this sku, before non-sku selectors are checked. */
  private candidates (sku: string, groups: string[]): IndexedRule[] {
    const out: IndexedRule[] = [];
    const bySku = this.rulesBySku.get(sku);
    if (bySku) out.push(...bySku);
    for (const group of groups) {
      const byGroup = this.rulesByGroup.get(group);
      if (byGroup) out.push(...byGroup);
    }
    out.push(...this.wildcardRules);
    return out;
  }

  private matches (rule: PriceRule, sel: RuleSelector): boolean {
    const skus = asList(rule.sku);
    if (skus && !skus.includes(sel.sku)) return false;
    if (rule.group && !sel.groups.includes(rule.group)) return false;
    const variants = asList(rule.variant);
    if (variants && !variants.includes(sel.variant)) return false;
    if (rule.interval !== undefined && rule.interval !== sel.interval) return false;
    if (rule.minQuantity !== undefined && sel.quantity < rule.minQuantity) return false;
    if (rule.maxQuantity !== undefined && sel.quantity > rule.maxQuantity) return false;
    if (rule.minTerm !== undefined && sel.term < rule.minTerm) return false;
    if (rule.maxTerm !== undefined && sel.term > rule.maxTerm) return false;
    return true;
  }

  /**
   * Picks the most specific matching rule via the precedence ladder from the design doc:
   * exact sku > group > wildcard, then narrower quantity range, then narrower term range,
   * then explicit variant, then explicit interval, then declaration order (later wins).
   */
  resolveRule (sel: RuleSelector): MatchedRule {
    const applicable = this.candidates(sel.sku, sel.groups).filter((c) => this.matches(c.rule, sel));
    if (applicable.length === 0) {
      throw new NoPriceError(
        `sku=${sel.sku} variant=${sel.variant} interval=${sel.interval} quantity=${sel.quantity} term=${sel.term}`
      );
    }

    let best = applicable[0];
    for (const candidate of applicable.slice(1)) {
      if (comparePrecedence(candidate, best) > 0) best = candidate;
    }
    return { rule: best.rule, index: best.index };
  }

  tryResolveRule (sel: RuleSelector): MatchedRule | undefined {
    try {
      return this.resolveRule(sel);
    } catch {
      return undefined;
    }
  }

  /**
   * Quantity tier boundaries declared for this sku/variant, ascending.
   *
   * The insights engine only ever explores breakpoints the catalog actually declares —
   * it never synthesizes a sweep of quantities.
   */
  quantityBreakpoints (sku: string, groups: string[], variant: string, interval: IntervalUnit): number[] {
    return this.breakpoints(sku, groups, variant, interval, 'minQuantity');
  }

  termBreakpoints (sku: string, groups: string[], variant: string, interval: IntervalUnit): number[] {
    return this.breakpoints(sku, groups, variant, interval, 'minTerm');
  }

  private breakpoints (
    sku: string,
    groups: string[],
    variant: string,
    interval: IntervalUnit,
    field: 'minQuantity' | 'minTerm'
  ): number[] {
    const seen = new Set<number>();
    for (const { rule } of this.candidates(sku, groups)) {
      const variants = asList(rule.variant);
      if (variants && !variants.includes(variant)) continue;
      if (rule.interval !== undefined && rule.interval !== interval) continue;
      const value = rule[field];
      if (value !== undefined && Number.isFinite(value) && value >= 1) seen.add(value);
    }
    return [...seen].sort((a, b) => a - b);
  }
}

function comparePrecedence (a: IndexedRule, b: IndexedRule): number {
  const scopeDiff = scopeRank(a.rule) - scopeRank(b.rule);
  if (scopeDiff !== 0) return scopeDiff;

  const qtyDiff = compareRange(a.rule.minQuantity, a.rule.maxQuantity, b.rule.minQuantity, b.rule.maxQuantity);
  if (qtyDiff !== 0) return qtyDiff;

  const termDiff = compareRange(a.rule.minTerm, a.rule.maxTerm, b.rule.minTerm, b.rule.maxTerm);
  if (termDiff !== 0) return termDiff;

  const variantDiff = (a.rule.variant ? 1 : 0) - (b.rule.variant ? 1 : 0);
  if (variantDiff !== 0) return variantDiff;

  const intervalDiff = (a.rule.interval ? 1 : 0) - (b.rule.interval ? 1 : 0);
  if (intervalDiff !== 0) return intervalDiff;

  return a.index - b.index;
}

function scopeRank (rule: PriceRule): number {
  if (rule.sku) return 2;
  if (rule.group) return 1;
  return 0;
}

function push (map: Map<string, IndexedRule[]>, key: string, entry: IndexedRule): void {
  const existing = map.get(key);
  if (existing) existing.push(entry);
  else map.set(key, [entry]);
}
