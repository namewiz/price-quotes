// Orchestrates catalog compilation end to end.

import { CatalogConfig, CatalogDefaults, CatalogRowInput, ConstraintExpr, CurrencyMeta, Adjustment, Band, Price, PriceBucket, PriceIndex, Product, Tax } from "./types.js";
import { Issue, throwIfIssues } from "./errors.js";
import { parseCsvToRows, resolveRows, ResolvedRow } from "./parse.js";
import { quantize, charmPrice, MAX_BASE_UNIT_MINOR, buildCurrencyMeta, UnsupportedCurrencyError, computeCatalogHash } from "./primitives.js";

// ---- Merge ----
// Step 5-6 of Compilation: content-derived IDs and merging rows that describe the same price.

export interface ProductDraft {
  sku: string;
  aliases: Set<string>;
  name: string;
  description: string;
  status: "active" | "inactive";
  family: string;
  category: string;
  type: string;
  features: Record<string, string>;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  createdBy: string;
}

export interface TaxDraft {
  id: string;
  label: string;
  rate: number;
  behavior: "inclusive" | "exclusive" | "unspecified";
  compound: boolean;
  constraints: ConstraintExpr | null;
  row: number;
}

export interface AdjustmentDraft {
  id: string;
  kind: "discount" | "markup" | "fee";
  label: string;
  type: "rate" | "amount";
  basis: "unit" | "line";
  value: number;
  stackable: boolean;
  constraints: ConstraintExpr | null;
  row: number;
}

export interface PriceDraft {
  id: string;
  explicitId: boolean;
  sku: string;
  currency: string;
  variant: string | null;
  country: string | null;
  minQuantity: number;
  maxQuantity: number | null;
  effectiveStart: number | null;
  effectiveEnd: number | null;
  billingPeriod: "one-time" | "recurring:month" | "recurring:year";
  priceAmount: number;
  quantization: "nearest" | "floor" | "ceil";
  charm: "none" | "to4" | "to9";
  charmPosition: number;
  taxes: Map<string, TaxDraft>;
  adjustments: Map<string, AdjustmentDraft>;
  rows: number[];
}

function bound(v: number | null, openLabel: string): string {
  return v === null ? openLabel : String(v);
}

function priceKeyOf(r: ResolvedRow): string {
  return [
    r.sku, r.currency, r.variant ?? "*", r.countryCode ?? "*",
    r.minQuantity, bound(r.maxQuantity, "open"),
    bound(r.effectiveStart, "open"), bound(r.effectiveEnd, "open"),
    r.billingPeriod, r.priceAmount, r.quantization, r.charm, r.charmPosition,
  ].join("|");
}

function derivePriceId(r: ResolvedRow): string {
  return [
    r.sku, r.currency, r.variant ?? "*", r.minQuantity, bound(r.maxQuantity, ""), r.billingPeriod,
    bound(r.effectiveStart, ""),
  ].join(":");
}

function deriveTaxId(priceId: string, r: ResolvedRow): string {
  return r.taxIdRaw || [priceId, "tax", r.taxRate, r.taxBehavior, r.taxCompound].join(":");
}

function deriveAdjustmentId(priceId: string, r: ResolvedRow): string {
  return r.adjustmentIdRaw || [priceId, "adj", r.adjustmentKind, r.adjustmentType, r.adjustmentValue, r.adjustmentBasis].join(":");
}

export interface MergeResult {
  products: ProductDraft[];
  prices: PriceDraft[];
  issues: Issue[];
}

export function mergeRows(rows: ResolvedRow[]): MergeResult {
  const issues: Issue[] = [];
  const products = new Map<string, ProductDraft>();
  const priceById: Map<string, PriceDraft> = new Map(); // keyed by explicit price_id, to detect ERR_PRICE_ID_CONFLICT
  const priceByKey: Map<string, PriceDraft> = new Map(); // keyed by full price key, to merge redundant rows
  const priceList: PriceDraft[] = [];

  for (const r of rows) {
    let product = products.get(r.sku);
    if (!product) {
      product = {
        sku: r.sku, aliases: new Set(), name: r.name, description: r.description, status: r.status,
        family: r.family, category: r.category, type: r.type, features: {}, tags: [],
        createdAt: r.createdAt, updatedAt: r.updatedAt, createdBy: r.createdBy,
      };
      products.set(r.sku, product);
    }
    for (const a of r.aliases) product.aliases.add(a);
    for (const t of r.tags) if (!product.tags.includes(t)) product.tags.push(t);
    Object.assign(product.features, r.features);
    if (r.name) product.name = r.name;
    if (r.description) product.description = r.description;
    if (r.status) product.status = r.status;

    const key = priceKeyOf(r);
    let draft = priceByKey.get(key);
    if (!draft) {
      const id = r.priceIdRaw || derivePriceId(r);
      if (r.priceIdRaw) {
        const existing = priceById.get(r.priceIdRaw);
        if (existing) {
          issues.push({
            code: "ERR_PRICE_ID_CONFLICT",
            row: r.row,
            column: "price_id",
            message: `price_id "${r.priceIdRaw}" is reused with different price-block fields (also row ${existing.rows[0]})`,
          });
        }
      }
      draft = {
        id, explicitId: !!r.priceIdRaw, sku: r.sku, currency: r.currency, variant: r.variant, country: r.countryCode ?? null,
        minQuantity: r.minQuantity, maxQuantity: r.maxQuantity, effectiveStart: r.effectiveStart, effectiveEnd: r.effectiveEnd,
        billingPeriod: r.billingPeriod, priceAmount: r.priceAmount, quantization: r.quantization, charm: r.charm,
        charmPosition: r.charmPosition, taxes: new Map(), adjustments: new Map(), rows: [],
      };
      priceByKey.set(key, draft);
      if (r.priceIdRaw) priceById.set(r.priceIdRaw, draft);
      priceList.push(draft);
    }
    draft.rows.push(r.row);

    if (r.hasTax) {
      const taxId = deriveTaxId(draft.id, r);
      if (draft.taxes.has(taxId)) {
        issues.push({
          code: "ERR_DUPLICATE_ADJUSTMENT", row: r.row, column: "tax_id",
          message: `duplicate tax fact "${taxId}" on price "${draft.id}"`,
        });
      } else {
        draft.taxes.set(taxId, {
          id: taxId, label: r.taxLabel, rate: r.taxRate, behavior: r.taxBehavior, compound: r.taxCompound,
          constraints: r.taxConstraints, row: r.row,
        });
      }
    }
    if (r.hasAdjustment) {
      const adjId = deriveAdjustmentId(draft.id, r);
      if (draft.adjustments.has(adjId)) {
        issues.push({
          code: "ERR_DUPLICATE_ADJUSTMENT", row: r.row, column: "adjustment_id",
          message: `duplicate adjustment fact "${adjId}" on price "${draft.id}"`,
        });
      } else {
        draft.adjustments.set(adjId, {
          id: adjId, kind: r.adjustmentKind, label: r.adjustmentLabel, type: r.adjustmentType, basis: r.adjustmentBasis,
          value: r.adjustmentValue, stackable: r.adjustmentStackable, constraints: r.adjustmentConstraints, row: r.row,
        });
      }
    }
  }

  return { products: [...products.values()], prices: priceList, issues };
}

// ---- Validate / compile prices ----
// Step 7-8 of Compilation: quantize at load, then validate merged taxes/adjustments and bound
// the unit price (charm floor/ceiling proof).

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

// ---- Ambiguity & coverage checks, and the O(1) index ----
// Step 9 of Compilation: prove unambiguity, then build the O(1) index.

type AxisRelation = "eq" | "aSub" | "bSub" | "disjoint";

function perAxis(a: string | null, b: string | null): AxisRelation {
  if (a === null && b === null) return "eq";
  if (a === null) return "bSub"; // b is the specific one, a is the wildcard containing it
  if (b === null) return "aSub";
  return a === b ? "eq" : "disjoint";
}

type Combined = "eq" | "aSub" | "bSub" | "incomparable" | "disjoint";

function combine(v: AxisRelation, c: AxisRelation): Combined {
  if (v === "disjoint" || c === "disjoint") return "disjoint";
  if (v === "eq" && c === "eq") return "eq";
  const aOk = v !== "bSub" && c !== "bSub";
  const bOk = v !== "aSub" && c !== "aSub";
  if (aOk && !bOk) return "aSub";
  if (bOk && !aOk) return "bSub";
  return "incomparable";
}

function qtyRange(p: Price): [number, number] {
  return [p.minQuantity, p.maxQuantity === null ? Infinity : p.maxQuantity];
}
function winRange(p: Price): [number, number] {
  return [p.effectiveStart, p.effectiveEnd === null ? Infinity : p.effectiveEnd];
}
function rangesOverlap(a: [number, number], b: [number, number]): boolean {
  return a[0] <= b[1] && b[0] <= a[1];
}
function windowsOverlap(a: [number, number], b: [number, number]): boolean {
  return a[0] < b[1] && b[0] < a[1];
}
function contains(outer: [number, number], inner: [number, number]): boolean {
  return inner[0] >= outer[0] && inner[1] <= outer[1];
}
function rangeEqual(a: [number, number], b: [number, number]): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

type Verdict = "aDominatesB" | "bDominatesA" | "ambiguous" | "disjoint";

function dominance(a: Price, b: Price): Verdict {
  const vc = combine(perAxis(a.variant, b.variant), perAxis(a.country, b.country));
  if (vc === "disjoint") return "disjoint";

  const aQ = qtyRange(a), bQ = qtyRange(b);
  const aW = winRange(a), bW = winRange(b);
  if (!rangesOverlap(aQ, bQ) || !windowsOverlap(aW, bW)) return "disjoint";

  if (vc === "eq") {
    const equalRanges = rangeEqual(aQ, bQ) && rangeEqual(aW, bW);
    if (equalRanges) return "ambiguous";
    if (contains(bQ, aQ) && contains(bW, aW)) return "aDominatesB";
    if (contains(aQ, bQ) && contains(aW, bW)) return "bDominatesA";
    return "ambiguous";
  }
  if (vc === "aSub") {
    return contains(bQ, aQ) && contains(bW, aW) ? "aDominatesB" : "ambiguous";
  }
  if (vc === "bSub") {
    return contains(aQ, bQ) && contains(aW, bW) ? "bDominatesA" : "ambiguous";
  }
  return "ambiguous"; // incomparable
}

function fmtRange([lo, hi]: [number, number]): string {
  return `[${lo}, ${hi === Infinity ? "∞" : hi}]`;
}

export function checkAmbiguityAndCoverage(prices: Price[]): Issue[] {
  const issues: Issue[] = [];
  const groups = new Map<string, Price[]>();
  for (const p of prices) {
    const key = `${p.sku}|${p.currency}|${p.billingPeriod}`;
    const list = groups.get(key) ?? [];
    list.push(p);
    groups.set(key, list);
  }

  for (const [, group] of groups) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i], b = group[j];
        const verdict = dominance(a, b);
        if (verdict === "ambiguous") {
          issues.push({
            code: "ERR_AMBIGUOUS_PRICE",
            message: `prices "${a.id}" and "${b.id}" for "${a.sku}" have overlapping, non-dominating regions ` +
              `(quantity ${fmtRange(qtyRange(a))} vs ${fmtRange(qtyRange(b))})`,
          });
        }
      }
    }
    issues.push(...checkCoverage(group));
  }

  return issues;
}

function regionKey(p: Price): string {
  return `${p.variant ?? "*"}|${p.country ?? "*"}`;
}

function checkCoverage(group: Price[]): Issue[] {
  const issues: Issue[] = [];
  const byRegion = new Map<string, Price[]>();
  for (const p of group) {
    const key = regionKey(p);
    const list = byRegion.get(key) ?? [];
    list.push(p);
    byRegion.set(key, list);
  }

  for (const [region, prices] of byRegion) {
    const sorted = [...prices].sort((a, b) => a.minQuantity - b.minQuantity);
    for (let i = 0; i < sorted.length - 1; i++) {
      const cur = sorted[i], next = sorted[i + 1];
      // Only compare bands whose effective windows actually overlap in time.
      if (!windowsOverlap(winRange(cur), winRange(next))) continue;
      if (cur.maxQuantity === null) continue; // open ceiling: fine
      if (next.minQuantity > cur.maxQuantity + 1) {
        issues.push({
          code: "ERR_QUANTITY_GAP",
          message: `"${cur.sku}" (region ${region}) has an uncovered quantity range ` +
            `[${cur.maxQuantity + 1}, ${next.minQuantity - 1}]`,
        });
      }
    }

    // Window-gap sweep: boundaries formed by every effective-window edge in this region.
    const boundarySet = new Set<number>();
    for (const p of sorted) {
      boundarySet.add(p.effectiveStart);
      if (p.effectiveEnd !== null) boundarySet.add(p.effectiveEnd);
    }
    const boundaries = [...boundarySet].sort((a, b) => a - b);
    for (let i = 0; i < boundaries.length - 1; i++) {
      const lo = boundaries[i], hi = boundaries[i + 1];
      const mid = (lo + hi) / 2;
      const active = sorted.some((p) => p.effectiveStart <= mid && (p.effectiveEnd === null || mid < p.effectiveEnd));
      if (!active) {
        const before = sorted.some((p) => p.effectiveEnd !== null && p.effectiveEnd <= lo);
        const after = sorted.some((p) => p.effectiveStart >= hi);
        if (before && after) {
          issues.push({
            code: "ERR_WINDOW_GAP",
            message: `"${sorted[0].sku}" (region ${region}) has no price effective between ${new Date(lo).toISOString()} and ${new Date(hi).toISOString()}`,
          });
        }
      }
    }
  }
  return issues;
}

export function buildIndex(prices: Price[], products: Map<string, Product>): PriceIndex {
  const aliasToSku = new Map<string, string>();
  for (const product of products.values()) {
    for (const alias of product.aliases) aliasToSku.set(alias, product.sku);
    aliasToSku.set(product.sku, product.sku);
  }

  const buckets = new Map<string, PriceBucket>();
  for (const p of prices) {
    const product = products.get(p.sku);
    if (product && product.status === "inactive") continue;
    const key = `${p.sku}|${p.currency}|${p.billingPeriod}|${p.variant ?? "*"}|${p.country ?? "*"}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { bands: [] };
      buckets.set(key, bucket);
    }
    const band: Band = {
      minQuantity: p.minQuantity, maxQuantity: p.maxQuantity,
      effectiveStart: p.effectiveStart, effectiveEnd: p.effectiveEnd, price: p,
    };
    bucket.bands.push(band);
  }
  for (const bucket of buckets.values()) {
    bucket.bands.sort((a, b) => a.minQuantity - b.minQuantity);
  }

  return { aliasToSku, buckets };
}

// ---- Orchestrator ----

function finalizeProduct(d: ProductDraft): Product {
  return {
    sku: d.sku, aliases: [...d.aliases], name: d.name, description: d.description, status: d.status,
    family: d.family, category: d.category, type: d.type, features: d.features, tags: d.tags,
    createdAt: d.createdAt, updatedAt: d.updatedAt, createdBy: d.createdBy,
  };
}

function checkAliasConflicts(products: Product[]): Issue[] {
  const issues: Issue[] = [];
  const owner = new Map<string, string>(); // alias/sku -> owning sku
  for (const p of products) owner.set(p.sku, p.sku);
  for (const p of products) {
    for (const alias of p.aliases) {
      if (alias === p.sku) continue; // self-alias is a harmless no-op
      const existingOwner = owner.get(alias);
      if (existingOwner && existingOwner !== p.sku) {
        issues.push({
          code: "ERR_ALIAS_CONFLICT",
          message: `alias "${alias}" on product "${p.sku}" collides with product/alias already claimed by "${existingOwner}"`,
        });
        continue;
      }
      owner.set(alias, p.sku);
    }
  }
  return issues;
}

export function loadCatalog(input: string | CatalogRowInput[], defaults: CatalogDefaults = {}): CatalogConfig {
  const issues: Issue[] = [];

  let rawRows: CatalogRowInput[];
  if (typeof input === "string") {
    const parsed = parseCsvToRows(input);
    issues.push(...parsed.issues);
    rawRows = parsed.rows;
  } else {
    rawRows = input.map((r, i) => ({ ...r, __row: r.__row ?? i + 2 }));
  }

  const resolved = resolveRows(rawRows, defaults);
  issues.push(...resolved.issues);

  // Price sanity range: opt-in per-currency magnitude guard (Adversarial 18).
  if (defaults.price_sanity_range) {
    for (const row of resolved.rows) {
      const range = defaults.price_sanity_range[row.currency];
      if (range && (row.priceAmount < range[0] || row.priceAmount > range[1])) {
        issues.push({
          code: "ERR_PRICE_SANITY_RANGE", row: row.row, column: "price_amount",
          message: `price_amount ${row.priceAmount} ${row.currency} is outside the configured sanity range [${range[0]}, ${range[1]}]`,
        });
      }
    }
  }

  const merged = mergeRows(resolved.rows);
  issues.push(...merged.issues);

  const products = merged.products.map(finalizeProduct);
  const productsBySku = new Map(products.map((p) => [p.sku, p]));
  issues.push(...checkAliasConflicts(products));

  const currencies = new Map<string, CurrencyMeta>();
  const currencyCodes = new Set(merged.prices.map((p) => p.currency));
  for (const code of currencyCodes) {
    try {
      currencies.set(code, buildCurrencyMeta(code, "en-US", defaults.currencies?.[code]));
    } catch (e) {
      if (e instanceof UnsupportedCurrencyError) {
        issues.push({ code: "ERR_UNSUPPORTED_CURRENCY", message: e.message, value: code });
      } else {
        throw e;
      }
    }
  }
  const compilableDrafts = merged.prices.filter((d) => currencies.has(d.currency));

  const compiled = compilePrices(compilableDrafts, currencies);
  issues.push(...compiled.issues);

  issues.push(...checkAmbiguityAndCoverage(compiled.prices));

  throwIfIssues(issues);

  const index = buildIndex(compiled.prices, productsBySku);
  const hash = computeCatalogHash(products, compiled.prices);

  return { products, prices: compiled.prices, index, hash, currencies };
}
