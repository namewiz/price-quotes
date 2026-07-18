import { normalizeConfig, type EngineConfig } from './config';
import { InvalidRequestError } from './errors';
import { explore as runExplore, resolveExploreOptions } from './insights';
import { normalizeInterval } from './interval';
import { EligibilityMemo, priceQuote, type PriceContext } from './pricing';
import type { CurrencyMeta, Quote, QuoteOptions, QuoteRequest, QuotesConfig, ResolvedRequest } from './types';

function asNowValue (now?: number | Date): number {
  if (now instanceof Date) return now.getTime();
  if (typeof now === 'number') return now;
  return Date.now();
}

/**
 * The generic quote engine.
 *
 * Knows nothing about domains, software, or any other product type: it takes an
 * in-memory catalog and does no I/O. Product-specific knowledge belongs in a preset
 * (see `presets/domains`, `presets/software`).
 */
export class Quotes {
  private readonly config: EngineConfig;

  constructor (config: QuotesConfig) {
    this.config = normalizeConfig(config);
  }

  /** Prices a request. Pass `{ explore: true }` to also compute savings insights. */
  async quote (request: QuoteRequest, options: QuoteOptions = {}): Promise<Quote> {
    const resolved = this.resolveRequest(request);
    const ctx: PriceContext = {
      config: this.config,
      catalog: this.config.catalog,
      memo: new EligibilityMemo(),
      nowMs: asNowValue(request.now),
      discountCodes: request.discountCodes ?? [],
      discountPolicy: request.discountPolicy ?? this.config.defaults.discountPolicy,
    };

    const quote = await priceQuote(ctx, resolved);

    const exploreOptions = resolveExploreOptions(options.explore);
    if (!exploreOptions) return quote;

    const { insights, alternatives } = await runExplore(ctx, quote, exploreOptions);
    return { ...quote, insights, alternatives };
  }

  private resolveRequest (request: QuoteRequest): ResolvedRequest {
    if (!request.sku) throw new InvalidRequestError('sku is required');
    if (!request.currency) throw new InvalidRequestError('currency is required');

    const product = this.config.catalog.getProduct(request.sku);
    const variant = request.variant ?? this.config.defaults.variant ?? product.variants[0]?.id;
    if (!variant) throw new InvalidRequestError(`product '${product.sku}' declares no variants`);

    return {
      sku: product.sku,
      variant,
      interval: normalizeInterval(request.interval, product.intervals?.[0] ?? this.config.defaults.interval),
      term: request.term ?? this.config.defaults.term,
      quantity: request.quantity ?? this.config.defaults.quantity,
      currency: (request.currency || '').toUpperCase(),
      context: request.context,
    };
  }

  normalizeSku (raw: string): string {
    return this.config.catalog.normalizeSku(raw);
  }

  listSkus (): string[] {
    return this.config.catalog.products.map((p) => p.sku).sort();
  }

  hasSku (sku: string): boolean {
    return !!sku && this.config.catalog.hasProduct(sku);
  }

  listCurrencies (): string[] {
    return this.config.currencies.map((c) => c.code);
  }

  hasCurrency (code: string): boolean {
    if (!code) return false;
    return this.config.currencies.some((c) => c.code === code.toUpperCase());
  }

  getCurrency (code: string): CurrencyMeta | undefined {
    return this.config.currencies.find((c) => c.code === code.toUpperCase());
  }
}
