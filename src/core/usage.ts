// How much of each web search provider's free allowance is used: for the bars on the page
// (GET /api/usage). Portable: the call log and the cache are injected.
//
// Where the numbers come from:
// - The app's own count: the credits of the successful calls it logged (provider_calls in SQLite;
//   a failed call is logged with 0 credits and ok = 0, and is not counted). Brave and Tavily count
//   from the first day of the current month (UTC), when their free credit renews; Serper over all
//   time, because its free queries are given once.
// - Brave states its limits in the headers of every API response (Brave's rate limiting guide,
//   https://api-dashboard.search.brave.com/documentation/guides/rate-limiting, read 2026-11-25):
//     X-RateLimit-Limit: 1, 15000          per window: requests per second, requests per month (0 = unlimited)
//     X-RateLimit-Policy: 1;w=1, 15000;w=2592000   the same with the window in seconds (2592000 = 30 days)
//     X-RateLimit-Remaining: 1, 1000       requests left in each window
//     X-RateLimit-Reset: 1, 1419704        seconds until each window resets
//   "Only successful requests (non-error responses) are counted against your quota and billed."
//   The latest values of the monthly window are kept from each search response (no extra request)
//   and preferred over the app's count while that window lasts; they also count use of the same key
//   elsewhere.
// - Tavily documents GET https://api.tavily.com/usage (credits used per key and plan,
//   https://docs.tavily.com/documentation/api-reference/endpoint/usage) but does not say whether it
//   costs a credit (neither that page nor https://docs.tavily.com/documentation/api-credits), so it
//   is not called: Tavily uses the app's count. Serper's documentation names no usage endpoint that
//   could be read, so Serper uses the app's count too.

import type { Cache } from './types.ts';

export type UsagePeriod = 'month' | 'total';

export interface ProviderUsage {
  provider: string;
  used: number;
  limit: number;
  period: UsagePeriod;
  /** 'app': counted from this app's own call log; 'provider': as the provider reported it. */
  source: 'app' | 'provider';
  /** The provider is marked as out of credit (or its key rejected) after an answer that said so. */
  exhausted: boolean;
}

/** The latest monthly figures a provider reported in its answer headers (cache namespace provider_quota). */
export interface ProviderQuota {
  limit: number;
  remaining: number;
  /** Seconds until the window resets, as reported. */
  resetSeconds: number;
}

export const USAGE_PERIOD: Record<string, UsagePeriod> = { brave: 'month', serper: 'total', tavily: 'month' };
/** The free allowances as of 2026-11 (README "Where to get a key"); each can be changed in .env. */
export const DEFAULT_LIMITS: Record<string, number> = { brave: 1000, serper: 2500, tavily: 1000 };
export const LIMIT_ENV: Record<string, string> = { brave: 'BRAVE_MONTHLY_LIMIT', serper: 'SERPER_TOTAL_LIMIT', tavily: 'TAVILY_MONTHLY_LIMIT' };

/** The allowance per provider: a positive whole number from the environment, else the default. */
export function limitsFromEnv(env: Record<string, string | undefined>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, def] of Object.entries(DEFAULT_LIMITS)) {
    const v = Number(env[LIMIT_ENV[id]]?.trim().replace(/[\s_,]/g, ''));
    out[id] = Number.isInteger(v) && v > 0 ? v : def;
  }
  return out;
}

/** The first moment of the current month in UTC, as an ISO string (the log's `at` uses the same form). */
export function monthStartUtc(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

/** The bar's colour: 'ok' below 80 %, 'warn' from 80 %, 'full' at 100 % or when the provider is marked exhausted. */
export function usageLevel(used: number, limit: number, exhausted = false): 'ok' | 'warn' | 'full' {
  if (exhausted || (limit > 0 && used >= limit)) return 'full';
  if (limit > 0 && used >= 0.8 * limit) return 'warn';
  return 'ok';
}

/**
 * Brave's monthly window from its rate-limit headers: the policy entry with the longest window (the
 * last entry when there is no policy header), paired by position with Limit, Remaining and Reset.
 * null when a header is missing or unreadable, or the monthly limit is 0 (unlimited).
 */
export function parseBraveRateLimit(headers: Headers): ProviderQuota | null {
  const list = (name: string) => (headers.get(name) ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const limits = list('x-ratelimit-limit').map(Number);
  const remaining = list('x-ratelimit-remaining').map(Number);
  const reset = list('x-ratelimit-reset').map(Number);
  if (!limits.length || limits.length !== remaining.length || limits.length !== reset.length) return null;
  const windows = list('x-ratelimit-policy').map((p) => Number(/;\s*w=(\d+)/.exec(p)?.[1]));
  let i = limits.length - 1;
  if (windows.length === limits.length && windows.every((w) => Number.isFinite(w))) i = windows.indexOf(Math.max(...windows));
  const q = { limit: limits[i], remaining: remaining[i], resetSeconds: reset[i] };
  if (![q.limit, q.remaining, q.resetSeconds].every((n) => Number.isFinite(n) && n >= 0) || q.limit === 0) return null;
  return q;
}

/** Keeps a reported quota until its window resets (at least a minute). */
export async function rememberQuota(cache: Cache, provider: string, q: ProviderQuota): Promise<void> {
  await cache.set('provider_quota', provider, q, Math.max(60, Math.ceil(q.resetSeconds)));
}

/**
 * Usage of each provider in `ids` (those with a key; the caller never passes key material): the
 * provider's own figures while they are current, else the app's count against the allowance.
 */
export async function providerUsage(opts: {
  ids: string[];
  limits: Record<string, number>;
  cache: Cache;
  /** Credits of the successful logged calls of a provider since an ISO time (null = all time). */
  appCredits: (provider: string, sinceIso: string | null) => number;
  now?: Date;
}): Promise<ProviderUsage[]> {
  const out: ProviderUsage[] = [];
  for (const id of opts.ids) {
    const period = USAGE_PERIOD[id] ?? 'month';
    const exhausted = Boolean(await opts.cache.get('provider_exhausted', id));
    const reported = await opts.cache.get<ProviderQuota>('provider_quota', id);
    if (reported && reported.limit > 0) {
      out.push({ provider: id, used: Math.max(0, reported.limit - reported.remaining), limit: reported.limit, period, source: 'provider', exhausted });
      continue;
    }
    const used = opts.appCredits(id, period === 'month' ? monthStartUtc(opts.now) : null);
    out.push({ provider: id, used, limit: opts.limits[id] ?? DEFAULT_LIMITS[id] ?? 0, period, source: 'app', exhausted });
  }
  return out;
}
