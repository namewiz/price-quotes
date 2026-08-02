// Constraint grammar: a closed comparison grammar, parsed at load, evaluated by fixed
// dispatch at quote time. Never reaches `eval` or a callback. See design-docs/design-v2.md.

import { ConstraintClause, ConstraintExpr, ConstraintOp } from "./types.js";
import { nearestMatch } from "./errors.js";
import { splitEscaped, unescapeLiteral, assertNoTypographicChars } from "./csv.js";

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
