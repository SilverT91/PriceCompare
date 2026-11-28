// Brave Search API adapter (own index, not Google).
// GET https://api.search.brave.com/res/v1/web/search?q=...&count=20&country=..&search_lang=..
// Header X-Subscription-Token. Response: {web: {results: [{url, title, description}]}}.
// Per the API reference: count max 20; `country` accepts a fixed list that includes AT, DE, PL but
// not SK or CZ (those use ALL); `search_lang` includes sk, cs, de, pl. site: and OR go inside q.
// Free plan: about 1 request per second; HTTP 429 when faster. With a spend limit, HTTP 402 once the
// monthly credit is used up (until the next month).
// Every answer carries X-RateLimit-* headers with the monthly limit and what remains (usage.ts,
// parseBraveRateLimit); they are passed on with the results, no extra request is made.

import type { FetchLike } from '../http.ts';
import { parseBraveRateLimit, type ProviderQuota } from '../usage.ts';
import { ProviderUnavailableError, searchText, untilNextMonth, type Locale, type SearchHit, type SearchProvider, type SiteSearch } from './provider.ts';

export const BRAVE_URL = 'https://api.search.brave.com/res/v1/web/search';
const BRAVE_COUNTRIES = new Set(['ar', 'au', 'at', 'be', 'br', 'ca', 'cl', 'dk', 'fi', 'fr', 'de', 'gr', 'hk', 'in', 'id', 'it', 'jp', 'kr', 'my', 'mx', 'nl', 'nz', 'no', 'cn', 'pl', 'pt', 'ph', 'ru', 'sa', 'za', 'es', 'se', 'ch', 'tw', 'tr', 'gb', 'us']);
const BRAVE_LANGS = new Set(['sk', 'cs', 'de', 'pl', 'en', 'hu', 'uk']);

export class BraveProvider implements SearchProvider {
  readonly id = 'brave';
  readonly resultsPerQuery: number;
  readonly minIntervalMs = 1100;
  /**
   * Brave's terms (updated 1 Sep 2026, section 3(b)(i)) allow only "transient storage required for
   * operation" of its results. 30 minutes covers one comparison: repeating it, switching the
   * language, opening another product. A search the next day asks Brave again.
   */
  readonly cacheSeconds = 30 * 60;
  private readonly key: string;

  constructor(apiKey: string, resultsPerQuery = 20) {
    this.key = apiKey;
    this.resultsPerQuery = Math.min(20, resultsPerQuery);
  }

  exhaustedTtlSeconds(kind: 'quota' | 'auth'): number {
    // The monthly credit renews on the first of the month (UTC assumed).
    return kind === 'quota' ? untilNextMonth() : 86400;
  }

  buildUrl(q: string, locale: Locale): string {
    const u = new URL(BRAVE_URL);
    u.searchParams.set('q', q);
    u.searchParams.set('count', String(this.resultsPerQuery));
    u.searchParams.set('country', BRAVE_COUNTRIES.has(locale.country) ? locale.country.toUpperCase() : 'ALL');
    if (BRAVE_LANGS.has(locale.lang)) u.searchParams.set('search_lang', locale.lang);
    u.searchParams.set('safesearch', 'off');
    return u.href;
  }

  async search(s: SiteSearch, locale: Locale, fetchImpl: FetchLike = fetch): Promise<{ hits: SearchHit[]; credits: number; quota: ProviderQuota | null }> {
    const res = await fetchImpl(this.buildUrl(searchText(s), locale), {
      headers: { 'X-Subscription-Token': this.key, Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 300);
      if (res.status === 402 || /QUOTA_LIMITED|quota/i.test(body)) {
        throw new ProviderUnavailableError('quota', res.status, `Brave monthly credit used up (HTTP ${res.status})`);
      }
      if (res.status === 401 || res.status === 403) throw new ProviderUnavailableError('auth', res.status, `Brave rejected the key (HTTP ${res.status})`);
      throw new Error(`Brave HTTP ${res.status}`);
    }
    const json = (await res.json()) as { web?: { results?: { url?: string; title?: string; description?: string }[] } };
    const hits = (json.web?.results ?? [])
      .filter((r) => typeof r.url === 'string')
      .map((r) => ({ url: r.url as string, title: stripTags(r.title ?? ''), snippet: stripTags(r.description ?? '') }));
    return { hits, credits: 1, quota: parseBraveRateLimit(res.headers) };
  }
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}
