// Price resolution: alias normalize, then probe the specificity lattice, then band-select.

import { BillingPeriod, Band, CatalogConfig, Price } from "./types.js";
import { QuoteError } from "./errors.js";

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
