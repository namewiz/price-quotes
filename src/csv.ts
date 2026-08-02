// The CSV contract. See design-docs/design-v2.md, "The CSV contract".

import { Issue } from "./errors.js";

const NBSP = " ";
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

export { splitEscaped, unescapeLiteral, assertNoTypographicChars };
