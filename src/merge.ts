// Step 5-6 of Compilation: content-derived IDs and merging rows that describe the same price.

import { ResolvedRow } from "./rows.js";
import { ConstraintExpr } from "./types.js";
import { Issue } from "./errors.js";

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
