// ECB reference rates from the free Frankfurter API (https://frankfurter.dev), cached for a day.
// Endpoint: /v2/providers/ecb/rates?base=EUR&quotes=CZK,PLN -> [{date, base, quote, rate}, ...]

import { USER_AGENT, type FetchLike } from './http.ts';
import type { Rates } from './totals.ts';
import { CACHE_TTL, type Cache } from './types.ts';

export const FRANKFURTER_URL = 'https://api.frankfurter.dev/v2/providers/ecb/rates';

export function parseFrankfurter(json: unknown): Rates | null {
  if (!Array.isArray(json)) return null;
  const rates: Record<string, number> = {};
  let date = '';
  for (const row of json) {
    if (row && typeof row === 'object' && typeof row.quote === 'string' && typeof row.rate === 'number' && row.base === 'EUR') {
      rates[row.quote.toUpperCase()] = row.rate;
      date = date || String(row.date ?? '');
    }
  }
  return Object.keys(rates).length ? { base: 'EUR', date, rates, source: 'ECB via frankfurter.dev' } : null;
}

export async function getRates(currencies: string[], cache: Cache, fetchImpl: FetchLike = fetch): Promise<{ rates: Rates | null; error?: string }> {
  const wanted = [...new Set(currencies.map((c) => c.toUpperCase()).filter((c) => c !== 'EUR'))].sort();
  if (!wanted.length) return { rates: { base: 'EUR', date: '', rates: {}, source: 'none needed' } };
  const key = wanted.join(',');
  const cached = await cache.get<Rates>('rates', key);
  if (cached) return { rates: cached };
  try {
    const res = await fetchImpl(`${FRANKFURTER_URL}?base=EUR&quotes=${encodeURIComponent(key)}`, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { rates: null, error: `Frankfurter HTTP ${res.status}` };
    const rates = parseFrankfurter(await res.json());
    if (!rates) return { rates: null, error: 'Frankfurter: unexpected response' };
    await cache.set('rates', key, rates, CACHE_TTL.rates);
    return { rates };
  } catch (e) {
    return { rates: null, error: `Frankfurter: ${e instanceof Error ? e.message : String(e)}` };
  }
}
