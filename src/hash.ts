// The catalog hash: a SHA-256 over a canonical serialization of the compiled entities.
// Order-independent, and excludes presentation/provenance fields. See "The catalog hash".

import { Adjustment, ConstraintExpr, Price, Product, Tax } from "./types.js";
import { sha256Hex } from "./sha256.js";

const SEP = "";
const FIELD_SEP = "";

function canonicalConstraint(c: ConstraintExpr | null): string {
  if (!c) return "";
  const clauses = [...c.clauses]
    .map((cl) => `${cl.field}${cl.op}${[...cl.values].sort().join(",")}`)
    .sort();
  return clauses.join(";");
}

function serializeTax(t: Tax): string {
  return [t.id, t.rate, t.behavior, t.compound, canonicalConstraint(t.constraints)].join(FIELD_SEP);
}

function serializeAdjustment(a: Adjustment): string {
  return [a.id, a.kind, a.type, a.basis, a.value, a.stackable, canonicalConstraint(a.constraints)].join(FIELD_SEP);
}

function serializePrice(p: Price): string {
  const taxIds = p.taxes.map((t) => t.id).sort();
  const adjIds = p.adjustments.map((a) => a.id).sort();
  return [
    p.id, p.sku, p.currency, p.variant ?? "*", p.country ?? "*",
    p.minQuantity, p.maxQuantity ?? "", p.effectiveStart, p.effectiveEnd ?? "",
    p.billingPeriod, p.baseUnitMinor, p.quantization, p.charm, p.charmPosition,
    taxIds.join(","), adjIds.join(","),
  ].join(FIELD_SEP);
}

function serializeProduct(p: Product): string {
  const aliases = [...p.aliases].sort();
  const tags = [...p.tags].sort();
  const features = Object.entries(p.features).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`);
  return [p.sku, p.status, p.family, p.category, p.type, aliases.join(","), tags.join(","), features.join(",")].join(FIELD_SEP);
}

export function computeCatalogHash(products: Product[], prices: Price[]): string {
  const productStrs = products.map(serializeProduct).sort();
  const priceStrs = prices.map(serializePrice).sort();
  const canonical = [...productStrs, ...priceStrs].join(SEP);
  return sha256Hex(canonical);
}
