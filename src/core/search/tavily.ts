// Tavily Search API adapter. Facts from Tavily's documentation, read 2026-11-25:
// - https://docs.tavily.com/documentation/api-reference/endpoint/search
//   POST https://api.tavily.com/search, Bearer authentication with the API key. JSON body: `query`
//   (required); `search_depth` basic | advanced | fast | ultra-fast (basic, fast and ultra-fast cost
//   1 credit, advanced 2); `max_results` 0-20 (default 10); `include_answer` and
//   `include_raw_content` default false; `include_domains`, a list of up to 300 domains (with
//   `include_domains_mode` restrict, the default); `country`, an English country name such as
//   "slovakia", available only with `topic` general; `include_usage` adds `usage.credits` to the
//   answer. Results: [{title, url, content, score, ...}]. Status codes: 401 wrong or missing key,
//   429 rate limit (may carry Retry-After), 432 key limit or plan limit exceeded, 433 pay-as-you-go
//   limit exceeded. The docs do not mention a `site:` operator, so domains go in `include_domains`.
// - https://docs.tavily.com/documentation/api-credits : 1,000 free credits every month, no card;
//   the cost is stated per request (by search depth), not per result.
// - https://docs.tavily.com/faq/faq.md : credits "reset on the first day of each month, regardless of
//   the billing date".
// - https://docs.tavily.com/documentation/rate-limits : 100 requests per minute on the free plan.

import type { FetchLike } from '../http.ts';
import { ProviderUnavailableError, untilNextMonth, type Locale, type SearchHit, type SearchProvider, type SiteSearch } from './provider.ts';

export const TAVILY_URL = 'https://api.tavily.com/search';

/** Tavily's `country` value for the shop countries this app searches (all five are in the documented list). */
const TAVILY_COUNTRY: Record<string, string> = {
  sk: 'slovakia', cz: 'czech republic', de: 'germany', at: 'austria', pl: 'poland',
};

export class TavilyProvider implements SearchProvider {
  readonly id = 'tavily';
  readonly resultsPerQuery: number;
  /** 100 requests per minute on the free plan: at most one every 0.6 s, with some margin. */
  readonly minIntervalMs = 700;
  private readonly key: string;

  constructor(apiKey: string, resultsPerQuery = 20) {
    this.key = apiKey;
    this.resultsPerQuery = Math.max(1, Math.min(20, resultsPerQuery));
  }

  exhaustedTtlSeconds(kind: 'quota' | 'auth'): number {
    // Credits reset on the first day of each month (UTC assumed; the FAQ names no time zone).
    return kind === 'quota' ? untilNextMonth() : 86400;
  }

  /** The JSON body: the plain query, the domains as a list, the cheapest depth, nothing generated. */
  body(s: SiteSearch, locale: Locale): Record<string, unknown> {
    const country = TAVILY_COUNTRY[locale.country];
    return {
      query: s.query,
      search_depth: 'basic',
      topic: 'general',
      max_results: this.resultsPerQuery,
      include_answer: false,
      include_raw_content: false,
      include_images: false,
      include_usage: true,
      ...(s.domains.length ? { include_domains: s.domains } : {}),
      ...(country ? { country } : {}),
    };
  }

  async search(s: SiteSearch, locale: Locale, fetchImpl: FetchLike = fetch): Promise<{ hits: SearchHit[]; credits: number }> {
    const res = await fetchImpl(TAVILY_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(this.body(s, locale)),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      // Never put request headers (the key) into errors.
      await res.text().catch(() => '');
      if (res.status === 432 || res.status === 433) {
        throw new ProviderUnavailableError('quota', res.status, `Tavily credits used up (HTTP ${res.status})`);
      }
      if (res.status === 401) throw new ProviderUnavailableError('auth', res.status, `Tavily rejected the key (HTTP ${res.status})`);
      // 429 (rate limit), 5xx and others: a failure of this query only, no retry.
      throw new Error(`Tavily HTTP ${res.status}`);
    }
    const json = (await res.json()) as { results?: { url?: string; title?: string; content?: string }[]; usage?: { credits?: number } };
    const hits = (json.results ?? [])
      .filter((r) => typeof r.url === 'string')
      .map((r) => ({ url: r.url as string, title: r.title ?? '', snippet: r.content ?? '' }));
    return { hits, credits: typeof json.usage?.credits === 'number' ? json.usage.credits : 1 };
  }
}
