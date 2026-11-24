// Web search providers, used to find product pages at shops whose own search page is disallowed by
// robots.txt (or that have no search template). Few queries: several `site:` domains go into one
// query, grouped by shop country so the country/language parameters fit every domain in it.
// Providers are tried in a configurable order; one that reports exhausted credits or a rejected key
// is marked unusable (persisted in the cache) and the next one is used. If none is usable, the
// affected shops get status needs_search_key with the reason.

import type { FetchLike } from '../http.ts';
import { CACHE_TTL, type Cache } from '../types.ts';

export interface SearchHit {
  url: string;
  title: string;
  snippet: string;
}

export interface Locale {
  /** ISO 3166 alpha-2, lowercase: sk, cz, de, at, pl */
  country: string;
  /** ISO 639-1: sk, cs, de, pl */
  lang: string;
}

export interface ProviderCall {
  provider: string;
  query: string;
  locale: Locale;
  results: number;
  credits: number;
  ok: boolean;
  error?: string;
}

/** Thrown by an adapter when the provider cannot be used until something changes (credits, key). */
export class ProviderUnavailableError extends Error {
  readonly kind: 'quota' | 'auth';
  readonly status: number;
  constructor(kind: 'quota' | 'auth', status: number, message: string) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

export interface SearchProvider {
  readonly id: string;
  /** Results requested per query; also decides the credit cost. */
  readonly resultsPerQuery: number;
  /** Minimum gap between two calls (provider rate limit). */
  readonly minIntervalMs: number;
  search(q: string, locale: Locale, fetchImpl?: FetchLike): Promise<{ hits: SearchHit[]; credits: number }>;
  /** How long an exhaustion mark lasts (Brave credit renews monthly, Serper's free credit is one-time). */
  exhaustedTtlSeconds(kind: 'quota' | 'auth'): number;
}

export const LOCALE_BY_COUNTRY: Record<string, Locale> = {
  SK: { country: 'sk', lang: 'sk' },
  CZ: { country: 'cz', lang: 'cs' },
  DE: { country: 'de', lang: 'de' },
  AT: { country: 'at', lang: 'de' },
  PL: { country: 'pl', lang: 'pl' },
};

export function localeFor(shopCountry: string): Locale {
  return LOCALE_BY_COUNTRY[shopCountry.toUpperCase()] ?? { country: 'sk', lang: 'sk' };
}

export function siteQuery(query: string, domains: string[]): string {
  return `${query} ${domains.map((d) => `site:${d}`).join(' OR ')}`;
}

export type SiteSearchMode = 'combined' | 'per_shop';

export interface ExhaustedMark {
  kind: 'quota' | 'auth';
  status: number;
  message: string;
  at: string;
}

/** Ordered providers with fallback and per-provider pacing. */
export class ProviderChain {
  readonly providers: SearchProvider[];
  private readonly cache: Cache;
  private readonly fetchImpl: FetchLike | undefined;
  private readonly onCall: ((c: ProviderCall) => void) | undefined;
  /** Per process, shared by all searches, so concurrent searches keep the provider's rate limit. */
  private static nextSlot = new Map<string, number>();
  readonly calls: ProviderCall[] = [];
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(providers: SearchProvider[], cache: Cache, opts: { fetch?: FetchLike; onCall?: (c: ProviderCall) => void; sleep?: (ms: number) => Promise<void> } = {}) {
    this.providers = providers;
    this.cache = cache;
    this.fetchImpl = opts.fetch;
    this.onCall = opts.onCall;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  get ids(): string[] {
    return this.providers.map((p) => p.id);
  }

  async exhausted(p: SearchProvider): Promise<ExhaustedMark | undefined> {
    return this.cache.get<ExhaustedMark>('provider_exhausted', p.id);
  }

  private async pace(p: SearchProvider) {
    const now = Date.now();
    const slot = Math.max(now, ProviderChain.nextSlot.get(p.id) ?? 0);
    ProviderChain.nextSlot.set(p.id, slot + p.minIntervalMs);
    if (slot > now) await this.sleep(slot - now);
  }

  /**
   * Results for one site-restricted query: from the cache of the first provider that has it, else
   * from the first usable provider. `unavailable` is set when no provider could be used.
   */
  /** Cached results only (first provider in order that has them); never calls an API. */
  async cached(q: string, locale: Locale): Promise<{ hits: SearchHit[]; provider: string } | undefined> {
    for (const p of this.providers) {
      const hit = await this.cache.get<SearchHit[]>('provider', cacheKey(p, locale, q));
      if (hit) return { hits: hit, provider: p.id };
    }
    return undefined;
  }

  async search(q: string, locale: Locale): Promise<{ hits: SearchHit[]; provider?: string; error?: string; unavailable?: string }> {
    const cached = await this.cached(q, locale);
    if (cached) return cached;
    const reasons: string[] = [];
    let lastError: string | undefined;
    for (const p of this.providers) {
      const mark = await this.exhausted(p);
      if (mark) {
        reasons.push(`${p.id}: ${mark.message} (since ${mark.at})`);
        continue;
      }
      await this.pace(p);
      try {
        const r = await p.search(q, locale, this.fetchImpl);
        await this.cache.set('provider', cacheKey(p, locale, q), r.hits, CACHE_TTL.providerResults);
        this.record({ provider: p.id, query: q, locale, results: r.hits.length, credits: r.credits, ok: true });
        return { hits: r.hits, provider: p.id };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.record({ provider: p.id, query: q, locale, results: 0, credits: 0, ok: false, error: msg });
        if (e instanceof ProviderUnavailableError) {
          const m: ExhaustedMark = { kind: e.kind, status: e.status, message: msg, at: new Date().toISOString() };
          await this.cache.set('provider_exhausted', p.id, m, p.exhaustedTtlSeconds(e.kind));
          reasons.push(`${p.id}: ${msg}`);
          continue;
        }
        // Transient failure (429, network): try the next provider for this query, no retry.
        lastError = `${p.id}: ${msg}`;
      }
    }
    if (lastError) return { hits: [], error: lastError };
    return { hits: [], unavailable: reasons.length ? reasons.join('; ') : 'no search provider configured' };
  }

  private record(c: ProviderCall) {
    this.calls.push(c);
    this.onCall?.(c);
  }
}

function cacheKey(p: SearchProvider, locale: Locale, q: string): string {
  return `${p.id}|${p.resultsPerQuery}|${locale.country}|${locale.lang}|${q}`;
}

export interface BatcherOptions {
  chain: ProviderChain;
  query: string;
  expected: number;
  mode: SiteSearchMode;
  domainsPerQuery: number;
  deadlineMs: number;
}

export interface SiteSearchResult {
  hits: SearchHit[];
  provider?: string;
  query?: string;
  error?: string;
  unavailable?: string;
}

/**
 * Batches domain-restricted searches for one user query. Each shop calls `find(domain, country)`
 * or `decline()`; when every expected shop has decided (or a short deadline passes) the batcher
 * sends one query per (country, chunk of domains) and hands each shop the hits on its domain.
 */
export class SiteSearchBatcher {
  private pending: { domain: string; country: string; resolve: (r: SiteSearchResult) => void }[] = [];
  private decided = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly opts: BatcherOptions;
  /** Queries this search needed (answered from the cache or by the API). */
  queriesNeeded = 0;

  constructor(opts: BatcherOptions) {
    this.opts = opts;
  }

  get calls(): ProviderCall[] {
    return this.opts.chain.calls;
  }

  /** A shop that will not use the provider route. */
  decline(): void {
    this.decided++;
    this.maybeFlush();
  }

  find(domain: string, country: string): Promise<SiteSearchResult> {
    this.decided++;
    const p = new Promise<SiteSearchResult>((resolve) => this.pending.push({ domain, country, resolve }));
    if (!this.timer) this.timer = setTimeout(() => void this.flush(), this.opts.deadlineMs);
    this.maybeFlush();
    return p;
  }

  private maybeFlush() {
    if (this.decided >= this.opts.expected && this.pending.length) void this.flush();
  }

  private async flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const batch = this.pending;
    this.pending = [];
    if (!batch.length) return;
    const byCountry = new Map<string, typeof batch>();
    // Sorted, so the same shops always give the same query strings (and hit the cache).
    for (const b of [...batch].sort((x, y) => x.domain.localeCompare(y.domain))) byCountry.set(b.country, [...(byCountry.get(b.country) ?? []), b]);
    const size = this.opts.mode === 'per_shop' ? 1 : Math.max(1, this.opts.domainsPerQuery);
    const jobs: Promise<void>[] = [];
    for (const [country, items] of byCountry) {
      for (let i = 0; i < items.length; i += size) jobs.push(this.run(country, items.slice(i, i + size)));
    }
    await Promise.all(jobs);
  }

  private async run(country: string, chunk: SiteSearchBatcher['pending']) {
    const locale = localeFor(country);
    this.queriesNeeded++;
    const q = siteQuery(this.opts.query, chunk.map((c) => c.domain));
    let r: Awaited<ReturnType<ProviderChain['search']>> | undefined = await this.opts.chain.cached(q, locale);
    if (!r && chunk.length > 1) {
      // No cached combined result: if every domain has a cached single-domain result, use those.
      const parts = await Promise.all(chunk.map((c) => this.opts.chain.cached(siteQuery(this.opts.query, [c.domain]), locale)));
      if (parts.every(Boolean)) r = { hits: parts.flatMap((p) => p?.hits ?? []), provider: parts[0]?.provider };
    }
    r = r ?? (await this.opts.chain.search(q, locale));
    for (const c of chunk) {
      const mine = r.hits.filter((h) => {
        try {
          const host = new URL(h.url).hostname.toLowerCase();
          return host === c.domain || host.endsWith(`.${c.domain}`);
        } catch {
          return false;
        }
      });
      c.resolve({ hits: mine, provider: r.provider, query: q, error: r.error, unavailable: r.unavailable });
    }
  }
}
