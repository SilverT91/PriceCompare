// Serper.dev (Google results) adapter.
// POST https://google.serper.dev/search, header X-API-KEY, JSON body {q, gl, hl, num, autocorrect}.
// gl = country (sk, cz, de, at, pl), hl = interface language (sk, cs, de, pl).
// Response: {organic: [{title, link, snippet, position}], credits}. Up to 10 results cost 1 credit,
// 11-100 cost 2 (Serper's pricing as reported by third parties; the docs page is a JavaScript app).
// Out of credits: Serper does not document the status. Treated as quota exhaustion: HTTP 402, and
// HTTP 400/403 whose body mentions credits; other 401/403 = key rejected.

import type { FetchLike } from '../http.ts';
import { ProviderUnavailableError, type Locale, type SearchHit, type SearchProvider } from './provider.ts';

export const SERPER_URL = 'https://google.serper.dev/search';

export class SerperProvider implements SearchProvider {
  readonly id = 'serper';
  readonly resultsPerQuery: number;
  readonly minIntervalMs = 300;
  private readonly key: string;

  constructor(apiKey: string, resultsPerQuery = 10) {
    this.key = apiKey;
    this.resultsPerQuery = resultsPerQuery;
  }

  exhaustedTtlSeconds(kind: 'quota' | 'auth'): number {
    // The free credit is one-time: keep the mark for 30 days (delete the cache row after topping up).
    return kind === 'quota' ? 30 * 86400 : 86400;
  }

  async search(q: string, locale: Locale, fetchImpl: FetchLike = fetch): Promise<{ hits: SearchHit[]; credits: number }> {
    // Measured 2026-11-24: on a free account num > 10 is refused with HTTP 400 "Query pattern not
    // allowed for free accounts", so a combined site: query gets 10 results for all its domains.
    const num = this.resultsPerQuery;
    const res = await fetchImpl(SERPER_URL, {
      method: 'POST',
      headers: { 'X-API-KEY': this.key, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ q, gl: locale.country, hl: locale.lang, num, autocorrect: false }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      // Never put request headers (the key) into errors.
      const body = (await res.text().catch(() => '')).slice(0, 200);
      const credits = /credit/i.test(body);
      if (res.status === 402 || (credits && (res.status === 400 || res.status === 403))) {
        throw new ProviderUnavailableError('quota', res.status, `Serper credits used up (HTTP ${res.status})`);
      }
      if (res.status === 401 || res.status === 403) throw new ProviderUnavailableError('auth', res.status, `Serper rejected the key (HTTP ${res.status})`);
      const msg = /"message"\s*:\s*"([^"]{1,120})"/.exec(body)?.[1];
      throw new Error(`Serper HTTP ${res.status}${msg ? `: ${msg}` : ''}`);
    }
    const json = (await res.json()) as { organic?: { title?: string; link?: string; snippet?: string }[]; credits?: number };
    const hits = (json.organic ?? [])
      .filter((o) => typeof o.link === 'string')
      .map((o) => ({ url: o.link as string, title: o.title ?? '', snippet: o.snippet ?? '' }));
    const credits = typeof json.credits === 'number' ? json.credits : num > 10 ? 2 : 1;
    return { hits, credits };
  }
}
