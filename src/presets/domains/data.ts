/**
 * Remote data loading for the domains preset.
 *
 * All network access in the library lives in this file. The core engine takes in-memory
 * catalogs and never does I/O, and nothing here runs at import time — `loadDomainData` is
 * only called when a caller explicitly asks for it.
 */

export interface ExchangeRateData {
  countryCode: string;
  currencyName: string;
  currencySymbol: string;
  currencyCode: string;
  exchangeRate: number;
  inverseRate: number;
}

/** tld -> currency code -> price in major units. */
export type DomainPriceTable = Record<string, Record<string, number>>;

export interface ParsedPrices {
  prices: DomainPriceTable;
  /** tld -> the provider owning the winning (cheapest USD) row. */
  providers: Record<string, string>;
}

export interface DomainDataSources {
  create: string;
  renew: string;
  transfer: string;
  restore?: string;
  rates: string;
}

const BASE = 'https://raw.githubusercontent.com/namewiz/registrar-pricelist/refs/heads/main/data';

export const DEFAULT_SOURCES: DomainDataSources = {
  create: `${BASE}/unified-create-prices.csv`,
  renew: `${BASE}/unified-renew-prices.csv`,
  transfer: `${BASE}/unified-transfer-prices.csv`,
  rates: `${BASE}/exchange-rates.json`,
};

export type FetchLike = (url: string) => Promise<Response>;

export interface DomainData {
  create: ParsedPrices;
  renew: ParsedPrices;
  transfer: ParsedPrices;
  restore?: ParsedPrices;
  rates: ExchangeRateData[];
}

export interface LoadOptions {
  /** Injectable for tests and for callers with their own HTTP stack. Defaults to global fetch. */
  fetch?: FetchLike;
  sources?: Partial<DomainDataSources>;
  /** Shared response cache. Pass `false` to disable, or your own Map to control lifetime. */
  cache?: Map<string, Promise<unknown>> | false;
}

/** Process-wide default cache, so repeated presets do not refetch the same CSVs. */
const defaultCache = new Map<string, Promise<unknown>>();

export function clearDomainDataCache (): void {
  defaultCache.clear();
}

function describeNetworkError (url: string, error: unknown): string {
  const cause = error instanceof Error ? (error.cause as { code?: string } | undefined) : undefined;
  const code = cause?.code;
  let reason: string;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    reason = 'DNS resolution failed (likely no network connectivity or an invalid hostname)';
  } else if (code === 'ECONNREFUSED') {
    reason = 'connection refused by the remote host';
  } else if (code === 'ECONNRESET') {
    reason = 'connection was reset while fetching';
  } else if (code === 'ETIMEDOUT' || (error instanceof Error && error.name === 'TimeoutError')) {
    reason = 'request timed out';
  } else if (error instanceof Error && error.name === 'AbortError') {
    reason = 'request was aborted';
  } else {
    reason = 'network request failed (no network connection or the host is unreachable)';
  }
  const detail = code ? ` [${code}]` : '';
  return `Network error fetching ${url}: ${reason}${detail}`;
}

function describeHttpError (url: string, res: Response): string {
  let reason: string;
  if (res.status === 404) {
    reason = 'resource not found';
  } else if (res.status === 429) {
    reason = 'rate limited by the remote host';
  } else if (res.status === 401 || res.status === 403) {
    reason = 'access denied (unauthorized/forbidden)';
  } else if (res.status >= 500) {
    reason = 'remote server error';
  } else {
    reason = 'unexpected response status';
  }
  return `Failed to fetch ${url}: ${res.status} ${res.statusText} (${reason})`;
}

async function fetchWithDiagnostics (fetchImpl: FetchLike, url: string): Promise<Response> {
  try {
    return await fetchImpl(url);
  } catch (error) {
    throw new Error(describeNetworkError(url, error), { cause: error });
  }
}

async function fetchText (fetchImpl: FetchLike, url: string): Promise<string> {
  const res = await fetchWithDiagnostics(fetchImpl, url);
  if (!res.ok) throw new Error(describeHttpError(url, res));
  return res.text();
}

async function fetchJson<T> (fetchImpl: FetchLike, url: string): Promise<T> {
  const res = await fetchWithDiagnostics(fetchImpl, url);
  if (!res.ok) throw new Error(describeHttpError(url, res));
  return res.json() as Promise<T>;
}

/** CSV columns: tld,provider,currency,amount */
export function parseUnifiedPricesCsv (csv: string): ParsedPrices {
  const lines = csv.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return { prices: {}, providers: {} };
  lines.shift(); // header

  const prices: DomainPriceTable = {};
  const providers: Record<string, string> = {};
  const winningUsd: Record<string, number> = {};

  for (const line of lines) {
    const parts = line.split(',');
    if (parts.length < 4) continue;
    const tld = parts[0]?.trim().toLowerCase();
    const provider = parts[1]?.trim().toLowerCase();
    const currency = parts[2]?.trim().toUpperCase();
    const amount = Number(parts[3]?.trim());
    if (!tld || !currency || !Number.isFinite(amount) || amount <= 0) continue;

    const map = prices[tld] ?? (prices[tld] = {});
    const previous = map[currency];
    // Several registrars quote the same TLD; the cheapest wins.
    map[currency] = previous === undefined ? amount : Math.min(previous, amount);

    if (currency === 'USD' && provider) {
      const currentWinner = winningUsd[tld];
      if (currentWinner === undefined || amount < currentWinner) {
        winningUsd[tld] = amount;
        providers[tld] = provider;
      }
    }
  }

  return { prices, providers };
}

function cached<T> (cache: Map<string, Promise<unknown>> | undefined, key: string, load: () => Promise<T>): Promise<T> {
  if (!cache) return load();
  const existing = cache.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const promise = load().catch((error) => {
    // Never cache a failure: a transient network blip should not poison the process.
    cache.delete(key);
    throw error;
  });
  cache.set(key, promise);
  return promise;
}

export async function loadDomainData (options: LoadOptions = {}): Promise<DomainData> {
  const fetchImpl = options.fetch ?? (globalThis.fetch as FetchLike | undefined);
  if (!fetchImpl) {
    throw new Error(
      'price-quotes: no fetch implementation available. Pass `fetch` to domainsPreset(), or supply `data` directly.'
    );
  }
  const sources = { ...DEFAULT_SOURCES, ...options.sources };
  const cache = options.cache === false ? undefined : options.cache ?? defaultCache;

  const loadPrices = (url: string): Promise<ParsedPrices> =>
    cached(cache, url, () => fetchText(fetchImpl, url).then(parseUnifiedPricesCsv));

  try {
    const [create, renew, transfer, restore, rates] = await Promise.all([
      loadPrices(sources.create),
      loadPrices(sources.renew),
      loadPrices(sources.transfer),
      sources.restore ? loadPrices(sources.restore) : Promise.resolve(undefined),
      cached(cache, sources.rates, () => fetchJson<ExchangeRateData[]>(fetchImpl, sources.rates)),
    ]);
    return { create, renew, transfer, restore, rates };
  } catch (error) {
    const err =
      error instanceof Error
        ? error
        : new Error(typeof error === 'string' ? error : 'Unknown error', { cause: error });
    err.message = `price-quotes: failed to load remote pricing data: ${err.message}`;
    throw err;
  }
}
