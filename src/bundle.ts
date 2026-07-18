/**
 * Single-file browser bundle for the demo page (docs/index.html).
 *
 * Re-exports the core engine plus both presets so the demo can pull everything from one
 * module. Not a published entry point — consumers import from 'price-quotes' and
 * 'price-quotes/presets/*' instead.
 */
export { Quotes, formatInsight, formatMoney, toMajor } from './core';
export { softwareQuotes, softwarePreset } from './presets/software';
export { domainsPreset } from './presets/domains';
