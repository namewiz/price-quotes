// ---- SHA-256 ----
// A minimal, dependency-free, synchronous SHA-256 (FIPS 180-4). Used for the catalog hash so
// this module bundles identically for Node and the browser (no node:crypto, no async WebCrypto).

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

export function sha256Hex(message: string): string {
  const bytes = new TextEncoder().encode(message);
  const bitLen = bytes.length * 8;
  const withOne = bytes.length + 1;
  const padded = Math.ceil((withOne + 8) / 64) * 64;
  const buf = new Uint8Array(padded);
  buf.set(bytes);
  buf[bytes.length] = 0x80;
  const view = new DataView(buf.buffer);
  // 64-bit big-endian length; message lengths here never approach 2^32 bits.
  view.setUint32(padded - 4, bitLen >>> 0, false);

  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;

  const w = new Uint32Array(64);
  for (let offset = 0; offset < padded; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + temp1) >>> 0;
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7].map((n) => n.toString(16).padStart(8, "0")).join("");
}

// ---- Money ----
// Money: quantization (representation) and charm (pricing policy) are two mechanisms
// that are not a pair.

import { Charm, CharmFill, Quantization, Adjustment, ConstraintExpr, Price, Product, Tax, CurrencyMeta, CurrencyMetaInput } from "./types.js";

export const MAX_BASE_UNIT_MINOR = 2 ** 40;

/** Corrects float representation error (e.g. 79.8 * 0.075 = 5.984999999999999) before rounding. */
export function correctFloatError(x: number): number {
  const rounded = Math.round(x);
  return Math.abs(x - rounded) < 1e-6 ? rounded : x;
}

function roundNearestAwayFromZero(x: number): number {
  return x >= 0 ? Math.floor(x + 0.5) : Math.ceil(x - 0.5);
}

/** Rounds `x` onto a grid of the given `increment`, under `mode`. `x` and `increment` are minor units. */
export function quantize(x: number, increment: number, mode: Quantization): number {
  const corrected = correctFloatError(x);
  if (increment === 1) {
    if (mode === "floor") return Math.floor(corrected);
    if (mode === "ceil") return Math.ceil(corrected);
    return roundNearestAwayFromZero(corrected);
  }
  const ratio = correctFloatError(corrected / increment);
  let n: number;
  if (mode === "floor") n = Math.floor(ratio);
  else if (mode === "ceil") n = Math.ceil(ratio);
  else n = roundNearestAwayFromZero(ratio);
  return n * increment;
}

/**
 * Nearest charm candidate: a minor-unit integer whose digit at `position` is the charm digit
 * (4 or 9) and whose lower digits are all 9 (`fill: "nines"`, the default) or all 0
 * (`fill: "zeros"`). Ties resolve downward. `charm(0) = 0` by definition.
 */
export function charmPrice(unitMinor: number, charm: Charm, position: number, fill: CharmFill = "nines"): number {
  if (charm === "none" || unitMinor === 0) return unitMinor;
  const digit = charm === "to9" ? 9 : 4;
  const lowStep = 10 ** position;
  const step = lowStep * 10;
  const filler = fill === "zeros" ? 0 : lowStep - 1;
  const base = digit * lowStep + filler;
  // Math.ceil(x - 0.5) rounds to nearest, ties toward -Infinity (i.e. "downward").
  const k = Math.ceil((unitMinor - base) / step - 0.5);
  return k * step + base;
}

export function isCharmCandidate(unitMinor: number, charm: Charm, position: number, fill: CharmFill = "nines"): boolean {
  if (charm === "none") return true;
  if (unitMinor === 0) return true;
  return charmPrice(unitMinor, charm, position, fill) === unitMinor;
}

// ---- Currency ----
// Currency metadata: exponent derives from Intl (also gives free code validation).
// Rounding increments and symbols are authored data — Intl has no opinion on either.

const exponentCache = new Map<string, number>();

export class UnsupportedCurrencyError extends Error {
  code = "ERR_UNSUPPORTED_CURRENCY" as const;
  constructor(public currency: string) {
    super(`"${currency}" is not a valid ISO 4217 currency code`);
  }
}

export function getCurrencyExponent(code: string, locale = "en-US"): number {
  return deriveExponent(code, locale);
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
    roundingMode: override?.roundingMode ?? "nearest",
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

// ---- Catalog hash ----
// The catalog hash: a SHA-256 over a canonical serialization of the compiled entities.
// Order-independent, and excludes presentation/provenance fields. See "The catalog hash".

const SEP = "";
const FIELD_SEP = "";

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
    p.billingPeriod, p.baseUnitMinor, p.quantization, p.charm, p.charmPosition, p.charmFill,
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
