// Money: quantization (representation) and charm (pricing policy) are two mechanisms
// that are not a pair — see design-docs/design-v2.md, "Money".

import { Charm, Quantization } from "./types.js";

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

/** Half away from zero, always — the one carve-out that isn't governed by the row's mode. */
export function roundTax(x: number): number {
  return roundNearestAwayFromZero(correctFloatError(x));
}

/**
 * Nearest charm candidate: a minor-unit integer whose digit at `position` is the charm digit
 * (4 or 9) and whose lower digits are all 9. Ties resolve downward. `charm(0) = 0` by definition.
 */
export function charmPrice(unitMinor: number, charm: Charm, position: number): number {
  if (charm === "none" || unitMinor === 0) return unitMinor;
  const digit = charm === "to9" ? 9 : 4;
  const lowStep = 10 ** position;
  const step = lowStep * 10;
  const base = digit * lowStep + (lowStep - 1);
  // Math.ceil(x - 0.5) rounds to nearest, ties toward -Infinity (i.e. "downward").
  const k = Math.ceil((unitMinor - base) / step - 0.5);
  return k * step + base;
}

export function isCharmCandidate(unitMinor: number, charm: Charm, position: number): boolean {
  if (charm === "none") return true;
  if (unitMinor === 0) return true;
  return charmPrice(unitMinor, charm, position) === unitMinor;
}
