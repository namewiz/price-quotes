// Step 9 of Compilation: prove unambiguity, then build the O(1) index.

import { Band, Price, PriceBucket, PriceIndex, Product } from "./types.js";
import { Issue } from "./errors.js";

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
