/**
 * Typed errors with stable `code` values.
 *
 * This is a deliberate reversal of tasks.yml task 2 (which proposed native Errors):
 * a library embedded in checkout flows benefits from callers branching on `err.code`
 * rather than string-matching messages. See design-docs/generalized-quote-engine.md.
 */
export class QuoteError extends Error {
  readonly code: string;

  constructor (code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'QuoteError';
    this.code = code;
  }
}

export class UnknownSkuError extends QuoteError {
  readonly sku: string;

  constructor (sku: string) {
    super('ERR_UNKNOWN_SKU', `Unknown sku: ${sku}`);
    this.name = 'UnknownSkuError';
    this.sku = sku;
  }
}

export class UnknownVariantError extends QuoteError {
  readonly sku: string;
  readonly variant: string;

  constructor (sku: string, variant: string) {
    super('ERR_UNKNOWN_VARIANT', `Unknown variant '${variant}' for sku '${sku}'`);
    this.name = 'UnknownVariantError';
    this.sku = sku;
    this.variant = variant;
  }
}

export class VariantNotEligibleError extends QuoteError {
  readonly sku: string;
  readonly variant: string;

  constructor (sku: string, variant: string) {
    super('ERR_VARIANT_NOT_ELIGIBLE', `Not eligible for variant '${variant}' of sku '${sku}'`);
    this.name = 'VariantNotEligibleError';
    this.sku = sku;
    this.variant = variant;
  }
}

export class UnsupportedCurrencyError extends QuoteError {
  readonly currency: string;

  constructor (currency: string) {
    super('ERR_UNSUPPORTED_CURRENCY', `Unsupported currency: ${currency}`);
    this.name = 'UnsupportedCurrencyError';
    this.currency = currency;
  }
}

export class NoPriceError extends QuoteError {
  constructor (description: string) {
    super('ERR_NO_PRICE', `No price rule matched: ${description}`);
    this.name = 'NoPriceError';
  }
}

export class InvalidRequestError extends QuoteError {
  constructor (message: string) {
    super('ERR_INVALID_REQUEST', message);
    this.name = 'InvalidRequestError';
  }
}

/**
 * Thrown when a quote total falls below the configured `minChargeableTotal`.
 * Replaces tasks.yml task 3's "total must be > 0" hard rule: a generic engine
 * legitimately quotes zero for free tiers, so the floor is opt-in config.
 */
export class BelowMinimumChargeError extends QuoteError {
  readonly total: number;
  readonly minimum: number;

  constructor (currency: string, total: number, minimum: number) {
    super(
      'ERR_BELOW_MINIMUM_CHARGE',
      `Total ${total} ${currency} is below the minimum chargeable total of ${minimum} ${currency}`
    );
    this.name = 'BelowMinimumChargeError';
    this.total = total;
    this.minimum = minimum;
  }
}
