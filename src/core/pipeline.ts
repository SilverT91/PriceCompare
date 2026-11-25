// The search: every in-scope shop in parallel, each ending with an explicit status, results
// streamed as they arrive. Uses only web-standard APIs plus the injected cache/fetch.

import { chooseCategories, shopIsRelevant, type CategoryChoice } from './categories.ts';
import { groupOffers } from './group.ts';
import { HostScheduler, MAX_REQUESTS_PER_SHOP, ShopSession, type FetchLike } from './http.ts';
import { extractListCandidates, extractOffers, offerUrl } from './jsonld.ts';
import { extractLinkCandidates, pageKey, stripTrackingParams } from './links.ts';
import { matchTitle, parseQuery, scoreCandidate, type ParsedQuery } from './matcher.ts';
import { nearbyModels } from './nearby.ts';
import { getRates } from './rates.ts';
import {
  ProviderChain, SiteSearchBatcher, type ProviderCall, type SearchHit, type SearchProvider, type SiteSearchMode, type SiteSearchResult,
} from './search/provider.ts';
import { buildSearchUrl, heurekaUrl, sectionFor, type Location } from './shops.ts';
import { computeTotals, type Rates } from './totals.ts';
import {
  CACHE_TTL, type Cache, type Candidate, type NearbyList, type NearbyShop, type Offer, type ProductGroup, type RawOffer, type SeenPrice, type Shop,
  type ShopResult, type ShopStatus,
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
  /** How long the second-route batch waits for more shops after the first one asks (default 15 s). */
  fallbackDeadlineMs?: number;
}

/** One shop's single chance to join the second-route (fallback) web search batch. */
interface FallbackSlot {
  find(domain: string, country: string): Promise<SiteSearchResult>;
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
  /** groups: the distinct products so far; nearby: similar models the shops list (nearby.ts). */
  | { type: 'products'; groups: ProductGroup[]; nearby: NearbyList }
  | { type: 'done'; summary: SearchSummary };

export interface SearchSummary {
  query: string;
  ms: number;
  statusCounts: Partial<Record<ShopStatus, number>>;
  offers: number;
  groups: number;
  /** Similar models the shops list (all of them, before the cut to the list shown). */
  nearby: number;
  /** Similar models that got a price from a page read after the search for that (priceNearbyModels). */
  nearbyPrices: number;
  /** New web search API calls made by this search (cache hits not counted). */
  providerCalls: ProviderCall[];
  shopsAsked: number;
  /** HTTP requests to shops (robots.txt and redirects included, price reads for similar models too; cache hits not counted). */
  shopRequests: number;
  /** Web search queries this search needed, whether answered from the cache or by the API. */
  siteQueries: number;
  /** The part of siteQueries sent for shops whose own search found nothing matching (second route). */
  fallbackQueries: number;
  /** Shops that tried the web search after their own search found nothing matching. */
  fallbackShops: number;
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

  const chain = opts.providers.length ? new ProviderChain(opts.providers, opts.cache, { fetch: opts.fetch, onCall: opts.onProviderCall }) : null;
  const batchOpts = { query, expected: shops.length, mode: opts.siteSearchMode ?? 'combined', domainsPerQuery: opts.domainsPerQuery ?? 6 } as const;
  const batcher = chain ? new SiteSearchBatcher({ chain, ...batchOpts, deadlineMs: 8000 }) : null;
  // Second phase: shops whose own search found nothing matching try the web search too. Every shop
  // decides once (find or decline), so the fallback queries are batched across shops like the first ones.
  const fallback = chain ? new SiteSearchBatcher({ chain, ...batchOpts, deadlineMs: opts.fallbackDeadlineMs ?? 15_000 }) : null;

  const queue: SearchEvent[] = [];
  let wake: (() => void) | null = null;
  const push = (e: SearchEvent) => {
    queue.push(e);
    wake?.();
  };

  const results: ShopResult[] = [];
  // Each shop's session and read pages, kept for the price reads of similar models after the search.
  const contexts = new Map<string, ShopCtx>();
  let remaining = shops.length + 1;
  void ratesP.then((r) => {
    remaining--;
    push({ type: 'rates', rates: r.rates, error: r.error });
  });
  let fallbackShops = 0;
  for (const shop of shops) {
    let fallbackDecided = false;
    const slot: FallbackSlot | null = fallback
      ? {
        find: (domain, country) => {
          fallbackDecided = true;
          fallbackShops++;
          return fallback.find(domain, country);
        },
      }
      : null;
    searchShop(shop, pq, opts, batcher, slot, ratesP.then((r) => r.rates), contexts)
      .finally(() => {
        if (fallback && !fallbackDecided) fallback.decline();
      })
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
        push({ type: 'products', groups: groupOffers(results.flatMap((x) => x.offers)), nearby: nearbyModels(pq, results) });
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
  const groups = groupOffers(allOffers);
  const nearby = nearbyModels(pq, results);
  // No exact match: a price for the first similar models, then the list once more with it.
  const priced = !groups.some((g) => g.level === 'exact') && nearby.models.length
    ? await priceNearbyModels(nearby, results, contexts)
    : { list: nearby, prices: 0, requests: 0 };
  if (priced.prices) yield { type: 'products', groups, nearby: priced.list };
  yield {
    type: 'done',
    summary: {
      query, ms: Date.now() - t0, statusCounts, offers: allOffers.length, groups: groups.length,
      nearby: nearby.total,
      nearbyPrices: priced.prices,
      providerCalls: chain?.calls ?? [],
      shopsAsked: shops.length,
      shopRequests: results.reduce((a, r) => a + r.requestsUsed, 0) + priced.requests,
      siteQueries: (batcher?.queriesNeeded ?? 0) + (fallback?.queriesNeeded ?? 0),
      fallbackQueries: fallback?.queriesNeeded ?? 0,
      fallbackShops,
      categories: choice,
    },
  };
}

/** How many models of the similar-models list get a price read after the search. */
export const NEARBY_PRICE_READS = 3;
/** A shop with one of these results is not asked again in the same search. */
const NO_PRICE_READ: ShopStatus[] = ['blocked', 'robots_disallowed', 'error', 'needs_js', 'not_relevant'];
const LEVEL_RANK = { exact: 0, possible: 1, different: 2 } as const;

/**
 * Prices for the similar-models list, when no product matches exactly. For each of the first
 * NEARBY_PRICE_READS models without a seen price, one listing is read: a shop with a branch in the
 * city first, then one that delivers to Slovakia, then any other, preferring a shop not asked yet
 * for another model. A shop is never asked when its result was blocked, robots-disallowed, an error
 * or needs_js, and never past its request budget (checked again when the read starts, since a shop
 * asked twice reads in sequence). A page that gives no usable price is not followed by another one.
 * The read offers stay out of the shop results: they would add products to "Which one do you mean?"
 * and change the offer counts. Returns the list with the prices, how many were found and the requests made.
 */
async function priceNearbyModels(
  list: NearbyList, results: ShopResult[], contexts: Map<string, ShopCtx>,
): Promise<{ list: NearbyList; prices: number; requests: number }> {
  const status = new Map(results.map((r) => [r.shopId, r.status]));
  const reach = (s: NearbyShop) => (s.section === 'local' ? 0 : contexts.get(s.shopId)?.shop.ships_to_sk === true ? 1 : 2);
  const usable = (s: NearbyShop) => {
    const ctx = contexts.get(s.shopId);
    const st = status.get(s.shopId);
    return Boolean(ctx && st && !NO_PRICE_READ.includes(st) && ctx.session.remaining() > 0 && !ctx.read.has(pageKey(s.url)));
  };
  const asked = new Set<string>();
  const jobs: { index: number; name: string; ctx: ShopCtx; url: string }[] = [];
  const todo = list.models.map((m, index) => ({ m, index })).filter(({ m }) => !m.seenPrice).slice(0, NEARBY_PRICE_READS);
  for (const { m, index } of todo) {
    const candidates = [...m.shops].sort((a, b) => reach(a) - reach(b)).filter(usable);
    // A shop not asked yet for another model first; otherwise one already asked, if its budget allows at the time of the read.
    const pick = candidates.find((s) => !asked.has(s.shopId)) ?? candidates[0];
    if (!pick) continue;
    asked.add(pick.shopId);
    jobs.push({ index, name: m.query, ctx: contexts.get(pick.shopId) as ShopCtx, url: pick.url });
  }
  const shopsAsked = new Set(jobs.map((j) => j.ctx));
  const usedBefore = [...shopsAsked].reduce((a, ctx) => a + ctx.session.used, 0);
  // Reads for one shop run one after another through its session; different shops run side by side.
  const queue = new Map<ShopCtx, Promise<unknown>>();
  const prices = await Promise.all(jobs.map((j) => {
    const run = (queue.get(j.ctx) ?? Promise.resolve()).then(() => readModelPrice(j.ctx, j.name, j.url)).catch(() => null);
    queue.set(j.ctx, run);
    return run;
  }));
  const requests = [...shopsAsked].reduce((a, ctx) => a + ctx.session.used, 0) - usedBefore;
  const models = list.models.map((m, i) => {
    const k = jobs.findIndex((j) => j.index === i);
    return k >= 0 && prices[k] ? { ...m, seenPrice: prices[k] } : m;
  });
  return { list: { ...list, models }, prices: prices.filter(Boolean).length, requests };
}

/**
 * The price of a similar model from one of its pages: the page's offers as usual, matched against
 * the model's own name. The best match (exact before possible, then the score), the lowest item
 * price among equals. An offer the name rates "different", a used one or one without a EUR price gives none.
 */
async function readModelPrice(ctx: ShopCtx, name: string, url: string): Promise<SeenPrice | null> {
  const page = await readPage(ctx, url);
  if (page.kind !== 'offers') return null;
  const fits = (await toOffers(ctx, page.offers, parseQuery(name)))
    .filter((o) => o.match.level !== 'different' && o.match.condition === 'new' && o.totals.itemEur !== null)
    .sort((a, b) => LEVEL_RANK[a.match.level] - LEVEL_RANK[b.match.level] || b.match.score - a.match.score
      || (a.totals.itemEur as number) - (b.totals.itemEur as number));
  const best = fits[0];
  return best ? { eur: best.totals.itemEur as number, shopName: ctx.shop.name, url: best.url, from: 'list' } : null;
}

function rankCandidates(pq: ParsedQuery, cands: Candidate[]): Candidate[] {
  const rank = { exact: 0, possible: 1, different: 2 } as const;
  return cands
    .map((c) => ({ ...c, ...scoreCandidate(pq, c.title, c.url) }))
    .sort((a, b) => rank[a.level] - rank[b.level] || (b.score ?? 0) - (a.score ?? 0));
}

/** Web search hits on the shop's domain as candidates: tracking parameters removed, duplicates dropped. */
function providerCandidates(hits: SearchHit[]): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const h of hits) {
    const url = stripTrackingParams(h.url);
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ url, title: h.title, from: 'search_provider' });
  }
  return out;
}

/** Everything one shop's search shares across its routes: one session, so one request budget. */
interface ShopCtx {
  shop: Shop;
  pq: ParsedQuery;
  opts: SearchOptions;
  session: ShopSession;
  section: ShopResult['section'];
  ratesP: Promise<Rates | null>;
  markBlocked: (vendor: string) => Promise<void>;
  /** Product URLs already read (fetched or from the cache) in this search; never read twice. */
  read: Set<string>;
  structuredSeen?: boolean;
}

/** What reading one route's candidates gave. */
interface RouteOutcome {
  status: ShopStatus;
  detail: string;
  offers: Offer[];
  candidates: Candidate[];
}

/** A page of this shop had schema.org Product data: remembered, so later pages without it are not taken for JavaScript pages. */
async function rememberStructuredData(ctx: ShopCtx): Promise<void> {
  if (ctx.structuredSeen) return;
  ctx.structuredSeen = true;
  await ctx.opts.cache.set('structured_data', ctx.shop.id, { at: new Date().toISOString() }, CACHE_TTL.structuredData);
}

const compatible = (a: string | null, b: string | null) => a === null || b === null || a === b;
const normTitle = (t: string) => t.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * One offer per product page and price. Datart's manual page (/navod/...) and a tracking-parameter
 * copy of a link both repeat the product page's offer, one of them without GTIN and seller. Offers
 * merge only when URL (without tracking parameters), title, price and currency are the same and
 * seller and GTIN do not contradict each other; the merged offer keeps the fields either one had.
 */
export function dedupeOffers(raw: RawOffer[]): RawOffer[] {
  const out: RawOffer[] = [];
  for (const r of raw) {
    const same = out.find((o) => pageKey(o.url) === pageKey(r.url) && normTitle(o.title) === normTitle(r.title) && o.price === r.price
      && o.currency === r.currency && compatible(o.seller, r.seller) && compatible(o.gtin, r.gtin));
    if (!same) {
      out.push({ ...r });
      continue;
    }
    for (const k of ['gtin', 'seller', 'brand', 'sku', 'mpn', 'color', 'availability', 'itemCondition'] as const) same[k] = same[k] ?? r[k];
    if (!same.shipping.length) same.shipping = r.shipping;
  }
  return out;
}

/** What reading one product page gave. */
type PageRead =
  | { kind: 'offers'; offers: RawOffer[]; productNodes: number }
  | { kind: 'failed'; note: string }
  | { kind: 'robots_disallowed' }
  | { kind: 'blocked'; vendor: string }
  /** requested: the budget ran out during the read (a robots.txt or redirect hop was asked first). */
  | { kind: 'budget'; requested: boolean };

/**
 * One product page, from the `offers` cache or through the shop's session (robots.txt on every hop,
 * the host gap, the request budget, bot-wall detection). The page is remembered as read; a bot wall
 * marks the shop blocked for an hour; what was extracted, or a 404/410, is cached by URL.
 */
async function readPage(ctx: ShopCtx, url: string): Promise<PageRead> {
  const { shop, opts, session } = ctx;
  const hit = await opts.cache.get<CachedPage>('offers', url);
  if (hit && (hit.status === 404 || hit.status === 410)) {
    ctx.read.add(pageKey(url));
    return { kind: 'failed', note: `${url}: HTTP ${hit.status} (cached)` };
  }
  if (hit) {
    ctx.read.add(pageKey(url));
    if (hit.productNodes) await rememberStructuredData(ctx);
    // Entries cached before offerUrl existed may still hold a site-root URL.
    return { kind: 'offers', offers: hit.offers.map((o) => ({ ...o, url: offerUrl(o.url, hit.finalUrl) })), productNodes: hit.productNodes };
  }
  if (session.remaining() <= 0) return { kind: 'budget', requested: false };
  const page = await session.get(url, 'product');
  if (page.robotsDisallowed) return { kind: 'robots_disallowed' };
  ctx.read.add(pageKey(url));
  ctx.read.add(pageKey(page.finalUrl));
  if (page.blocked) {
    await ctx.markBlocked(page.blocked);
    return { kind: 'blocked', vendor: page.blocked };
  }
  if (page.budgetExhausted) return { kind: 'budget', requested: true };
  if (!page.ok) {
    // A page that is gone (404/410) is remembered like any extraction, so it is not asked again for 6 h.
    if (page.status === 404 || page.status === 410) {
      await opts.cache.set('offers', url, { offers: [], productNodes: 0, status: page.status, finalUrl: page.finalUrl } satisfies CachedPage, CACHE_TTL.offers);
    }
    return { kind: 'failed', note: `${url}: ${page.error ?? `HTTP ${page.status}`}` };
  }
  const ex = extractOffers(page.text, page.finalUrl, shop.id);
  if (ex.productNodes) await rememberStructuredData(ctx);
  await opts.cache.set('offers', url, { offers: ex.offers, productNodes: ex.productNodes, status: page.status, finalUrl: page.finalUrl } satisfies CachedPage, CACHE_TTL.offers);
  return { kind: 'offers', offers: ex.offers, productNodes: ex.productNodes };
}

/** Offers with a price, one per page and price, matched against the query and with their totals. */
async function toOffers(ctx: ShopCtx, raw: RawOffer[], pq: ParsedQuery): Promise<Offer[]> {
  const { shop, opts, section } = ctx;
  const rates = await ctx.ratesP;
  return dedupeOffers(raw.filter((x) => x.price > 0)).map((r) => ({
    ...r, shopName: shop.name, section, shipsToSk: shop.ships_to_sk, branchKnown: shop[opts.location.branchField],
    match: matchTitle(pq, { title: r.title, brand: r.brand, sku: r.sku, mpn: r.mpn, color: r.color, itemCondition: r.itemCondition, url: r.url, shopName: shop.name }),
    totals: computeTotals(r, shop, rates, opts.location.country, { local: section === 'local' }),
  }));
}

/** Steps 2 and 3 for one route: fetch the best candidate pages, extract offers, match them. */
async function readCandidates(ctx: ShopCtx, route: ShopResult['route'], candidates: Candidate[], notes: string[]): Promise<RouteOutcome> {
  const { shop, pq, opts } = ctx;
  const ranked = rankCandidates(pq, candidates);
  const shownCandidates = ranked.slice(0, 10);
  const none = (status: ShopStatus, detail: string): RouteOutcome => ({ status, detail, offers: [], candidates: shownCandidates });
  if (!candidates.length) {
    return none('no_match', route === 'search_provider' ? 'the web search returned no pages on this domain' : 'the shop search returned no products');
  }
  const matchingCands = ranked.filter((c) => c.level !== 'different');
  if (!matchingCands.length) {
    return none('no_match', `${candidates.length} result(s), none matching the query (best: "${(ranked[0]?.title || ranked[0]?.url || '').slice(0, 80)}")`);
  }

  // ---- 2. product pages ----------------------------------------------------------------------
  const raw: RawOffer[] = [];
  let pagesWithoutData = 0;
  let pagesFetched = 0;
  let robotsBlockedPages = 0;
  let alreadyRead = 0;
  let tried = 0;
  let budgetHit = false;
  for (const c of matchingCands) {
    if (tried >= MAX_PRODUCT_PAGES) break;
    if (ctx.read.has(pageKey(c.url))) {
      alreadyRead++;
      continue;
    }
    const page = await readPage(ctx, c.url);
    if (page.kind === 'robots_disallowed') {
      // Nothing was requested for it, so it does not take one of the page slots.
      robotsBlockedPages++;
      continue;
    }
    if (page.kind === 'budget') {
      if (page.requested) tried++;
      budgetHit = true;
      break;
    }
    tried++;
    if (page.kind === 'blocked') {
      if (!raw.length) return none('blocked', `bot protection (${page.vendor}) on a product page; skipped for an hour`);
      notes.push(`bot protection on ${c.url}`);
      break;
    }
    if (page.kind === 'failed') {
      notes.push(page.note);
      continue;
    }
    pagesFetched++;
    if (!page.productNodes) pagesWithoutData++;
    raw.push(...page.offers);
  }
  if (budgetHit) notes.push(`request budget (${MAX_REQUESTS_PER_SHOP} per shop) reached`);
  if (alreadyRead) notes.push(`${alreadyRead} page(s) already read in this search (same page under another link) not read again`);

  // ---- 3. match + totals ---------------------------------------------------------------------
  const unpriced = raw.filter((r) => !(r.price > 0)).length;
  if (unpriced) notes.push(`${unpriced} offer(s) listed with price 0 (sold out?) ignored`);
  const offers = await toOffers(ctx, raw, pq);
  const matching = offers.filter((o) => o.match.level !== 'different');
  const out = (status: ShopStatus, detail: string): RouteOutcome => ({ status, detail, offers, candidates: shownCandidates });
  if (matching.length) {
    const ex = matching.filter((o) => o.match.level === 'exact').length;
    return out('ok', `${matching.length} matching offer(s): ${ex} exact, ${matching.length - ex} possible`);
  }
  if (pagesFetched && pagesWithoutData === pagesFetched) {
    // A shop whose product pages are known to carry the data: these pages were something else
    // (articles, category pages), so nothing matching was found; that is no_match, not needs_js.
    if (shop.structured_data === true || (await opts.cache.get('structured_data', shop.id))) {
      return out('no_match', `fetched ${pagesFetched} page(s) without schema.org Product data; this shop's product pages carry it, so these were probably not product pages`);
    }
    return out('needs_js', `fetched ${pagesFetched} page(s) without schema.org Product data; prices are probably rendered by JavaScript`);
  }
  if (robotsBlockedPages && !pagesFetched) return out('robots_disallowed', 'robots.txt disallows the candidate product pages');
  if (!pagesFetched && !tried && alreadyRead) return out('no_match', 'the matching pages were already read in this search');
  if (!pagesFetched) return out('error', 'no product page could be read');
  return out('no_match', `${offers.length} offer(s) on ${pagesFetched} page(s), none matching the query`);
}

async function searchShop(
  shop: Shop, pq: ParsedQuery, opts: SearchOptions, batcher: SiteSearchBatcher | null, fallback: FallbackSlot | null, ratesP: Promise<Rates | null>,
  contexts: Map<string, ShopCtx>,
): Promise<ShopResult> {
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
  const ctx: ShopCtx = { shop, pq, opts, session, section, ratesP, markBlocked, read: new Set() };
  contexts.set(shop.id, ctx);
  const tail = (notes: string[]) => (notes.length ? ` (${notes.join('; ')})` : '');

  if (shop.needs_js) return finish('needs_js', 'prices on this shop only appear after JavaScript runs; not fetched (open the manual link)');
  if (shop.structured_data === false) return finish('no_route', 'product pages carry no schema.org data; not fetched (open the manual link)');
  if (shop.unreachable) return finish('no_route', `not asked: ${shop.no_route_reason ?? 'the site answers a plain client with errors'}`);
  const blocked = await opts.cache.get<{ at: string; vendor: string }>('blocked', shop.id);
  if (blocked) return finish('blocked', `bot protection (${blocked.vendor}) at ${blocked.at}; skipped for an hour`);

  // ---- 1. candidates -------------------------------------------------------------------------
  const candKey = `${shop.id}|${normQuery(query)}|${opts.providers.map((p) => p.id).join(',') || 'none'}|${opts.siteSearchMode ?? 'combined'}`;
  const cached = await opts.cache.get<CachedCandidates>('candidates', candKey);
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
      candidates = providerCandidates(r.hits);
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

  const first = await readCandidates(ctx, route, candidates, notes);
  const result = (o: RouteOutcome, r: ShopResult['route'], detail: string): ShopResult => finish(o.status, detail, {
    route: r, offers: o.offers, candidates: o.candidates, requestsUsed: session.used, fromCache: session.used === 0,
  });

  // ---- 4. second route: the shop's own search found nothing matching -> try the web search --------
  // Not for blocked, robots-disallowed, needs_js or failed outcomes: only a plain "nothing matching".
  if (first.status !== 'no_match' || route !== 'shop_search' || !fallback) return result(first, route, `${first.detail}${tail(notes)}`);
  const firstText = `shop search: ${first.detail}${tail(notes)}`;
  if (session.remaining() <= 0) {
    return result(first, route, `${firstText}; the web search route was not tried: the request budget (${MAX_REQUESTS_PER_SHOP} per shop) is used up`);
  }
  const r = await fallback.find(shop.domain, shop.country);
  if (r.unavailable || r.error) {
    return result(first, route, `${firstText}; the web search route could not be tried: ${r.unavailable ?? r.error}`);
  }
  const notes2: string[] = [];
  const second = await readCandidates(ctx, 'search_provider', providerCandidates(r.hits), notes2);
  const merged: RouteOutcome = {
    ...second,
    offers: [...first.offers, ...second.offers],
    candidates: [...second.candidates.slice(0, 6), ...first.candidates].slice(0, 10),
  };
  const webText = `${r.provider} web search: ${second.detail}${tail(notes2)}`;
  if (second.status === 'ok') {
    return result(merged, 'both', `${second.detail}, found by the web search after the shop search found nothing matching (both routes tried; ${firstText}; ${webText})`);
  }
  // A product page behind bot protection is reported as blocked; otherwise the shop stays no_match.
  const status: ShopStatus = second.status === 'blocked' ? 'blocked' : 'no_match';
  return result({ ...merged, status }, 'both', `both routes tried, nothing matching: ${firstText}; ${webText}`);
}
