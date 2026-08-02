// Orchestrates catalog compilation end to end. See design-docs/design-v2.md, "Catalog compilation".

import { CatalogConfig, CatalogDefaults, CatalogRowInput, CurrencyMeta, Product } from "./types.js";
import { Issue, throwIfIssues } from "./errors.js";
import { parseCsvToRows, resolveRows } from "./rows.js";
import { mergeRows, ProductDraft } from "./merge.js";
import { compilePrices } from "./validate.js";
import { checkAmbiguityAndCoverage, buildIndex } from "./ambiguity.js";
import { buildCurrencyMeta, UnsupportedCurrencyError } from "./currency.js";
import { computeCatalogHash } from "./hash.js";

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
