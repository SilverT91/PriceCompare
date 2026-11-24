// The search: every in-scope shop in parallel, each ending with an explicit status, results
// streamed as they arrive. Uses only web-standard APIs plus the injected cache/fetch.

import { chooseCategories, shopIsRelevant, type CategoryChoice } from './categories.ts';
import { groupOffers } from './group.ts';
import { HostScheduler, ShopSession, type FetchLike } from './http.ts';
import { extractListCandidates, extractOffers } from './jsonld.ts';
import { extractLinkCandidates } from './links.ts';
import { matchTitle, parseQuery, scoreCandidate, type ParsedQuery } from './matcher.ts';
import { getRates } from './rates.ts';
import { ProviderChain, SiteSearchBatcher, type ProviderCall, type SearchProvider, type SiteSearchMode } from './search/provider.ts';
import { buildSearchUrl, heurekaUrl, sectionFor, type Location } from './shops.ts';
import { computeTotals, type Rates } from './totals.ts';
import {
  CACHE_TTL, type Cache, type Candidate, type Offer, type ProductGroup, type RawOffer, type Shop, type ShopResult, type ShopStatus,
} from './types.ts';

export const MAX_PRODUCT_PAGES = 3;

export interface SearchOptions {
  shops: Shop[];
  cache: Cache;
  scheduler: HostScheduler;
  location: Location;
  /** Web search providers in order of preference (fallback on exhausted credit / rejected key). */
  providers: SearchProvider[];
  fetch?: FetchLike;
  siteSearchMode?: SiteSearchMode;
  domainsPerQuery?: number;
  /** "auto" (default: guessed from the query), "all", or a category group id. */
  category?: string;
  onProviderCall?: (c: ProviderCall) => void;
}

export interface ShopInfo {
  id: string;
  name: string;
  domain: string;
  section: 'local' | 'online';
  branchKnown: Shop['has_kosice_branch'];
}

export type SearchEvent =
  | { type: 'start'; query: string; location: string; shops: ShopInfo[]; heurekaUrl: string; providers: string[]; categories: CategoryChoice }
  | { type: 'rates'; rates: Rates | null; error?: string }
  | { type: 'shop'; result: ShopResult }
  | { type: 'products'; groups: ProductGroup[] }
  | { type: 'done'; summary: SearchSummary };

export interface SearchSummary {
  query: string;
  ms: number;
  statusCounts: Partial<Record<ShopStatus, number>>;
  offers: number;
  groups: number;
  /** New web search API calls made by this search (cache hits not counted). */
  providerCalls: ProviderCall[];
  shopsAsked: number;
  /** HTTP requests to shops (robots.txt and redirects included; cache hits not counted). */
  shopRequests: number;
  /** Web search queries this search needed, whether answered from the cache or by the API. */
  siteQueries: number;
  categories: CategoryChoice;
}

interface CachedPage {
  offers: RawOffer[];
  productNodes: number;
  status: number | null;
  finalUrl: string;
}

interface CachedCandidates {
  route: ShopResult['route'];
  candidates: Candidate[];
}

const normQuery = (q: string) => q.trim().replace(/\s+/g, ' ').toLowerCase();

export async function* runSearch(query: string, opts: SearchOptions): AsyncGenerator<SearchEvent> {
  const t0 = Date.now();
  const inScope = opts.shops.filter((s) => s.in_scope);
  const choice = chooseCategories(query, opts.category);
  const shops = inScope.filter((s) => shopIsRelevant(s, choice.categories));
  const skipped = inScope.filter((s) => !shopIsRelevant(s, choice.categories));
  const pq = parseQuery(query);
  yield {
    type: 'start', query, location: opts.location.id, heurekaUrl: heurekaUrl(query), providers: opts.providers.map((p) => p.id),
    categories: choice,
    shops: inScope.map((s) => ({ id: s.id, name: s.name, domain: s.domain, section: sectionFor(s, opts.location), branchKnown: s[opts.location.branchField] })),
  };
  const notRelevant: ShopResult[] = skipped.map((s) => ({
    shopId: s.id, shopName: s.name, domain: s.domain, section: sectionFor(s, opts.location), status: 'not_relevant',
    detail: `not asked: its categories (${s.categories.join(', ')}) do not fit ${choice.label}`, route: 'none',
    manualUrl: s.search_url_template ? buildSearchUrl(s.search_url_template, query) : null,
    offers: [], candidates: [], requestsUsed: 0, fromCache: true, ms: 0,
  }));
  for (const r of notRelevant) yield { type: 'shop', result: r };

  const currencies = [...new Set(opts.shops.map((s) => s.currency))];
  const ratesP = getRates(currencies, opts.cache, opts.fetch);

  const batcher = opts.providers.length
    ? new SiteSearchBatcher({
      chain: new ProviderChain(opts.providers, opts.cache, { fetch: opts.fetch, onCall: opts.onProviderCall }),
      query, expected: shops.length, mode: opts.siteSearchMode ?? 'combined', domainsPerQuery: opts.domainsPerQuery ?? 6, deadlineMs: 8000,
    })
    : null;

  const queue: SearchEvent[] = [];
  let wake: (() => void) | null = null;
  const push = (e: SearchEvent) => {
    queue.push(e);
    wake?.();
  };

  const results: ShopResult[] = [];
  let remaining = shops.length + 1;
  void ratesP.then((r) => {
    remaining--;
    push({ type: 'rates', rates: r.rates, error: r.error });
  });
  for (const shop of shops) {
    searchShop(shop, pq, opts, batcher, ratesP.then((r) => r.rates))
      .catch((e): ShopResult => ({
        shopId: shop.id, shopName: shop.name, domain: shop.domain, section: sectionFor(shop, opts.location), status: 'error',
        detail: `internal error: ${e instanceof Error ? e.message : String(e)}`, route: 'none',
        manualUrl: shop.search_url_template ? buildSearchUrl(shop.search_url_template, query) : null,
        offers: [], candidates: [], requestsUsed: 0, fromCache: false, ms: 0,
      }))
      .then((r) => {
        results.push(r);
        remaining--;
        push({ type: 'shop', result: r });
        push({ type: 'products', groups: groupOffers(results.flatMap((x) => x.offers)) });
      });
  }
  while (remaining > 0 || queue.length) {
    if (!queue.length) await new Promise<void>((r) => (wake = r));
    wake = null;
    while (queue.length) yield queue.shift() as SearchEvent;
  }
  const statusCounts: Partial<Record<ShopStatus, number>> = {};
  for (const r of [...notRelevant, ...results]) statusCounts[r.status] = (statusCounts[r.status] ?? 0) + 1;
  const allOffers = results.flatMap((r) => r.offers);
  yield {
    type: 'done',
    summary: {
      query, ms: Date.now() - t0, statusCounts, offers: allOffers.length, groups: groupOffers(allOffers).length,
      providerCalls: batcher?.calls ?? [],
      shopsAsked: shops.length,
      shopRequests: results.reduce((a, r) => a + r.requestsUsed, 0),
      siteQueries: batcher?.queriesNeeded ?? 0,
      categories: choice,
    },
  };
}

function rankCandidates(pq: ParsedQuery, cands: Candidate[]): Candidate[] {
  const rank = { exact: 0, possible: 1, different: 2 } as const;
  return cands
    .map((c) => ({ ...c, ...scoreCandidate(pq, c.title, c.url) }))
    .sort((a, b) => rank[a.level] - rank[b.level] || (b.score ?? 0) - (a.score ?? 0));
}

async function searchShop(shop: Shop, pq: ParsedQuery, opts: SearchOptions, batcher: SiteSearchBatcher | null, ratesP: Promise<Rates | null>): Promise<ShopResult> {
  const t0 = Date.now();
  const query = pq.raw;
  const section = sectionFor(shop, opts.location);
  const manualUrl = shop.search_url_template ? buildSearchUrl(shop.search_url_template, query) : null;
  const base = { shopId: shop.id, shopName: shop.name, domain: shop.domain, section, manualUrl };
  const session = new ShopSession(shop.domain, { scheduler: opts.scheduler, cache: opts.cache, fetch: opts.fetch, acceptLanguage: shop.accept_language });
  let declined = false;
  const decline = () => {
    if (!declined && batcher) batcher.decline();
    declined = true;
  };
  const finish = (status: ShopStatus, detail: string, extra: Partial<ShopResult> = {}): ShopResult => {
    decline();
    return {
      ...base, status, detail, route: 'none', offers: [], candidates: [], requestsUsed: session.used,
      fromCache: session.used === 0, ms: Date.now() - t0, ...extra,
    };
  };
  const markBlocked = async (vendor: string) => {
    await opts.cache.set('blocked', shop.id, { at: new Date().toISOString(), vendor }, CACHE_TTL.blocked);
  };

  if (shop.needs_js) return finish('needs_js', 'prices on this shop only appear after JavaScript runs; not fetched (open the manual link)');
  if (shop.structured_data === false) return finish('no_route', 'product pages carry no schema.org data; not fetched (open the manual link)');
  if (shop.unreachable) return finish('no_route', `not asked: ${shop.no_route_reason ?? 'the site answers a plain client with errors'}`);
  const blocked = await opts.cache.get<{ at: string; vendor: string }>('blocked', shop.id);
  if (blocked) return finish('blocked', `bot protection (${blocked.vendor}) at ${blocked.at}; skipped for an hour`);

  // ---- 1. candidates -------------------------------------------------------------------------
  const candKey = `${shop.id}|${normQuery(query)}|${opts.providers.map((p) => p.id).join(',') || 'none'}|${opts.siteSearchMode ?? 'combined'}`;
  let cached = await opts.cache.get<CachedCandidates>('candidates', candKey);
  let route: ShopResult['route'] = cached?.route ?? 'none';
  let candidates: Candidate[] = cached?.candidates ?? [];
  const notes: string[] = [];

  if (!cached) {
    let searchAllowed = false;
    if (manualUrl) {
      const perm = await session.allowed(manualUrl);
      if (perm.blocked) {
        await markBlocked(perm.blocked);
        return finish('blocked', `bot protection (${perm.blocked}) on robots.txt; skipped for an hour`);
      }
      if (perm.budgetExhausted) return finish('error', 'request budget exhausted while reading robots.txt');
      searchAllowed = perm.allowed;
      if (!perm.allowed) notes.push(`robots.txt disallows the shop's search page${perm.note ? ` (${perm.note})` : ''}`);
    }
    if (manualUrl && searchAllowed) {
      decline();
      route = 'shop_search';
      const page = await session.get(manualUrl, 'search');
      if (page.blocked) {
        await markBlocked(page.blocked);
        return finish('blocked', `bot protection (${page.blocked}) on the search page; skipped for an hour`, { route });
      }
      if (page.robotsDisallowed) return finish('robots_disallowed', `search redirected to ${page.robotsDisallowed}, which robots.txt disallows`, { route });
      if (page.offsiteRedirect) return finish('error', `search redirected off-site to ${page.offsiteRedirect}`, { route });
      if (!page.ok) {
        const why = page.error ?? `HTTP ${page.status}`;
        const hint = page.status === 404 && shop.search_template_basis === 'guess' ? ' (the search URL template is a guess and may be wrong)' : '';
        return finish('error', `search page failed: ${why}${hint}`, { route });
      }
      const fromList = extractListCandidates(page.text, page.finalUrl);
      candidates = fromList.length ? fromList : extractLinkCandidates(page.text, page.finalUrl, query, shop.link_exclude_regex);
      if (!fromList.length) notes.push('no JSON-LD ItemList on the search page; candidates from links');
    } else if (batcher) {
      route = 'search_provider';
      declined = true;
      const r = await batcher.find(shop.domain, shop.country);
      const why = notes.length ? `${notes.join('; ')}; ` : '';
      if (r.unavailable) return finish('needs_search_key', `${why}no usable web search provider: ${r.unavailable}`, { route });
      if (r.error) return finish('error', `web search failed: ${r.error}`, { route });
      candidates = r.hits.map((h) => ({ url: h.url, title: h.title, from: 'search_provider' as const }));
      notes.push(`found via ${r.provider} web search`);
    } else if (manualUrl) {
      return finish('needs_search_key', `${notes.join('; ')}; set SERPER_API_KEY or BRAVE_API_KEY to find product pages through a web search`);
    } else {
      return finish('no_route', `${shop.no_route_reason ?? 'no search URL known for this shop'}; a web search key (BRAVE_API_KEY or SERPER_API_KEY) would let the app search it`);
    }
    await opts.cache.set('candidates', candKey, { route, candidates } satisfies CachedCandidates, CACHE_TTL.candidates);
  } else {
    decline();
    notes.push('candidates from cache');
  }

  const ranked = rankCandidates(pq, candidates);
  const picks = ranked.filter((c) => c.level !== 'different').slice(0, MAX_PRODUCT_PAGES);
  const shownCandidates = ranked.slice(0, 10);
  if (!candidates.length) {
    return finish('no_match', route === 'search_provider' ? 'the web search returned no pages on this domain' : 'the shop search returned no products', { route, candidates: shownCandidates });
  }
  if (!picks.length) {
    return finish('no_match', `${candidates.length} result(s), none matching the query (best: "${(ranked[0]?.title || ranked[0]?.url || '').slice(0, 80)}")`, { route, candidates: shownCandidates });
  }

  // ---- 2. product pages ----------------------------------------------------------------------
  const raw: RawOffer[] = [];
  let pagesWithoutData = 0;
  let pagesFetched = 0;
  let robotsBlockedPages = 0;
  let budgetHit = false;
  for (const c of picks) {
    const hit = await opts.cache.get<CachedPage>('offers', c.url);
    if (hit && (hit.status === 404 || hit.status === 410)) {
      notes.push(`${c.url}: HTTP ${hit.status} (cached)`);
      continue;
    }
    if (hit) {
      raw.push(...hit.offers);
      pagesFetched++;
      if (!hit.productNodes) pagesWithoutData++;
      continue;
    }
    if (session.remaining() <= 0) {
      budgetHit = true;
      break;
    }
    const page = await session.get(c.url, 'product');
    if (page.blocked) {
      await markBlocked(page.blocked);
      if (!raw.length) return finish('blocked', `bot protection (${page.blocked}) on a product page; skipped for an hour`, { route, candidates: shownCandidates });
      notes.push(`bot protection on ${c.url}`);
      break;
    }
    if (page.robotsDisallowed) {
      robotsBlockedPages++;
      continue;
    }
    if (page.budgetExhausted) {
      budgetHit = true;
      break;
    }
    if (!page.ok) {
      notes.push(`${c.url}: ${page.error ?? `HTTP ${page.status}`}`);
      // A page that is gone (404/410) is remembered like any extraction, so it is not asked again for 6 h.
      if (page.status === 404 || page.status === 410) {
        await opts.cache.set('offers', c.url, { offers: [], productNodes: 0, status: page.status, finalUrl: page.finalUrl } satisfies CachedPage, CACHE_TTL.offers);
      }
      continue;
    }
    pagesFetched++;
    const ex = extractOffers(page.text, page.finalUrl, shop.id);
    if (!ex.productNodes) pagesWithoutData++;
    raw.push(...ex.offers);
    await opts.cache.set('offers', c.url, { offers: ex.offers, productNodes: ex.productNodes, status: page.status, finalUrl: page.finalUrl } satisfies CachedPage, CACHE_TTL.offers);
  }
  if (budgetHit) notes.push('request budget (6 per shop) reached');

  // ---- 3. match + totals ---------------------------------------------------------------------
  const rates = await ratesP;
  const seen = new Set<string>();
  const offers: Offer[] = [];
  const unpriced = raw.filter((r) => !(r.price > 0)).length;
  if (unpriced) notes.push(`${unpriced} offer(s) listed with price 0 (sold out?) ignored`);
  for (const r of raw) {
    if (!(r.price > 0)) continue;
    const k =`${r.url}|${r.title}|${r.price}|${r.seller}|${r.gtin}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const match = matchTitle(pq, { title: r.title, brand: r.brand, sku: r.sku, mpn: r.mpn, color: r.color, itemCondition: r.itemCondition, url: r.url, shopName: shop.name });
    offers.push({
      ...r, shopName: shop.name, section, shipsToSk: shop.ships_to_sk, branchKnown: shop[opts.location.branchField],
      match, totals: computeTotals(r, shop, rates, opts.location.country, { local: section === 'local' }),
    });
  }
  const matching = offers.filter((o) => o.match.level !== 'different');
  const common = { route, offers, candidates: shownCandidates, requestsUsed: session.used, fromCache: session.used === 0 };
  const detailTail = notes.length ? ` (${notes.join('; ')})` : '';
  if (matching.length) {
    const ex = matching.filter((o) => o.match.level === 'exact').length;
    return finish('ok', `${matching.length} matching offer(s): ${ex} exact, ${matching.length - ex} possible${detailTail}`, common);
  }
  if (pagesFetched && pagesWithoutData === pagesFetched) {
    return finish('needs_js', `fetched ${pagesFetched} page(s) without schema.org Product data; prices are probably rendered by JavaScript${detailTail}`, common);
  }
  if (robotsBlockedPages && !pagesFetched) return finish('robots_disallowed', `robots.txt disallows the candidate product pages${detailTail}`, common);
  if (!pagesFetched) return finish('error', `no product page could be read${detailTail}`, common);
  return finish('no_match', `${offers.length} offer(s) on ${pagesFetched} page(s), none matching the query${detailTail}`, common);
}
