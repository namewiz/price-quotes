// Typed errors. Callers branch on `.code`, never on message text.

export type LoadErrorCode =
  | "ERR_CSV_SHAPE"
  | "ERR_UNKNOWN_COLUMN"
  | "ERR_DUPLICATE_COLUMN"
  | "ERR_BAD_NUMBER"
  | "ERR_RATE_OUT_OF_RANGE"
  | "ERR_BAD_DATE"
  | "ERR_BAD_BOOLEAN"
  | "ERR_UNSUPPORTED_CURRENCY"
  | "ERR_NEGATIVE_AMOUNT"
  | "ERR_AMOUNT_TOO_LARGE"
  | "ERR_INVALID_FREQUENCY"
  | "ERR_IDENTITY_CONFLICT"
  | "ERR_ALIAS_CONFLICT"
  | "ERR_PRICE_ID_CONFLICT"
  | "ERR_DUPLICATE_ADJUSTMENT"
  | "ERR_AMBIGUOUS_PRICE"
  | "ERR_QUANTITY_GAP"
  | "ERR_WINDOW_GAP"
  | "ERR_INVERTED_RANGE"
  | "ERR_CHARM_UNDERFLOW"
  | "ERR_CHARM_INCREMENT_CONFLICT"
  | "ERR_DISCOUNT_EXCEEDS_PRICE"
  | "ERR_MIXED_STACK_TYPES"
  | "ERR_CONSTRAINT_SYNTAX"
  | "ERR_CONSTRAINT_UNKNOWN_FIELD"
  | "ERR_CONSTRAINT_CART_SCOPE"
  | "ERR_CONSTRAINT_ON_PRICE"
  | "ERR_PRICE_SANITY_RANGE"
  | "ERR_MARKUP_BASIS";

export type QuoteTimeErrorCode =
  | "ERR_UNKNOWN_SKU"
  | "ERR_NO_PRICE"
  | "ERR_INVALID_REQUEST"
  | "ERR_CURRENCY_NOT_IN_CATALOG"
  | "ERR_AMOUNT_OVERFLOW";

export type ErrorCode = LoadErrorCode | QuoteTimeErrorCode;

export class QuoteError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "QuoteError";
  }
}

export interface Issue {
  code: LoadErrorCode;
  row?: number;
  column?: string;
  value?: string;
  message: string;
  suggestion?: string;
}

export class CatalogError extends Error {
  readonly code = "ERR_CATALOG" as const;
  readonly issues: Issue[];
  constructor(issues: Issue[]) {
    super(CatalogError.formatMessage(issues));
    this.issues = issues;
    this.name = "CatalogError";
  }

  private static formatMessage(issues: Issue[]): string {
    const lines = issues.map((i) => {
      const loc = i.row != null ? `row ${i.row}${i.column ? `, column ${i.column}` : ""}: ` : "";
      const suggestion = i.suggestion ? ` (${i.suggestion})` : "";
      return `[${i.code}] ${loc}${i.message}${suggestion}`;
    });
    return `${issues.length} catalog issue(s):\n${lines.join("\n")}`;
  }
}

/** Thrown once issues have been collected; callers assemble the list then call this. */
export function throwIfIssues(issues: Issue[]): void {
  if (issues.length > 0) throw new CatalogError(issues);
}

export function levenshtein(a: string, b: string): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[a.length][b.length];
}

export function nearestMatch(needle: string, haystack: string[]): string | undefined {
  let best: string | undefined;
  let bestDist = Infinity;
  for (const candidate of haystack) {
    const d = levenshtein(needle, candidate);
    if (d < bestDist) {
      bestDist = d;
      best = candidate;
    }
  }
  // Only suggest if plausibly a typo, not a wildly different word.
  return bestDist <= Math.max(3, Math.ceil(needle.length / 2)) ? best : undefined;
}
