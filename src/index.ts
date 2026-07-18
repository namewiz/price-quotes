/**
 * A generic quote engine.
 *
 * This entry point is pure: it performs no I/O and no network access at import time.
 * Product-specific knowledge (and any data fetching it needs) lives in presets:
 *
 *   import { Quotes } from 'price-quotes';
 *   import { domainsPreset } from 'price-quotes/presets/domains';
 *   import { softwareQuotes } from 'price-quotes/presets/software';
 */
export * from './core';
