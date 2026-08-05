// Row-level parsing, defaulting and per-row validation. Step 1-4 of Catalog compilation.

import { parseCsv, parseMajorAmount, parseRate, parseBoolean, parseDate, parseList, parseMap, CellError, Cell } from "./csv.js";
import { parseConstraint, ConstraintParseError } from "./constraints.js";
import { CatalogDefaults, CatalogRowInput, ConstraintExpr } from "./types.js";
import { Issue, LoadErrorCode } from "./errors.js";

export const KNOWN_COLUMNS = [
  "product_sku", "product_aliases", "product_name", "product_description", "product_status",
  "product_family", "product_category", "product_type", "product_features", "product_tags",
  "created_at", "updated_at", "created_by",
  "price_id", "price_amount", "product_variant", "price_effective_start", "price_effective_end",
  "min_quantity", "max_quantity", "currency", "currency_symbol", "currency_separator",
  "country_code", "locale", "quantization", "charm", "charm_position", "frequency", "frequency_interval",
  "tax_id", "tax_label", "tax_rate", "tax_behavior", "tax_compound", "tax_constraints",
  "adjustment_id", "adjustment_kind", "adjustment_label", "adjustment_type", "adjustment_basis",
  "adjustment_value", "adjustment_start", "adjustment_end", "adjustment_stackable", "adjustment_constraints",
];

/** Fully-resolved, defaulted, per-row-validated record ready for merging. */
export interface ResolvedRow {
  row: number;
  sku: string;
  aliases: string[];
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

  priceIdRaw: string;
  priceAmount: number;
  variant: string | null;
  effectiveStart: number | null;
  effectiveEnd: number | null;
  minQuantity: number;
  maxQuantity: number | null;
  currency: string;
  currencySymbol?: string;
  countryCode: string | null;
  locale: string;
  quantization: "nearest" | "floor" | "ceil";
  charm: "none" | "to4" | "to9";
  charmPosition: number;
  billingPeriod: "one-time" | "recurring:month" | "recurring:year";

  hasTax: boolean;
  taxIdRaw: string;
  taxLabel: string;
  taxRate: number;
  taxBehavior: "inclusive" | "exclusive" | "unspecified";
  taxCompound: boolean;
  taxConstraints: ConstraintExpr | null;

  hasAdjustment: boolean;
  adjustmentIdRaw: string;
  adjustmentKind: "discount" | "markup" | "fee";
  adjustmentLabel: string;
  adjustmentType: "rate" | "amount";
  adjustmentBasis: "unit" | "line";
  adjustmentValue: number;
  adjustmentStart: number | null;
  adjustmentEnd: number | null;
  adjustmentStackable: boolean;
  adjustmentConstraints: ConstraintExpr | null;
}

function push(issues: Issue[], code: LoadErrorCode, row: number, column: string, message: string, value?: string, suggestion?: string) {
  issues.push({ code, row, column, message, value, suggestion });
}

/** Converts raw CSV cells for one row into a typed, partial CatalogRowInput, collecting cell-level issues. */
function cellsToRowInput(header: string[], cells: Cell[], row: number, issues: Issue[]): CatalogRowInput {
  const out: any = { __row: row };
  for (let i = 0; i < header.length; i++) {
    const col = header[i];
    const cell = cells[i];
    if (cell === null) continue; // blank => inherit default
    try {
      out[col] = parseCellValue(col, cell);
    } catch (e) {
      if (e instanceof CellError) {
        push(issues, e.code === "ERR_INVERTED_RANGE" ? "ERR_BAD_NUMBER" : (e.code as LoadErrorCode), row, col, e.message, cell, e.suggestion);
      } else {
        throw e;
      }
    }
  }
  return out as CatalogRowInput;
}

function parseCellValue(col: string, cell: string): unknown {
  switch (col) {
    case "product_aliases":
    case "product_tags":
      return parseList(cell);
    case "product_features":
      return parseMap(cell);
    case "price_amount":
      return parseMajorAmount(cell);
    case "min_quantity":
    case "max_quantity":
    case "charm_position": {
      const n = parseMajorAmount(cell);
      if (!Number.isInteger(n)) throw new CellError("ERR_BAD_NUMBER", `"${cell}" must be an integer`);
      return n;
    }
    case "price_effective_start":
    case "price_effective_end":
    case "adjustment_start":
    case "adjustment_end":
      return parseDate(cell);
    case "tax_rate":
      return parseRate(cell);
    case "adjustment_value":
      return parseMajorAmount(cell);
    case "tax_compound":
    case "adjustment_stackable":
      return parseBoolean(cell);
    default:
      return cell;
  }
}

/** Parses raw CSV text into typed rows, per the CSV contract. */
export function parseCsvToRows(text: string): { rows: CatalogRowInput[]; issues: Issue[] } {
  const issues: Issue[] = [];
  const parsed = parseCsv(text, KNOWN_COLUMNS);
  issues.push(...parsed.issues);
  const rows: CatalogRowInput[] = [];
  for (const raw of parsed.rows) {
    rows.push(cellsToRowInput(parsed.header, raw.cells, raw.row, issues));
  }
  return { rows, issues };
}

function pick<T>(row: CatalogRowInput, defaults: CatalogDefaults, key: keyof CatalogRowInput, fallback: T): any {
  const v = (row as any)[key];
  if (v !== undefined) return v;
  const d = (defaults as any)[key];
  if (d !== undefined) return d;
  return fallback;
}

function normalizeConstraint(
  raw: string | undefined,
  row: number,
  column: string,
  issues: Issue[],
): ConstraintExpr | null {
  if (raw === undefined || raw === "") return null;
  try {
    return parseConstraint(raw);
  } catch (e) {
    if (e instanceof ConstraintParseError) {
      push(issues, e.code, row, column, e.message, raw, e.suggestion);
      return null;
    }
    throw e;
  }
}

/** Applies defaults and per-row validation (steps 2-4 of Compilation), producing ResolvedRows. */
const IDENTITY_FIELDS: (keyof CatalogRowInput)[] = [
  "product_name", "product_description", "product_status", "product_family", "product_category",
  "product_type", "created_by",
];

export function resolveRows(rawRows: CatalogRowInput[], defaults: CatalogDefaults): { rows: ResolvedRow[]; issues: Issue[] } {
  const issues: Issue[] = [];
  const out: ResolvedRow[] = [];
  const identitySeen = new Map<string, Map<keyof CatalogRowInput, { row: number; value: unknown }>>();

  for (const raw of rawRows) {
    if (raw.product_sku) {
      let bySku = identitySeen.get(raw.product_sku);
      if (!bySku) {
        bySku = new Map();
        identitySeen.set(raw.product_sku, bySku);
      }
      for (const field of IDENTITY_FIELDS) {
        const value = raw[field];
        if (value === undefined || value === "") continue;
        const prior = bySku.get(field);
        if (prior === undefined) {
          bySku.set(field, { row: raw.__row ?? 0, value });
        } else if (prior.value !== value) {
          push(
            issues,
            "ERR_IDENTITY_CONFLICT",
            raw.__row ?? 0,
            field,
            `"${raw.product_sku}" disagrees on ${field}: row ${prior.row} has "${prior.value}", row ${raw.__row} has "${value}"`,
          );
        }
      }
    }
  }

  for (const raw of rawRows) {
    const row = raw.__row ?? 0;

    if (!raw.product_sku) {
      push(issues, "ERR_CSV_SHAPE", row, "product_sku", "product_sku is required");
      continue;
    }
    if (raw.price_amount === undefined || raw.price_amount === "") {
      push(issues, "ERR_CSV_SHAPE", row, "price_amount", "price_amount is required");
      continue;
    }

    const priceAmount = typeof raw.price_amount === "number" ? raw.price_amount : Number(raw.price_amount);
    if (!Number.isFinite(priceAmount) || priceAmount < 0) {
      push(issues, "ERR_NEGATIVE_AMOUNT", row, "price_amount", `price_amount must be >= 0, got "${raw.price_amount}"`);
      continue;
    }

    const minQuantity = Number(pick(raw, defaults, "min_quantity", 1));
    const maxQuantityRaw = pick(raw, defaults, "max_quantity", null);
    const maxQuantity = maxQuantityRaw === null || maxQuantityRaw === "" ? null : Number(maxQuantityRaw);
    if (maxQuantity !== null && maxQuantity < minQuantity) {
      push(issues, "ERR_INVERTED_RANGE", row, "max_quantity", `max_quantity (${maxQuantity}) is less than min_quantity (${minQuantity})`);
      continue;
    }

    const effectiveStartRaw = pick(raw, defaults, "price_effective_start", null);
    const effectiveStart = effectiveStartRaw === null || effectiveStartRaw === "" ? null : Number(effectiveStartRaw);
    const effectiveEndRaw = pick(raw, defaults, "price_effective_end", null);
    const effectiveEnd = effectiveEndRaw === null || effectiveEndRaw === "" ? null : Number(effectiveEndRaw);
    if (effectiveStart !== null && effectiveEnd !== null && effectiveEnd <= effectiveStart) {
      push(issues, "ERR_INVERTED_RANGE", row, "price_effective_end", "price_effective_end must be after price_effective_start");
      continue;
    }

    const frequency = pick(raw, defaults, "frequency", "one-time") as "one-time" | "recurring";
    const frequencyInterval = pick(raw, defaults, "frequency_interval", null) as "month" | "year" | null;
    let billingPeriod: "one-time" | "recurring:month" | "recurring:year";
    if (frequency === "one-time") {
      if (frequencyInterval) {
        push(issues, "ERR_INVALID_FREQUENCY", row, "frequency_interval", "one-time frequency must not have an interval");
        continue;
      }
      billingPeriod = "one-time";
    } else {
      if (!frequencyInterval) {
        push(issues, "ERR_INVALID_FREQUENCY", row, "frequency_interval", "recurring frequency requires frequency_interval");
        continue;
      }
      billingPeriod = `recurring:${frequencyInterval}` as "recurring:month" | "recurring:year";
    }

    const quantization = pick(raw, defaults, "quantization", "nearest");
    const charm = pick(raw, defaults, "charm", "none");
    const charmPosition = Number(pick(raw, defaults, "charm_position", 0));

    const currency = pick(raw, defaults, "currency", "USD");

    const hasTax = raw.tax_rate !== undefined || raw.tax_id !== undefined || raw.tax_label !== undefined;
    const hasAdjustment = raw.adjustment_kind !== undefined;

    const adjustmentConstraintsRaw = raw.adjustment_constraints;
    const taxConstraintsRaw = raw.tax_constraints;
    if (adjustmentConstraintsRaw !== undefined && !hasAdjustment) {
      push(issues, "ERR_CONSTRAINT_ON_PRICE", row, "adjustment_constraints", "a constraint cell requires an accompanying adjustment fact on the row");
      continue;
    }
    if (taxConstraintsRaw !== undefined && !hasTax) {
      push(issues, "ERR_CONSTRAINT_ON_PRICE", row, "tax_constraints", "a constraint cell requires an accompanying tax fact on the row");
      continue;
    }

    const taxConstraints = normalizeConstraint(taxConstraintsRaw, row, "tax_constraints", issues);
    const adjustmentConstraints = normalizeConstraint(adjustmentConstraintsRaw, row, "adjustment_constraints", issues);

    const adjustmentKind = raw.adjustment_kind ?? "discount";
    const adjustmentType = raw.adjustment_type ?? "rate";
    const adjustmentValueRaw = raw.adjustment_value ?? 0;
    const adjustmentValue = typeof adjustmentValueRaw === "number" ? adjustmentValueRaw : Number(adjustmentValueRaw);
    if (hasAdjustment && adjustmentType === "rate" && (adjustmentValue < 0 || adjustmentValue > 1)) {
      push(issues, "ERR_RATE_OUT_OF_RANGE", row, "adjustment_value", `adjustment_value "${adjustmentValueRaw}" must be a fraction in [0, 1]`);
      continue;
    }
    if (hasAdjustment && (adjustmentKind === "markup" || adjustmentKind === "fee") && adjustmentValue < 0) {
      push(issues, "ERR_NEGATIVE_AMOUNT", row, "adjustment_value", `a negative ${adjustmentKind} value means a discount — use adjustment_kind: discount instead`);
      continue;
    }
    if (hasAdjustment && adjustmentKind === "markup" && raw.adjustment_basis === "line") {
      push(
        issues, "ERR_MARKUP_BASIS", row, "adjustment_basis",
        `markup has no line-basis meaning — it is always folded into the unit price; use adjustment_kind: fee for a genuine per-line charge`,
      );
      continue;
    }

    out.push({
      row,
      sku: raw.product_sku,
      aliases: normalizeListField(raw.product_aliases),
      name: pick(raw, defaults, "product_name", ""),
      description: pick(raw, defaults, "product_description", ""),
      status: pick(raw, defaults, "product_status", "active"),
      family: pick(raw, defaults, "product_family", ""),
      category: pick(raw, defaults, "product_category", ""),
      type: pick(raw, defaults, "product_type", ""),
      features: normalizeMapField(raw.product_features),
      tags: normalizeListField(raw.product_tags),
      createdAt: pick(raw, defaults, "created_at", ""),
      updatedAt: pick(raw, defaults, "updated_at", ""),
      createdBy: pick(raw, defaults, "created_by", ""),

      priceIdRaw: raw.price_id ?? "",
      priceAmount,
      variant: raw.product_variant ? raw.product_variant : null,
      effectiveStart,
      effectiveEnd,
      minQuantity,
      maxQuantity,
      currency,
      currencySymbol: pick(raw, defaults, "currency_symbol", undefined),
      countryCode: raw.country_code ? raw.country_code : null,
      locale: pick(raw, defaults, "locale", "en-US"),
      quantization,
      charm,
      charmPosition,
      billingPeriod,

      hasTax,
      taxIdRaw: raw.tax_id ?? "",
      taxLabel: raw.tax_label ?? "",
      taxRate: typeof raw.tax_rate === "number" ? raw.tax_rate : Number(raw.tax_rate ?? 0),
      taxBehavior: raw.tax_behavior ?? "unspecified",
      taxCompound: !!raw.tax_compound,
      taxConstraints,

      hasAdjustment,
      adjustmentIdRaw: raw.adjustment_id ?? "",
      adjustmentKind,
      adjustmentLabel: raw.adjustment_label ?? "",
      adjustmentType,
      adjustmentBasis: raw.adjustment_basis ?? (adjustmentKind === "markup" ? "unit" : "line"),
      adjustmentValue,
      adjustmentStart: raw.adjustment_start ? Number(raw.adjustment_start) : null,
      adjustmentEnd: raw.adjustment_end ? Number(raw.adjustment_end) : null,
      adjustmentStackable: !!raw.adjustment_stackable,
      adjustmentConstraints,
    });
  }

  return { rows: out, issues };
}

function normalizeListField(v: string[] | string | undefined): string[] {
  if (v === undefined) return [];
  if (Array.isArray(v)) return v;
  return parseList(v);
}

function normalizeMapField(v: Record<string, string> | string | undefined): Record<string, string> {
  if (v === undefined) return {};
  if (typeof v === "string") return parseMap(v);
  return v;
}
