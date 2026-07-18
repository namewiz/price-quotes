/**
 * Money is represented as an integer count of minor units (cents, kobo, ...).
 *
 * Intermediate arithmetic happens in *fractional* minor units and is quantized only at
 * defined boundaries (after markup, after discount, after each tax line). This replaces
 * the old float-major-unit + `toFixed(2)` approach, which could not express JPY (no minor
 * unit) or KWD (three).
 */
export interface Money {
  currency: string;
  /** Integer count of minor units. */
  minor: number;
}

export interface CurrencyMeta {
  code: string;
  symbol: string;
  /** Digits after the decimal point: 2 for USD, 0 for JPY, 3 for KWD. */
  exponent: number;
  /**
   * Quantization step, in minor units. Defaults to 1.
   *
   * This is what replaces the old global `allowFractionalAmounts` boolean: NGN quoting in
   * whole naira is `{ exponent: 2, roundingIncrement: 100 }` — a currency policy rather
   * than a per-call flag.
   */
  roundingIncrement?: number;
}

/** Rounds half away from zero, matching the old `toFixed`/`Math.round` behaviour. */
function roundHalfUp (n: number): number {
  // Correct for float representation error (e.g. 1049.9999999999998 -> 1050) before
  // rounding, otherwise a value that is mathematically exactly .5 can round down.
  const corrected = Number(n.toPrecision(12));
  return corrected < 0 ? -Math.round(-corrected) : Math.round(corrected);
}

export function money (currency: string, minor: number): Money {
  return { currency, minor };
}

export function zero (currency: string): Money {
  return { currency, minor: 0 };
}

export function scaleFactor (meta: CurrencyMeta): number {
  return 10 ** meta.exponent;
}

/** Major units (12.99) -> fractional minor units (1299). Not quantized. */
export function toMinor (meta: CurrencyMeta, major: number): number {
  return major * scaleFactor(meta);
}

/** Minor units (1299) -> major units (12.99). */
export function toMajor (meta: CurrencyMeta, minor: number): number {
  return minor / scaleFactor(meta);
}

/** Applies the currency's rounding increment, returning whole minor units. */
export function quantize (meta: CurrencyMeta, minorFloat: number): number {
  const increment = meta.roundingIncrement && meta.roundingIncrement > 0 ? meta.roundingIncrement : 1;
  return roundHalfUp(minorFloat / increment) * increment;
}

export function quantizeMoney (meta: CurrencyMeta, minorFloat: number): Money {
  return money(meta.code, quantize(meta, minorFloat));
}

export function addMoney (a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.currency, a.minor + b.minor);
}

export function subMoney (a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.currency, a.minor - b.minor);
}

export function mulMoney (a: Money, factor: number): Money {
  return money(a.currency, a.minor * factor);
}

export function compareMoney (a: Money, b: Money): number {
  assertSameCurrency(a, b);
  return a.minor - b.minor;
}

export function isZeroMoney (a: Money): boolean {
  return a.minor === 0;
}

function assertSameCurrency (a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new Error(`Cannot combine ${a.currency} with ${b.currency}`);
  }
}

export function formatMoney (meta: CurrencyMeta, amount: Money): string {
  const major = toMajor(meta, amount.minor);
  const increment = meta.roundingIncrement && meta.roundingIncrement > 0 ? meta.roundingIncrement : 1;
  // Show only the digits the rounding increment can actually express: whole-naira NGN
  // renders as ₦21,500 rather than ₦21,500.00.
  const step = increment / scaleFactor(meta);
  const digits = step >= 1 ? 0 : meta.exponent;
  return `${meta.symbol}${major.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
}

/** The USD metadata used when a config does not supply its own. */
export const USD: CurrencyMeta = { code: 'USD', symbol: '$', exponent: 2 };
