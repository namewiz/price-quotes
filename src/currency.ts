// Currency metadata: exponent derives from Intl (also gives free code validation).
// Rounding increments and symbols are authored data — Intl has no opinion on either.

import { CurrencyMeta, CurrencyMetaInput } from "./types.js";

const exponentCache = new Map<string, number>();

export class UnsupportedCurrencyError extends Error {
  code = "ERR_UNSUPPORTED_CURRENCY" as const;
  constructor(public currency: string) {
    super(`"${currency}" is not a valid ISO 4217 currency code`);
  }
}

function deriveExponent(code: string, locale: string): number {
  const cacheKey = `${locale}::${code}`;
  const cached = exponentCache.get(cacheKey);
  if (cached !== undefined) return cached;
  let exponent: number;
  try {
    const fmt = new Intl.NumberFormat(locale, { style: "currency", currency: code });
    exponent = fmt.resolvedOptions().maximumFractionDigits ?? 2;
  } catch (e) {
    if (e instanceof RangeError) throw new UnsupportedCurrencyError(code);
    throw e;
  }
  exponentCache.set(cacheKey, exponent);
  return exponent;
}

export function buildCurrencyMeta(code: string, locale = "en-US", override?: CurrencyMetaInput): CurrencyMeta {
  const exponent = deriveExponent(code, override?.locale ?? locale);
  return {
    code,
    exponent,
    increment: override?.increment ?? 1,
    symbol: override?.symbol,
  };
}

const formatterCache = new Map<string, Intl.NumberFormat>();

/** Cached per (currency, locale) — construction cost would dominate a quote otherwise. */
export function getNumberFormatter(code: string, locale = "en-US"): Intl.NumberFormat {
  const key = `${locale}::${code}`;
  let fmt = formatterCache.get(key);
  if (!fmt) {
    fmt = new Intl.NumberFormat(locale, { style: "currency", currency: code });
    formatterCache.set(key, fmt);
  }
  return fmt;
}
