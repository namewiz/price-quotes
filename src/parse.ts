// ---- CSV contract ----
// The CSV contract.

import { Issue, LoadErrorCode, nearestMatch } from "./errors.js";
import { CatalogDefaults, CatalogRowInput, ConstraintClause, ConstraintExpr, ConstraintOp } from "./types.js";

const NBSP = " ";
const TYPOGRAPHIC_CHARS = ["“", "”", "‘", "’", "–"]; // “ ” ‘ ’ –

/** A parsed cell: `null` = blank (unquoted empty => inherit default); `""` = explicitly cleared. */
export type Cell = string | null;

export interface RawRow {
  row: number; // 1-based, header is row 1
  cells: Cell[];
}

export interface ParsedCsv {
  header: string[]; // normalized
  rows: RawRow[];
  issues: Issue[];
}

function stripBomAndNormalizeNewlines(text: string): string {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** RFC 4180 tokenizer, quote-aware. Tracks whether each field was quoted (for blank-vs-"" semantics). */
function tokenize(text: string): { fields: string[]; quoted: boolean[] }[] {
  const records: { fields: string[]; quoted: boolean[] }[] = [];
  let fields: string[] = [];
  let quoted: boolean[] = [];
  let field = "";
  let fieldWasQuoted = false;
  let i = 0;
  let inQuotes = false;
  const n = text.length;

  function endField() {
    fields.push(field);
    quoted.push(fieldWasQuoted);
    field = "";
    fieldWasQuoted = false;
  }
  function endRecord() {
    endField();
    records.push({ fields, quoted });
    fields = [];
    quoted = [];
  }

  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"' && field === "") {
      inQuotes = true;
      fieldWasQuoted = true;
      i++;
      continue;
    }
    if (c === ",") {
      endField();
      i++;
      continue;
    }
    if (c === "\n") {
      endRecord();
      i++;
      continue;
    }
    field += c;
    i++;
  }
  // Trailing record, if the file doesn't end with a newline (or is non-empty after last \n)
  if (field !== "" || fields.length > 0 || inQuotes) {
    endRecord();
  }
  return records;
}

function normalizeHeader(name: string): string {
  return trimCell(name)!.toLowerCase().replace(/[-\s]+/g, "_");
}

/** Trims ASCII whitespace and NBSP from both ends; returns null for a fully-blank unquoted cell. */
function trimCell(raw: string): string | null {
  const trimmed = raw.replace(new RegExp(`^[\\s${NBSP}]+|[\\s${NBSP}]+$`, "g"), "");
  return trimmed;
}

export function parseCsv(text: string, knownColumns: string[]): ParsedCsv {
  const issues: Issue[] = [];
  const normalized = stripBomAndNormalizeNewlines(text);
  const records = tokenize(normalized).filter((r, idx, arr) => {
    // Drop a single trailing fully-empty record produced by a final newline.
    if (idx === arr.length - 1 && r.fields.length === 1 && r.fields[0] === "") return false;
    return true;
  });

  if (records.length === 0) {
    return { header: [], rows: [], issues: [{ code: "ERR_CSV_SHAPE", message: "empty CSV: no header row" }] };
  }

  const headerRaw = records[0].fields;
  const header: string[] = [];
  const seen = new Map<string, number>();
  for (const h of headerRaw) {
    const norm = normalizeHeader(h);
    if (seen.has(norm)) {
      issues.push({
        code: "ERR_DUPLICATE_COLUMN",
        row: 1,
        column: h,
        message: `duplicate column "${h}" (normalized "${norm}")`,
      });
    }
    seen.set(norm, (seen.get(norm) ?? 0) + 1);
    if (!knownColumns.includes(norm)) {
      const suggestion = nearestKnownColumn(norm, knownColumns);
      issues.push({
        code: "ERR_UNKNOWN_COLUMN",
        row: 1,
        column: h,
        message: `unrecognized column "${h}"`,
        suggestion: suggestion ? `did you mean "${suggestion}"?` : undefined,
      });
    }
    header.push(norm);
  }

  const rows: RawRow[] = [];
  for (let r = 1; r < records.length; r++) {
    const rec = records[r];
    const rowNum = r + 1; // 1-based, header = row 1
    if (rec.fields.length !== header.length) {
      // A fully-blank trailing line tokenizes to a single empty field; skip silently.
      if (rec.fields.length === 1 && rec.fields[0] === "") continue;
      issues.push({
        code: "ERR_CSV_SHAPE",
        row: rowNum,
        message: `expected ${header.length} fields, got ${rec.fields.length}`,
      });
      continue;
    }
    const cells: Cell[] = rec.fields.map((f, idx) => {
      const wasQuoted = rec.quoted[idx];
      const trimmed = trimCell(f);
      if (trimmed === "") return wasQuoted ? "" : null;
      return trimmed;
    });
    if (cells.every((c) => c === null)) continue; // fully-blank row: Excel leftover
    rows.push({ row: rowNum, cells });
  }

  return { header, rows, issues };
}

function nearestKnownColumn(name: string, known: string[]): string | undefined {
  let best: string | undefined;
  let bestDist = Infinity;
  for (const k of known) {
    const d = levenshtein(name, k);
    if (d < bestDist) {
      bestDist = d;
      best = k;
    }
  }
  return bestDist <= Math.max(3, Math.ceil(name.length / 2)) ? best : undefined;
}

function levenshtein(a: string, b: string): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

// ---- Cell-level value parsing ----

export class CellError extends Error {
  constructor(
    public code: "ERR_BAD_NUMBER" | "ERR_RATE_OUT_OF_RANGE" | "ERR_BAD_DATE" | "ERR_BAD_BOOLEAN" | "ERR_INVERTED_RANGE",
    message: string,
    public suggestion?: string,
  ) {
    super(message);
  }
}

const NUMBER_RE = /^-?\d+(\.\d+)?$/;

/**
 * Major-unit amount: "." decimal, no group separators, no currency symbols. Negative numbers
 * parse here (a negative `price_amount` or `fee`/`markup` is rejected semantically, with a
 * message naming the specific rule, rather than opaquely at the cell-parsing layer).
 */
export function parseMajorAmount(text: string): number {
  if (!NUMBER_RE.test(text)) {
    throw new CellError("ERR_BAD_NUMBER", `"${text}" is not a plain decimal number`);
  }
  return Number(text);
}

/** Rate cell: fraction in [0, 1]. */
export function parseRate(text: string): number {
  if (!NUMBER_RE.test(text)) {
    throw new CellError("ERR_BAD_NUMBER", `"${text}" is not a plain decimal number`);
  }
  const n = Number(text);
  if (n < 0 || n > 1) {
    const suggestion = n > 1 && n <= 100 ? `did you mean ${n / 100}?` : undefined;
    throw new CellError("ERR_RATE_OUT_OF_RANGE", `rate "${text}" must be a fraction in [0, 1]`, suggestion);
  }
  return n;
}

export function parseBoolean(text: string): boolean {
  const v = text.toLowerCase();
  if (["true", "yes", "1"].includes(v)) return true;
  if (["false", "no", "0"].includes(v)) return false;
  throw new CellError("ERR_BAD_BOOLEAN", `"${text}" is not a recognized boolean (true/false/yes/no/1/0)`);
}

const EXCEL_SERIAL_RE = /^\d+$/;

/** ISO 8601 date/datetime -> epoch ms. Date-only is UTC midnight. */
export function parseDate(text: string): number {
  if (EXCEL_SERIAL_RE.test(text)) {
    throw new CellError("ERR_BAD_DATE", `"${text}" looks like an Excel date serial number, not ISO 8601`);
  }
  const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(text);
  const iso = isDateOnly ? `${text}T00:00:00.000Z` : text;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    throw new CellError("ERR_BAD_DATE", `"${text}" is not a valid ISO 8601 date`);
  }
  return ms;
}

function assertNoTypographicChars(text: string): void {
  for (const ch of TYPOGRAPHIC_CHARS) {
    if (text.includes(ch)) {
      throw new CellError(
        "ERR_BAD_NUMBER" as any,
        `"${text}" contains a typographic character ("${ch}") — likely Excel autocorrect`,
      );
    }
  }
}

/** Splits a `;`-delimited list cell, honoring `\;` escapes. */
export function parseList(text: string): string[] {
  assertNoTypographicChars(text);
  return splitEscaped(text, ";").filter((s) => s.length > 0);
}

/** Splits a `k1=v1;k2=v2` map cell, honoring `\;`/`\=` escapes. */
export function parseMap(text: string): Record<string, string> {
  assertNoTypographicChars(text);
  const out: Record<string, string> = {};
  for (const part of splitEscaped(text, ";")) {
    if (!part) continue;
    const eq = findUnescaped(part, "=");
    if (eq === -1) {
      throw new CellError("ERR_BAD_NUMBER" as any, `map entry "${part}" is missing "="`);
    }
    const k = unescapeLiteral(part.slice(0, eq));
    const v = unescapeLiteral(part.slice(eq + 1));
    out[k] = v;
  }
  return out;
}

function findUnescaped(text: string, ch: string): number {
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\") {
      i++;
      continue;
    }
    if (text[i] === ch) return i;
  }
  return -1;
}

function splitEscaped(text: string, delim: string): string[] {
  const parts: string[] = [];
  let current = "";
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\" && i + 1 < text.length) {
      current += text[i + 1];
      i++;
      continue;
    }
    if (text[i] === delim) {
      parts.push(current);
      current = "";
      continue;
    }
    current += text[i];
  }
  parts.push(current);
  return parts;
}

function unescapeLiteral(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\" && i + 1 < text.length) {
      out += text[i + 1];
      i++;
      continue;
    }
    out += text[i];
  }
  return out;
}

// ---- Constraint grammar ----
// Constraint grammar: a closed comparison grammar, parsed at load, evaluated by fixed
// dispatch at quote time. Never reaches `eval` or a callback.

export const CART_SCOPED_FIELDS = new Set(["cart_subtotal", "cart_quantity", "cart_line_count"]);

export const NUMERIC_FIELDS = new Set(["quantity", "line_subtotal"]);
export const KNOWN_FIELDS = new Set(["sku", "variant", "quantity", "currency", "frequency", "country_code", "line_subtotal"]);

export class ConstraintParseError extends Error {
  constructor(
    public code: "ERR_CONSTRAINT_SYNTAX" | "ERR_CONSTRAINT_UNKNOWN_FIELD" | "ERR_CONSTRAINT_CART_SCOPE",
    message: string,
    public suggestion?: string,
  ) {
    super(message);
  }
}

function isNumericField(field: string): boolean {
  if (NUMERIC_FIELDS.has(field)) return true;
  return !KNOWN_FIELDS.has(field) && false; // context fields are always treated as strings
}

function checkFieldKnown(field: string): void {
  if (CART_SCOPED_FIELDS.has(field)) {
    throw new ConstraintParseError(
      "ERR_CONSTRAINT_CART_SCOPE",
      `"${field}" is a cart-scoped field and cannot be used in a line-scoped constraint`,
    );
  }
  if (KNOWN_FIELDS.has(field)) return;
  // Not a fixed field: could be a genuine caller-context key, or a typo of a fixed field.
  const suggestion = nearestMatch(field, [...KNOWN_FIELDS]);
  if (suggestion && suggestion !== field) {
    throw new ConstraintParseError(
      "ERR_CONSTRAINT_UNKNOWN_FIELD",
      `unknown constraint field "${field}"`,
      `did you mean "${suggestion}"?`,
    );
  }
  // Otherwise treat as a caller-supplied context field.
}

function parseOne(clauseText: string): ConstraintClause {
  const eq = findUnescapedEquals(clauseText);
  if (eq === -1) {
    throw new ConstraintParseError("ERR_CONSTRAINT_SYNTAX", `constraint clause "${clauseText}" is missing "="`);
  }
  const field = clauseText.slice(0, eq).trim();
  const rawValue = clauseText.slice(eq + 1);
  checkFieldKnown(field);
  assertNoTypographicChars(rawValue);

  let op: ConstraintOp;
  let valuePart: string;
  if (startsWithUnescaped(rawValue, "!=")) {
    op = "!=";
    valuePart = rawValue.slice(2);
  } else if (startsWithUnescaped(rawValue, ">=")) {
    op = ">=";
    valuePart = rawValue.slice(2);
  } else if (startsWithUnescaped(rawValue, "<=")) {
    op = "<=";
    valuePart = rawValue.slice(2);
  } else if (startsWithUnescaped(rawValue, ">")) {
    op = ">";
    valuePart = rawValue.slice(1);
  } else if (startsWithUnescaped(rawValue, "<")) {
    op = "<";
    valuePart = rawValue.slice(1);
  } else if (hasUnescapedRange(rawValue)) {
    op = "..";
    const idx = findUnescapedRange(rawValue);
    valuePart = "";
    const lo = unescapeLiteral(rawValue.slice(0, idx));
    const hi = unescapeLiteral(rawValue.slice(idx + 2));
    validateNumericIfNeeded(field, [lo, hi]);
    return { field, op, values: [lo, hi] };
  } else {
    op = "=";
    valuePart = rawValue;
  }

  const isRelational = op === ">" || op === ">=" || op === "<" || op === "<=";
  if (isRelational) {
    const numeric = NUMERIC_FIELDS.has(field);
    if (!numeric) {
      throw new ConstraintParseError(
        "ERR_CONSTRAINT_SYNTAX",
        `relational operator "${op}" on non-numeric field "${field}" is not allowed`,
      );
    }
    const value = unescapeLiteral(valuePart);
    validateNumericIfNeeded(field, [value]);
    return { field, op, values: [value] };
  }

  // "=" / "!=" admit an OR-set of `;`-separated values.
  const values = splitEscaped(valuePart, ";").map(unescapeLiteral).filter((v) => v.length > 0);
  if (values.length === 0) {
    throw new ConstraintParseError("ERR_CONSTRAINT_SYNTAX", `constraint clause "${clauseText}" has no value`);
  }
  return { field, op, values };
}

function validateNumericIfNeeded(field: string, values: string[]): void {
  if (!NUMERIC_FIELDS.has(field)) return;
  for (const v of values) {
    if (Number.isNaN(Number(v)) || v.trim() === "") {
      throw new ConstraintParseError("ERR_CONSTRAINT_SYNTAX", `"${v}" is not a number for numeric field "${field}"`);
    }
  }
}

function findUnescapedEquals(text: string): number {
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\") {
      i++;
      continue;
    }
    if (text[i] === "=") return i;
  }
  return -1;
}

function startsWithUnescaped(text: string, token: string): boolean {
  return text.startsWith(token);
}

function hasUnescapedRange(text: string): boolean {
  return findUnescapedRange(text) !== -1;
}

function findUnescapedRange(text: string): number {
  for (let i = 0; i < text.length - 1; i++) {
    if (text[i] === "\\") {
      i++;
      continue;
    }
    if (text[i] === "." && text[i + 1] === ".") return i;
  }
  return -1;
}

/** Parses a full constraint cell, e.g. `country_code=US;CA & quantity=>=10`. */
export function parseConstraint(text: string): ConstraintExpr {
  const clauseTexts = splitEscaped(text, "&").map((s) => s.trim()).filter((s) => s.length > 0);
  if (clauseTexts.length === 0) {
    throw new ConstraintParseError("ERR_CONSTRAINT_SYNTAX", `empty constraint cell`);
  }
  const clauses = clauseTexts.map(parseOne);
  return { source: text, clauses };
}

export type EvalContext = Record<string, string | number | undefined>;

/** Evaluates a parsed constraint. A field absent from context fails the clause, not throws. */
export function evaluateConstraint(expr: ConstraintExpr, ctx: EvalContext): boolean {
  return expr.clauses.every((clause) => evaluateClause(clause, ctx));
}

function evaluateClause(clause: ConstraintClause, ctx: EvalContext): boolean {
  const raw = ctx[clause.field];
  if (raw === undefined) return false;
  const numeric = NUMERIC_FIELDS.has(clause.field);

  if (clause.op === "=") return clause.values.some((v) => matches(raw, v, numeric));
  if (clause.op === "!=") return !clause.values.some((v) => matches(raw, v, numeric));
  if (clause.op === "..") {
    const n = Number(raw);
    return n >= Number(clause.values[0]) && n <= Number(clause.values[1]);
  }
  const n = Number(raw);
  const bound = Number(clause.values[0]);
  switch (clause.op) {
    case ">":
      return n > bound;
    case ">=":
      return n >= bound;
    case "<":
      return n < bound;
    case "<=":
      return n <= bound;
  }
  return false;
}

function matches(raw: string | number, value: string, numeric: boolean): boolean {
  if (numeric) return Number(raw) === Number(value);
  return String(raw) === value;
}

// ---- Row-level parsing, defaulting and per-row validation ----
// Step 1-4 of Compilation.

export const KNOWN_COLUMNS = [
  "product_sku", "product_aliases", "product_name", "product_description", "product_status",
  "product_family", "product_category", "product_type", "product_features", "product_tags",
  "created_at", "updated_at", "created_by",
  "price_id", "price_amount", "product_variant", "price_effective_start", "price_effective_end",
  "min_quantity", "max_quantity", "currency", "currency_symbol", "currency_separator",
  "currency_rounding", "currency_rounding_mode",
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
  /** Currency-level rounding grid, in major units. Undefined when the row/defaults set neither. */
  currencyRounding?: number;
  currencyRoundingMode?: "nearest" | "floor" | "ceil";
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
    case "currency_rounding":
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
      currencyRounding: (() => {
        const v = pick(raw, defaults, "currency_rounding", undefined);
        return v === undefined ? undefined : (typeof v === "number" ? v : Number(v));
      })(),
      currencyRoundingMode: pick(raw, defaults, "currency_rounding_mode", undefined),
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

export { splitEscaped, unescapeLiteral, assertNoTypographicChars };
