import type { CompiledCatalog } from './catalog';
import { durationDays, formatInterval, sameInterval } from './interval';
import { formatMoney, money } from './money';
import { priceQuote, type PriceContext } from './pricing';
import type {
  ExploreOptions,
  Insight,
  InsightKind,
  Interval,
  Product,
  Quote,
  ResolvedRequest,
  Savings,
} from './types';

interface Candidate {
  request: ResolvedRequest;
  kind: InsightKind;
  /** Extra discount codes to price with; only used by 'discount-available'. */
  extraCodes?: string[];
}

const DEFAULTS = {
  maxCandidates: 24,
  minSavingsPercent: 0.01,
};

export function resolveExploreOptions (explore: boolean | ExploreOptions | undefined): ExploreOptions | undefined {
  if (!explore) return undefined;
  return explore === true ? {} : explore;
}

export async function explore (
  ctx: PriceContext,
  baseline: Quote,
  opts: ExploreOptions
): Promise<{ insights: Insight[]; alternatives: Quote[] }> {
  const product = ctx.catalog.getProduct(baseline.request.sku);
  const candidates = buildCandidates(ctx.catalog, product, baseline, ctx, opts).slice(
    0,
    opts.maxCandidates ?? DEFAULTS.maxCandidates
  );

  const insights: Insight[] = [];
  const alternatives: Quote[] = [];
  const minPercent = opts.minSavingsPercent ?? DEFAULTS.minSavingsPercent;

  for (const candidate of candidates) {
    let quote: Quote;
    try {
      const candidateCtx: PriceContext = candidate.extraCodes
        ? { ...ctx, discountCodes: [...ctx.discountCodes, ...candidate.extraCodes] }
        : ctx;
      quote = await priceQuote(candidateCtx, candidate.request);
    } catch {
      // An unpriceable or ineligible candidate is simply not an option. Never surface it.
      continue;
    }

    const insight = classify(baseline, quote, candidate, opts, minPercent);
    if (!insight) continue;
    insights.push(insight);
    alternatives.push(quote);
  }

  insights.sort(byValue);
  return { insights, alternatives };
}

function buildCandidates (
  catalog: CompiledCatalog,
  product: Product,
  baseline: Quote,
  ctx: PriceContext,
  opts: ExploreOptions
): Candidate[] {
  const req = baseline.request;
  const groups = product.groups ?? [];
  const out: Candidate[] = [];

  // --- variants ---------------------------------------------------------------
  // Only variants that config explicitly declared substitutable. The default of "no
  // substitution group" is what stops `renew` being suggested to someone buying `create`.
  if (opts.variants !== false) {
    const current = catalog.getVariant(product, req.variant);
    const group = current?.substitutionGroup;
    if (group) {
      for (const variant of product.variants) {
        if (variant.id === req.variant) continue;
        if (variant.substitutionGroup !== group) continue;
        out.push({ request: { ...req, variant: variant.id }, kind: 'variant-swap' });
      }
    }
  }

  // --- intervals --------------------------------------------------------------
  if (opts.intervals !== false) {
    const allowed = Array.isArray(opts.intervals) ? new Set(opts.intervals) : undefined;
    for (const interval of product.intervals ?? []) {
      if (sameInterval(interval, req.interval)) continue;
      if (allowed && !allowed.has(interval.unit)) continue;
      // A term measured in the old interval is meaningless in the new one; reset to 1.
      const term = interval.unit === 'once' ? 1 : 1;
      out.push({ request: { ...req, interval, term }, kind: 'interval-upgrade' });
    }
  }

  // --- terms ------------------------------------------------------------------
  if (opts.terms !== false && req.interval.unit !== 'once') {
    const declared = Array.isArray(opts.terms)
      ? opts.terms
      : catalog.termBreakpoints(product.sku, groups, req.variant, req.interval.unit);
    for (const term of declared) {
      // Only ever suggest buying *more* time. A shorter term is not a saving, it is less.
      if (term <= req.term) continue;
      out.push({ request: { ...req, term }, kind: 'term-upgrade' });
    }
  }

  // --- quantities -------------------------------------------------------------
  if (opts.quantities !== false) {
    const declared = Array.isArray(opts.quantities)
      ? opts.quantities
      : catalog.quantityBreakpoints(product.sku, groups, req.variant, req.interval.unit);
    for (const quantity of declared) {
      if (quantity <= req.quantity) continue;
      out.push({ request: { ...req, quantity }, kind: 'volume-tier' });
    }
  }

  // --- unrequested discount codes ---------------------------------------------
  // Off by default: it reveals codes the customer was never offered.
  if (opts.discounts === true) {
    const requested = new Set(ctx.discountCodes.map((c) => c.toUpperCase()));
    for (const code of Object.keys(ctx.config.discounts)) {
      if (requested.has(code)) continue;
      out.push({ request: { ...req }, kind: 'discount-available', extraCodes: [code] });
    }
  }

  return out;
}

function classify (
  baseline: Quote,
  candidate: Quote,
  spec: Candidate,
  opts: ExploreOptions,
  minPercent: number
): Insight | undefined {
  const comparison = compare(baseline, candidate, opts);
  if (!comparison) return undefined;

  const { savings, horizonDays, baselineOverProvisions, repeatsBaseline } = comparison;
  const meta = baseline.currency;
  const dominant = candidate.total.minor < baseline.total.minor;

  const providesExtra = extraProvision(baseline.request, candidate.request);
  const assumes = buildAssumptions(baseline, candidate, horizonDays, providesExtra, baselineOverProvisions, repeatsBaseline);

  if (savings.amount.minor > 0 && savings.percent >= minPercent) {
    return {
      kind: spec.kind,
      strength: dominant ? 'dominant' : savings.percent >= 0.1 ? 'strong' : 'info',
      alternative: candidate.request,
      quote: candidate,
      savings,
      dominant,
      providesExtra,
      assumes,
    };
  }

  // Not cheaper overall, but the unit rate improves: "add N more and each one costs less."
  // Only meaningful on the quantity axis.
  if (spec.kind === 'volume-tier' && candidate.unitPrice.minor < baseline.unitPrice.minor) {
    const dropPercent = (baseline.unitPrice.minor - candidate.unitPrice.minor) / baseline.unitPrice.minor;
    if (dropPercent < minPercent) return undefined;
    const extraCost = money(meta.code, candidate.total.minor - baseline.total.minor);
    if (extraCost.minor <= 0) return undefined;
    return {
      kind: 'tier-threshold',
      strength: 'info',
      alternative: candidate.request,
      quote: candidate,
      savings: {
        currency: meta.code,
        // A threshold is not a saving — it costs more and gives more. Saying otherwise
        // would be the kind of dishonest upsell this engine is meant to avoid.
        amount: money(meta.code, 0),
        percent: 0,
        horizonDays,
        baselineCost: savings.baselineCost,
        alternativeCost: savings.alternativeCost,
      },
      dominant: false,
      providesExtra,
      assumes,
      threshold: {
        extraCost,
        unitPriceFrom: baseline.unitPrice,
        unitPriceTo: candidate.unitPrice,
        unitPriceDropPercent: dropPercent,
      },
    };
  }

  return undefined;
}

interface Comparison {
  savings: Savings;
  horizonDays: number | null;
  baselineOverProvisions: boolean;
  repeatsBaseline: number;
}

/**
 * Normalizes two quotes onto a common horizon and compares what each actually costs
 * to cover it.
 */
function compare (baseline: Quote, candidate: Quote, opts: ExploreOptions): Comparison | undefined {
  const db = durationDays(baseline.request.interval, baseline.request.term);
  const dc = durationDays(candidate.request.interval, candidate.request.term);

  const bothOneTime = !Number.isFinite(db) && !Number.isFinite(dc);
  const mixedDuration = !bothOneTime && (!Number.isFinite(db) || !Number.isFinite(dc));

  // A one-time purchase is never compared against a recurring one. A perpetual licence
  // does not expire, so any horizon we picked would decide the answer by itself -- pick
  // three years and the subscription wins, pick ten and it loses. That is not a saving
  // calculation, it is a bet on how long the customer stays, and the engine has no basis
  // for making it. Even an explicit `horizonDays` does not rescue the comparison, because
  // the two options are not delivering the same thing over that window.
  if (mixedDuration) return undefined;

  let horizonDays: number | null;
  if (bothOneTime) {
    // Two one-time purchases need no horizon; their totals are directly comparable.
    horizonDays = null;
  } else {
    horizonDays = opts.horizonDays ?? Math.max(db, dc);
  }

  const repeatsBaseline = repeatsFor(db, horizonDays);
  const repeatsCandidate = repeatsFor(dc, horizonDays);

  const baselineMinor = baseline.total.minor * repeatsBaseline;
  const alternativeMinor = candidate.total.minor * repeatsCandidate;
  if (baselineMinor <= 0) return undefined;

  const meta = baseline.currency;
  const savingsMinor = baselineMinor - alternativeMinor;

  return {
    savings: {
      currency: meta.code,
      amount: money(meta.code, savingsMinor),
      percent: savingsMinor / baselineMinor,
      horizonDays,
      baselineCost: money(meta.code, baselineMinor),
      alternativeCost: money(meta.code, alternativeMinor),
    },
    horizonDays,
    baselineOverProvisions: horizonDays !== null && Number.isFinite(db) && repeatsBaseline * db > horizonDays + 0.5,
    repeatsBaseline,
  };
}

function repeatsFor (durationDaysValue: number, horizonDays: number | null): number {
  if (!Number.isFinite(durationDaysValue) || horizonDays === null) return 1;
  // A year is exactly 12 months by construction, but 365.2425 / 30.436875 can land a hair
  // above 12 in float. Without the epsilon that ceils to 13, and a monthly plan would be
  // billed 13 times in the comparison -- inventing a saving that does not exist.
  return Math.max(1, Math.ceil(horizonDays / durationDaysValue - 1e-9));
}

function extraProvision (baseline: ResolvedRequest, candidate: ResolvedRequest): Insight['providesExtra'] {
  const out: { days?: number; quantity?: number } = {};

  const db = durationDays(baseline.interval, baseline.term);
  const dc = durationDays(candidate.interval, candidate.term);
  if (Number.isFinite(db) && Number.isFinite(dc) && dc > db) {
    out.days = Math.round(dc - db);
  }
  if (candidate.quantity > baseline.quantity) {
    out.quantity = candidate.quantity - baseline.quantity;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function buildAssumptions (
  baseline: Quote,
  candidate: Quote,
  horizonDays: number | null,
  providesExtra: Insight['providesExtra'],
  baselineOverProvisions: boolean,
  repeatsBaseline: number
): string[] {
  const assumes: string[] = [];

  const db = durationDays(baseline.request.interval, baseline.request.term);
  if (horizonDays !== null && Number.isFinite(db) && horizonDays > db + 0.5) {
    assumes.push(`you keep this for ${Math.round(horizonDays)} days`);
  }
  if (providesExtra?.days) {
    assumes.push(`you buy ${Math.round(providesExtra.days)} more days of cover than you asked for`);
  }
  if (providesExtra?.quantity) {
    const units = providesExtra.quantity;
    assumes.push(`you buy ${units} more unit${units === 1 ? '' : 's'} than you asked for`);
  }
  if (baselineOverProvisions) {
    assumes.push(
      `the ${formatInterval(baseline.request.interval)} option is rounded up to ${repeatsBaseline} purchases to cover the window`
    );
  }
  return assumes;
}

/** Dominant savings first, then by absolute amount. */
function byValue (a: Insight, b: Insight): number {
  const rank = (i: Insight): number => (i.strength === 'dominant' ? 2 : i.strength === 'strong' ? 1 : 0);
  const rankDiff = rank(b) - rank(a);
  if (rankDiff !== 0) return rankDiff;
  return b.savings.amount.minor - a.savings.amount.minor;
}

/**
 * Renders an insight as English. Deliberately a helper rather than part of the engine:
 * core returns structured data, and localization is the caller's problem.
 */
export function formatInsight (insight: Insight): string {
  const meta = insight.quote.currency;
  const fmt = (minor: number): string => formatMoney(meta, money(meta.code, minor));
  const alt = insight.alternative;
  const percent = Math.round(insight.savings.percent * 100);

  let head: string;
  switch (insight.kind) {
    case 'interval-upgrade':
      head = `Switch to ${billingCadence(alt.interval)} billing and save ${fmt(insight.savings.amount.minor)} (${percent}%)`;
      break;
    case 'term-upgrade':
      head = `Buy ${alt.term} ${describeInterval(alt.interval)} at once and save ${fmt(insight.savings.amount.minor)} (${percent}%)`;
      break;
    case 'volume-tier':
      head = `Buy ${alt.quantity} and save ${fmt(insight.savings.amount.minor)} (${percent}%)`;
      break;
    case 'variant-swap':
      head = `Switch to ${alt.variant} and save ${fmt(insight.savings.amount.minor)} (${percent}%)`;
      break;
    case 'discount-available':
      head = `A discount code applies here: save ${fmt(insight.savings.amount.minor)} (${percent}%)`;
      break;
    case 'tier-threshold': {
      const drop = Math.round((insight.threshold?.unitPriceDropPercent ?? 0) * 100);
      head = `Buy ${alt.quantity} for ${fmt(insight.threshold?.extraCost.minor ?? 0)} more and each one costs ${drop}% less`;
      break;
    }
    default:
      head = 'Alternative available';
  }

  return insight.assumes.length > 0 ? `${head} (assumes ${insight.assumes.join(', ')})` : head;
}

function describeInterval (interval: Interval): string {
  const base = interval.unit === 'once' ? 'purchase' : interval.unit;
  return `${base}s`;
}

const CADENCE: Record<string, string> = {
  day: 'daily',
  week: 'weekly',
  month: 'monthly',
  year: 'yearly',
  once: 'one-time',
};

function billingCadence (interval: Interval): string {
  if ((interval.count ?? 1) !== 1) return formatInterval(interval);
  return CADENCE[interval.unit] ?? formatInterval(interval);
}
