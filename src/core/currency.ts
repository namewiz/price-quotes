import { UnsupportedCurrencyError } from './errors';
import type { CurrencyMeta } from './money';

/** Units of each currency per 1 unit of the base currency. */
export type RateTable = Record<string, number>;

export interface RateResolution {
  rate: number;
  /**
   * `direct`  - the price rule quoted this currency itself, so the rule defines its own
   *             effective rate (an "implied rate"). Preserves the old behaviour where a
   *             `{ USD: 10, NGN: 1500 }` entry priced NGN at 1500, not 10 x fxRate.
   * `fx`      - converted from the base currency via the rate table.
   * `identity`- the target currency is the base currency.
   */
  source: 'direct' | 'fx' | 'identity';
}

export function fxRate (rates: RateTable, baseCurrency: string, target: string): number {
  if (target === baseCurrency) return 1;
  const rate = rates[target];
  if (rate === undefined || !Number.isFinite(rate) || rate <= 0) {
    throw new UnsupportedCurrencyError(target);
  }
  return rate;
}

/**
 * Works out the rate to apply to a base-currency amount to reach `target`.
 *
 * When the price rule already quotes `target` directly, that quote wins and defines the
 * effective rate for this line — a rule priced in NGN is authoritative for NGN, and any
 * markup expressed in the base currency scales by the implied rate.
 */
export function resolveRate (
  amounts: Record<string, number>,
  baseAmount: number,
  baseCurrency: string,
  target: string,
  rates: RateTable
): RateResolution {
  const direct = amounts[target];
  if (direct !== undefined && baseAmount > 0) {
    return { rate: direct / baseAmount, source: target === baseCurrency ? 'identity' : 'direct' };
  }
  if (target === baseCurrency) return { rate: 1, source: 'identity' };
  return { rate: fxRate(rates, baseCurrency, target), source: 'fx' };
}

export function findCurrency (currencies: CurrencyMeta[], code: string): CurrencyMeta {
  const upper = (code || '').toUpperCase();
  const found = currencies.find((c) => c.code === upper);
  if (!found) throw new UnsupportedCurrencyError(code);
  return found;
}
