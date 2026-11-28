// The search: every in-scope shop in parallel, each ending with an explicit status, results
// streamed as they arrive. Uses only web-standard APIs plus the injected cache/fetch.

import { chooseCategories, shopIsRelevant, type CategoryChoice } from './categories.ts';
import { correctQuery } from './correct.ts';
import { groupOffers } from './group.ts';
import { categoryLabel, categoryName, date, localizeShop, t, techNote, type Lang, type ShopTexts } from './i18n.ts';
import { HostScheduler, MAX_REQUESTS_PER_SHOP, ShopSession, type FetchLike } from './http.ts';
import { extractListCandidates, extractOffers, offerUrl } from './jsonld.ts';
import { extractLinkCandidates, pageKey, stripTrackingParams } from './links.ts';
import { coreQuery, linkInput, matchTitle, namesSomething, parseQuery, scoreCandidate, specList, withoutPackageWords, type ParsedQuery } from './matcher.ts';
import { nearbyModels } from './nearby.ts';
import { offerParams } from './params.ts';
import { getRates } from './rates.ts';
import {
  ProviderChain, SiteSearchBatcher, type ProviderCall, type SearchHit, type SearchProvider, type SiteSearchMode, type SiteSearchResult,
} from './search/provider.ts';
import { buildSearchUrl, heurekaUrl, sectionFor, type Location } from './shops.ts';
import { computeTotals, type Rates } from './totals.ts';
import {
  CACHE_TTL, type Cache, type Candidate, type History, type NearbyList, type NearbyShop, type Offer, type ProductGroup, type RawOffer, type SeenPrice, type Shop,
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
  /** Search the query exactly as typed: no brand correction (correct.ts). */
  asTyped?: boolean;
  /**
   * Language of the sentences in the events (shop details, notes, messages); default English.
   * Status codes and other identifiers do not change, and nothing written to the cache depends on it.
   */
  lang?: Lang;
  /** Translated free-text notes of the shops (data/shops.sk.yaml); a missing one falls back to English. */
  shopTexts?: ShopTexts;
  /** "online" (default): ask the shops. "local": only the local database (`history`), no request at all. */
  mode?: 'online' | 'local';
  /** The local database (src/node/db.ts). Without it nothing is stored, and a local search finds nothing. */
  history?: History;
  /** Ask the web search again even where the local database already has its answer (REUSE_DAYS). */
  refreshWeb?: boolean;
}

/**
 * How long a web search's answer for one shop and query is reused from the local database in an
 * online search: the pages it found are read again for current prices (shop requests, no web search
 * credit), and "found nothing" is not asked again. "Search the web again" (refreshWeb) overrides it.
 */
export const REUSE_DAYS = 14;

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
  /**
   * query: what is searched; typed: what was typed or pasted; corrected: a brand typo was corrected;
   * fromLink: the query is the name in a pasted link; linkShop: the shop of that link, when it is one of the shops;
   * fromList: what was typed is a name followed by a specification list, and the name is searched.
   */
  | {
    type: 'start'; query: string; typed: string; corrected: boolean; fromLink: boolean; linkShop: string | null; fromList: boolean; location: string;
    shops: ShopInfo[];
    /** "local": the results come from the local database only; nothing was asked. */
    mode: 'online' | 'local';
    heurekaUrl: string; providers: string[]; categories: CategoryChoice;
  }
  /** Nothing was searched: a pasted link without the product's name. The only event of such a search. */
  | { type: 'rejected'; typed: string; message: string }
  | { type: 'rates'; rates: Rates | null; error?: string }
  | { type: 'shop'; result: ShopResult }
  /** groups: the distinct products so far; nearby: similar models the shops list (nearby.ts). */
  | { type: 'products'; groups: ProductGroup[]; nearby: NearbyList }
  | { type: 'done'; summary: SearchSummary };

export interface SearchSummary {
  /** What was searched (the corrected query, if a brand typo was corrected). */
  query: string;
  /** What was typed. */
  typed: string;
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

/**
 * What a product page gave, cached by URL. `v` is the extraction version: an entry from an older
 * version is read again once instead of used. Raise it when what is read from a page changes
 * (params.ts included), so no search shows parameters read by older rules.
 */
const PAGE_VERSION = 3;
interface CachedPage {
  v?: number;
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

/**
 * The text each shop is sent. Shops in the search location's country get the query as typed (after
 * correction). Shops in another country get the core query (matcher.ts, coreQuery: no category,
 * connector, generic or colour words, which belong to one language) when it still names something
 * specific; otherwise the query as typed. The same text goes into the web query for that country
 * and into the shop's manual link. When a shop's own search returns no products, it is asked once
 * more with the core query without package words (retryFor), if that differs from what it was sent.
 * The matcher always judges against the full query.
 */
export function searchTexts(query: string, homeCountry: string): { core: string; sentFor: (country: string) => string; retryFor: (sent: string) => string | null } {
  const core = coreQuery(query);
  const specific = core !== query && namesSomething(core);
  const sentFor = (country: string) => (specific && country.toUpperCase() !== homeCountry.toUpperCase() ? core : query);
  const retryFor = (sent: string) => {
    const base = specific ? core : query;
    const text = withoutPackageWords(base) ?? base;
    return text !== sent && namesSomething(text) ? text : null;
  };
  return { core, sentFor, retryFor };
}

export async function* runSearch(typed: string, options: SearchOptions): AsyncGenerator<SearchEvent> {
  const t0 = Date.now();
  const lang = options.lang ?? 'en';
  // The shops with their shown notes in the search's language (only texts change, never facts).
  const opts: SearchOptions = { ...options, lang, shops: options.shops.map((s) => localizeShop(s, lang, options.shopTexts)) };
  // A pasted product link gives the name in its path (matcher.ts, linkInput); the link is never
  // fetched and nothing else of it is sent anywhere. A link without a name starts no search.
  const link = linkInput(typed);
  if (link && !link.query) {
    yield { type: 'rejected', typed, message: t(lang, 'rejectedLink') };
    return;
  }
  // Otherwise a brand typed with one wrong letter is searched as the brand (correct.ts), unless asked
  // not to; "as typed" has no meaning for a link. Everything below (category guess, shop search
  // pages, web queries, matcher, cache keys) uses the searched form.
  // A whole product title with its specifications ("HP Z2 Tower G1i, Ultra9 285K/vPro, …, 32GB, SSD
  // 1TB, W11Pro") finds nothing in shops' own searches; its name is searched, and the configurations
  // found are shown to choose from (matcher.ts, specList). "As typed" searches the whole text.
  const list = link || opts.asTyped ? null : specList(typed.trim());
  const listName = list && namesSomething(list.name) ? list.name : null;
  const fix = link?.query ? { query: link.query, typed, corrected: false } : opts.asTyped ? { query: typed.trim(), typed, corrected: false }
    : listName ? { ...correctQuery(listName), typed } : correctQuery(typed);
  const query = fix.query;
  const linkShop = link ? opts.shops.find((s) => link.host === s.domain || link.host.endsWith(`.${s.domain}`))?.name ?? null : null;
  const inScope = opts.shops.filter((s) => s.in_scope);
  const choice = chooseCategories(query, opts.category);
  const shops = inScope.filter((s) => shopIsRelevant(s, choice.categories));
  const skipped = inScope.filter((s) => !shopIsRelevant(s, choice.categories));
  const pq = parseQuery(query);
  const texts = searchTexts(query, opts.location.country);
  yield {
    type: 'start', query, typed: fix.typed, corrected: fix.corrected, fromLink: Boolean(link), linkShop, fromList: Boolean(listName), mode: opts.mode ?? 'online',
    location: opts.location.id, heurekaUrl: heurekaUrl(query), providers: opts.providers.map((p) => p.id),
    categories: choice,
    shops: inScope.map((s) => ({ id: s.id, name: s.name, domain: s.domain, section: sectionFor(s, opts.location), branchKnown: s[opts.location.branchField] })),
  };
  const notRelevant: ShopResult[] = skipped.map((s) => ({
    shopId: s.id, shopName: s.name, domain: s.domain, section: sectionFor(s, opts.location), status: 'not_relevant',
    detail: t(lang, 'notRelevant', { cats: s.categories.map((c) => categoryName(lang, c)).join(', '), label: categoryLabel(lang, choice, opts.category) }), route: 'none',
    manualUrl: s.search_url_template ? buildSearchUrl(s.search_url_template, texts.sentFor(s.country)) : null,
    offers: [], candidates: [], requestsUsed: 0, fromCache: true, ms: 0,
  }));
  for (const r of notRelevant) yield { type: 'shop', result: r };

  const currencies = [...new Set(opts.shops.map((s) => s.currency))];
  const local = opts.mode === 'local';
  const ratesP = exchangeRates(currencies, opts, local);

  const chain = !local && opts.providers.length ? new ProviderChain(opts.providers, opts.cache, { fetch: opts.fetch, onCall: opts.onProviderCall }) : null;
  // The web query for shops of one country uses the text those shops' own search gets (searchTexts).
  const batchOpts = {
    query, queryFor: texts.sentFor, expected: shops.length, mode: opts.siteSearchMode ?? 'combined', domainsPerQuery: opts.domainsPerQuery ?? 6,
  } as const;
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
  const qk = normQuery(query);
  const record = (r: ShopResult) => {
    results.push(r);
    remaining--;
    push({ type: 'shop', result: r });
    push({ type: 'products', groups: groupOffers(results.flatMap((x) => x.offers), lang), nearby: nearbyModels(pq, results) });
  };
  // A search from the local database: each shop's stored result, no request and no web search.
  if (local) for (const shop of shops) void storedShop(shop, pq, qk, opts, ratesP.then((r) => r.rates), texts.sentFor(shop.country)).then(record);
  for (const shop of local ? [] : shops) {
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
    const sent = texts.sentFor(shop.country);
    searchShop(shop, pq, opts, batcher, slot, ratesP.then((r) => r.rates), contexts, { sent, retry: texts.retryFor(sent), qk })
      .finally(() => {
        if (fallback && !fallbackDecided) fallback.decline();
      })
      .catch((e): ShopResult => ({
        shopId: shop.id, shopName: shop.name, domain: shop.domain, section: sectionFor(shop, opts.location), status: 'error',
        detail: t(lang, 'internalError', { msg: e instanceof Error ? e.message : String(e) }), route: 'none',
        manualUrl: shop.search_url_template ? buildSearchUrl(shop.search_url_template, sent) : null,
        offers: [], candidates: [], requestsUsed: 0, fromCache: false, ms: 0,
      }))
      .then(async (r) => {
        await remember(opts.history, qk, r);
        record(r);
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
  const groups = groupOffers(allOffers, lang);
  const nearby = nearbyModels(pq, results);
  // No exact match: a price for the first similar models, then the list once more with it.
  const priced = !local && !groups.some((g) => g.level === 'exact') && nearby.models.length
    ? await priceNearbyModels(nearby, results, contexts)
    : { list: nearby, prices: 0, requests: 0 };
  if (priced.prices) yield { type: 'products', groups, nearby: priced.list };
  yield {
    type: 'done',
    summary: {
      query, typed: fix.typed, ms: Date.now() - t0, statusCounts, offers: allOffers.length, groups: groups.length,
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

// ---- the local database (History) ------------------------------------------------------------------

/** "2026-11-28" from an ISO time, written in the search's language. */
const day = (lang: Lang, iso: string) => date(lang, iso.slice(0, 10));

/**
 * Exchange rates. A local search asks nothing: the cache, else the rates last stored. An online
 * search stores what it got, for a later local one.
 */
async function exchangeRates(currencies: string[], opts: SearchOptions, local: boolean): Promise<{ rates: Rates | null; error?: string }> {
  const noFetch: FetchLike = async () => {
    throw new Error('a search from the local database asks nothing');
  };
  const r = await getRates(currencies, opts.cache, local ? noFetch : opts.fetch);
  if (r.rates) {
    if (!local && Object.keys(r.rates.rates).length) await opts.history?.saveRates(r.rates);
    return r;
  }
  const last = await opts.history?.lastRates();
  return last ? { rates: last.value as Rates } : r;
}

/**
 * One shop's result from the local database: the stored pages that matched this query at the shop,
 * matched again with today's rules, and the date they were read. With no page stored, the last
 * result (nothing matching, blocked ...) with its date, or "not stored". No request.
 */
async function storedShop(shop: Shop, pq: ParsedQuery, qk: string, opts: SearchOptions, ratesP: Promise<Rates | null>, sent: string): Promise<ShopResult> {
  const lang = opts.lang ?? 'en';
  const section = sectionFor(shop, opts.location);
  const base = {
    shopId: shop.id, shopName: shop.name, domain: shop.domain, section, route: 'none' as const,
    manualUrl: shop.search_url_template ? buildSearchUrl(shop.search_url_template, sent) : null,
    offers: [], candidates: [], requestsUsed: 0, fromCache: true, ms: 0,
  };
  const h = opts.history;
  if (!h) return { ...base, status: 'not_stored', detail: t(lang, 'notStored') };
  const run = await h.lastRun(qk, shop.id);
  const raw: RawOffer[] = [];
  let oldest: string | null = null;
  let pages = 0;
  for (const f of await h.pagesFor(qk, shop.id)) {
    const p = await h.page(f.url);
    if (!p) continue;
    pages++;
    raw.push(...p.page.offers.map((o) => ({ ...o, pageUrl: f.url })));
    if (!oldest || p.at < oldest) oldest = p.at;
  }
  if (raw.length && oldest) {
    const offers = await toOffers({ shop, opts, section, ratesP }, raw, pq);
    const matching = offers.some((o) => o.match.level !== 'different');
    return {
      ...base, status: matching ? 'ok' : 'no_match', route: run?.route ?? 'none', offers, storedAt: oldest,
      detail: t(lang, 'fromLocal', { n: pages, date: day(lang, oldest) }),
    };
  }
  if (!run) return { ...base, status: 'not_stored', detail: t(lang, 'notStored') };
  const nothing = run.status === 'ok' || run.status === 'no_match';
  return {
    ...base, status: nothing ? 'no_match' : run.status, route: run.route, storedAt: run.at,
    detail: nothing ? t(lang, 'storedNothing', { date: day(lang, run.at) }) : t(lang, 'storedStatus', { date: day(lang, run.at) }),
  };
}

/**
 * After an online search: the shop's result goes into the local database, with the pages that
 * matched. `webAt` moves only when the web search was really asked (not reused from the database).
 */
async function remember(history: History | undefined, qk: string, r: ShopResult): Promise<void> {
  if (!history || r.status === 'not_relevant' || r.status === 'not_stored') return;
  const web = (r.route === 'search_provider' || r.route === 'both') && !r.storedAt;
  const prev = await history.lastRun(qk, r.shopId);
  const webAt = web ? new Date().toISOString() : prev?.webAt;
  const found = new Map<string, { url: string; title: string; route: ShopResult['route'] }>();
  for (const o of r.offers) {
    if (o.match.level === 'different') continue;
    const url = o.pageUrl ?? o.url;
    if (!found.has(url)) found.set(url, { url, title: o.title, route: r.route });
  }
  await history.saveRun(qk, r.shopId, { status: r.status, route: r.route, at: new Date().toISOString(), ...(webAt ? { webAt } : {}) }, [...found.values()]);
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
  const lang = opts.lang ?? 'en';
  const cached = await opts.cache.get<CachedPage>('offers', url);
  const hit = cached && cached.v === PAGE_VERSION ? cached : null;
  if (hit && (hit.status === 404 || hit.status === 410)) {
    ctx.read.add(pageKey(url));
    return { kind: 'failed', note: t(lang, 'pageFailedCached', { url, status: hit.status }) };
  }
  if (hit) {
    ctx.read.add(pageKey(url));
    if (hit.productNodes) await rememberStructuredData(ctx);
    // A page read before the local database existed goes into it now, so a local search finds it.
    if (opts.history && !(await opts.history.page(url))) await opts.history.savePage(url, shop.id, hit);
    // Entries cached before offerUrl existed may still hold a site-root URL.
    return { kind: 'offers', offers: hit.offers.map((o) => ({ ...o, url: offerUrl(o.url, hit.finalUrl), pageUrl: url })), productNodes: hit.productNodes };
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
      await opts.cache.set('offers', url, { v: PAGE_VERSION, offers: [], productNodes: 0, status: page.status, finalUrl: page.finalUrl } satisfies CachedPage, CACHE_TTL.offers);
    }
    return { kind: 'failed', note: `${url}: ${page.error ? techNote(lang, page.error) : `HTTP ${page.status}`}` };
  }
  const ex = extractOffers(page.text, page.finalUrl, shop.id);
  if (ex.productNodes) await rememberStructuredData(ctx);
  const stored: CachedPage = { v: PAGE_VERSION, offers: ex.offers, productNodes: ex.productNodes, status: page.status, finalUrl: page.finalUrl };
  await opts.cache.set('offers', url, stored, CACHE_TTL.offers);
  await opts.history?.savePage(url, shop.id, stored);
  return { kind: 'offers', offers: ex.offers.map((o) => ({ ...o, pageUrl: url })), productNodes: ex.productNodes };
}

/** Offers with a price, one per page and price, matched against the query and with their totals. */
async function toOffers(ctx: Pick<ShopCtx, 'shop' | 'opts' | 'section' | 'ratesP'>, raw: RawOffer[], pq: ParsedQuery): Promise<Offer[]> {
  const { shop, opts, section } = ctx;
  const rates = await ctx.ratesP;
  return dedupeOffers(raw.filter((x) => x.price > 0)).map((r) => ({
    ...r, shopName: shop.name, section, shipsToSk: shop.ships_to_sk, branchKnown: shop[opts.location.branchField],
    params: offerParams(r.title, r.params),
    match: matchTitle(pq, { title: r.title, brand: r.brand, sku: r.sku, mpn: r.mpn, color: r.color, itemCondition: r.itemCondition, url: r.url, shopName: shop.name }),
    totals: computeTotals(r, shop, rates, opts.location.country, { local: section === 'local', lang: opts.lang }),
  }));
}

/** Steps 2 and 3 for one route: fetch the best candidate pages, extract offers, match them. */
async function readCandidates(ctx: ShopCtx, route: ShopResult['route'], candidates: Candidate[], notes: string[]): Promise<RouteOutcome> {
  const { shop, pq, opts } = ctx;
  const lang = opts.lang ?? 'en';
  const ranked = rankCandidates(pq, candidates);
  const shownCandidates = ranked.slice(0, 10);
  const none = (status: ShopStatus, detail: string): RouteOutcome => ({ status, detail, offers: [], candidates: shownCandidates });
  if (!candidates.length) {
    return none('no_match', route === 'search_provider' ? t(lang, 'noWebPages') : t(lang, 'noShopProducts'));
  }
  const matchingCands = ranked.filter((c) => c.level !== 'different');
  if (!matchingCands.length) {
    return none('no_match', t(lang, 'noneMatching', { n: candidates.length, best: (ranked[0]?.title || ranked[0]?.url || '').slice(0, 80) }));
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
      if (!raw.length) return none('blocked', t(lang, 'blockedProductPage', { vendor: page.vendor }));
      notes.push(t(lang, 'blockedOnUrl', { url: c.url }));
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
  if (budgetHit) notes.push(t(lang, 'budgetReached', { max: MAX_REQUESTS_PER_SHOP }));
  if (alreadyRead) notes.push(t(lang, 'alreadyReadPages', { n: alreadyRead }));

  // ---- 3. match + totals ---------------------------------------------------------------------
  const unpriced = raw.filter((r) => !(r.price > 0)).length;
  if (unpriced) notes.push(t(lang, 'zeroPriced', { n: unpriced }));
  const offers = await toOffers(ctx, raw, pq);
  const matching = offers.filter((o) => o.match.level !== 'different');
  const out = (status: ShopStatus, detail: string): RouteOutcome => ({ status, detail, offers, candidates: shownCandidates });
  if (matching.length) {
    const ex = matching.filter((o) => o.match.level === 'exact').length;
    return out('ok', t(lang, 'okOffers', { n: matching.length, exact: ex, possible: matching.length - ex }));
  }
  if (pagesFetched && pagesWithoutData === pagesFetched) {
    // A shop whose product pages are known to carry the data: these pages were something else
    // (articles, category pages), so nothing matching was found; that is no_match, not needs_js.
    if (shop.structured_data === true || (await opts.cache.get('structured_data', shop.id))) {
      return out('no_match', t(lang, 'pagesNotProduct', { n: pagesFetched }));
    }
    return out('needs_js', t(lang, 'pagesNeedJs', { n: pagesFetched }));
  }
  if (robotsBlockedPages && !pagesFetched) return out('robots_disallowed', t(lang, 'robotsCandidates'));
  if (!pagesFetched && !tried && alreadyRead) return out('no_match', t(lang, 'alreadyReadMatching'));
  if (!pagesFetched) return out('error', t(lang, 'noPageRead'));
  return out('no_match', t(lang, 'offersNoneMatching', { offers: offers.length, pages: pagesFetched }));
}

async function searchShop(
  shop: Shop, pq: ParsedQuery, opts: SearchOptions, batcher: SiteSearchBatcher | null, fallback: FallbackSlot | null, ratesP: Promise<Rates | null>,
  contexts: Map<string, ShopCtx>, texts: { sent: string; retry: string | null; qk: string },
): Promise<ShopResult> {
  const t0 = Date.now();
  const lang = opts.lang ?? 'en';
  // What the shop's search, the web query and the manual link get (searchTexts); the matcher uses pq, the full query.
  const sent = texts.sent;
  const section = sectionFor(shop, opts.location);
  const manualUrl = shop.search_url_template ? buildSearchUrl(shop.search_url_template, sent) : null;
  const base = { shopId: shop.id, shopName: shop.name, domain: shop.domain, section, manualUrl };
  const session = new ShopSession(shop.domain, { scheduler: opts.scheduler, cache: opts.cache, fetch: opts.fetch, acceptLanguage: shop.accept_language });
  let declined = false;
  const decline = () => {
    if (!declined && batcher) batcher.decline();
    declined = true;
  };
  /** Set when the web search's answer came from the local database (its date). */
  let storedAt: string | undefined;
  const finish = (status: ShopStatus, detail: string, extra: Partial<ShopResult> = {}): ShopResult => {
    decline();
    return {
      ...base, status, detail, route: 'none', offers: [], candidates: [], requestsUsed: session.used,
      fromCache: session.used === 0, ms: Date.now() - t0, ...(storedAt ? { storedAt } : {}), ...extra,
    };
  };
  // A web search for this shop and query answered within REUSE_DAYS: its pages, or "nothing found".
  const known = async (): Promise<{ pages: Candidate[]; webAt: string } | null> => {
    if (opts.refreshWeb || !opts.history) return null;
    const run = await opts.history.lastRun(texts.qk, shop.id);
    if (!run?.webAt || Date.now() - Date.parse(run.webAt) > REUSE_DAYS * 86_400_000) return null;
    const pages = (await opts.history.pagesFor(texts.qk, shop.id)).map((p) => ({ url: p.url, title: p.title, from: 'search_provider' as const }));
    return { pages, webAt: run.webAt };
  };
  const markBlocked = async (vendor: string) => {
    await opts.cache.set('blocked', shop.id, { at: new Date().toISOString(), vendor }, CACHE_TTL.blocked);
  };
  const ctx: ShopCtx = { shop, pq, opts, session, section, ratesP, markBlocked, read: new Set() };
  contexts.set(shop.id, ctx);
  const tail = (notes: string[]) => (notes.length ? ` (${notes.join('; ')})` : '');

  if (shop.needs_js) return finish('needs_js', t(lang, 'needsJs'));
  if (shop.structured_data === false) return finish('no_route', t(lang, 'noSchema'));
  if (shop.unreachable) return finish('no_route', t(lang, 'notAsked', { reason: shop.no_route_reason ?? t(lang, 'defaultUnreachable') }));
  const blocked = await opts.cache.get<{ at: string; vendor: string }>('blocked', shop.id);
  if (blocked) return finish('blocked', t(lang, 'blockedCached', { vendor: blocked.vendor, at: blocked.at }));

  // ---- 1. candidates -------------------------------------------------------------------------
  // Keyed by the text sent: candidates are stored unscored, and scored against the full query after the cache.
  const candKey = `${shop.id}|${normQuery(sent)}|${opts.providers.map((p) => p.id).join(',') || 'none'}|${opts.siteSearchMode ?? 'combined'}`;
  const cached = await opts.cache.get<CachedCandidates>('candidates', candKey);
  let route: ShopResult['route'] = cached?.route ?? 'none';
  let candidates: Candidate[] = cached?.candidates ?? [];
  const notes: string[] = [];
  if (sent !== pq.raw) notes.push(t(lang, 'searchedAs', { sent }));

  if (!cached) {
    let searchAllowed = false;
    if (manualUrl) {
      const perm = await session.allowed(manualUrl);
      if (perm.blocked) {
        await markBlocked(perm.blocked);
        return finish('blocked', t(lang, 'blockedRobots', { vendor: perm.blocked }));
      }
      if (perm.budgetExhausted) return finish('error', t(lang, 'budgetRobots'));
      searchAllowed = perm.allowed;
      if (!perm.allowed) notes.push(t(lang, 'robotsSearch', { note: perm.note ? techNote(lang, perm.note) : undefined }));
    }
    if (manualUrl && searchAllowed) {
      decline();
      route = 'shop_search';
      const page = await session.get(manualUrl, 'search');
      if (page.blocked) {
        await markBlocked(page.blocked);
        return finish('blocked', t(lang, 'blockedSearch', { vendor: page.blocked }), { route });
      }
      if (page.robotsDisallowed) return finish('robots_disallowed', t(lang, 'searchRedirectRobots', { url: page.robotsDisallowed }), { route });
      if (page.offsiteRedirect) return finish('error', t(lang, 'searchOffsite', { url: page.offsiteRedirect }), { route });
      if (!page.ok) {
        const why = page.error ? techNote(lang, page.error) : `HTTP ${page.status}`;
        const guess = page.status === 404 && shop.search_template_basis === 'guess';
        return finish('error', t(lang, 'searchFailed', { why, guess }), { route });
      }
      const fromList = extractListCandidates(page.text, page.finalUrl);
      candidates = fromList.length ? fromList : extractLinkCandidates(page.text, page.finalUrl, sent, shop.link_exclude_regex);
      if (!fromList.length) notes.push(t(lang, 'noItemList'));
    } else if (batcher) {
      route = 'search_provider';
      const reuse = await known();
      if (reuse) {
        // Answered before: no web search, no credit. Its pages are read again for current prices.
        decline();
        storedAt = reuse.webAt;
        if (!reuse.pages.length) return finish('no_match', t(lang, 'webNothingReused', { date: day(lang, reuse.webAt) }), { route });
        candidates = reuse.pages;
        notes.push(t(lang, 'webReused', { n: reuse.pages.length, date: day(lang, reuse.webAt) }));
      } else {
        declined = true;
        const r = await batcher.find(shop.domain, shop.country);
        const why = notes.length ? `${notes.join('; ')}; ` : '';
        if (r.unavailable) return finish('needs_search_key', t(lang, 'noProvider', { why, reason: techNote(lang, r.unavailable) }), { route });
        if (r.error) return finish('error', t(lang, 'webFailed', { error: techNote(lang, r.error) }), { route });
        candidates = providerCandidates(r.hits);
        notes.push(t(lang, 'foundVia', { provider: String(r.provider) }));
      }
    } else if (manualUrl) {
      return finish('needs_search_key', t(lang, 'setKey', { notes: notes.join('; ') }));
    } else {
      return finish('no_route', t(lang, 'noRoute', { reason: shop.no_route_reason ?? t(lang, 'defaultNoSearchUrl') }));
    }
    if (!storedAt) await opts.cache.set('candidates', candKey, { route, candidates } satisfies CachedCandidates, CACHE_TTL.candidates);
  } else {
    decline();
    notes.push(t(lang, 'candidatesFromCache'));
  }

  // ---- 1b. the shop's own search returned no products: once more with the core query -------------
  // Shops often name the pack another way ("Duo Pack" for "doublepack") and do not know words of
  // another language: their search is asked once more with the core query without package words
  // (searchTexts, retryFor), and what it lists is scored against the full query as usual. Also after
  // an empty first answer from the cache; the retry has its own cache entry.
  const shorter = route === 'shop_search' && !candidates.length && shop.search_url_template ? texts.retry : null;
  if (shorter && shop.search_url_template) {
    const said = t(lang, 'retrySaid', { sent, shorter });
    const retryKey = `${candKey}|retry|${normQuery(shorter)}`;
    const hit = await opts.cache.get<CachedCandidates>('candidates', retryKey);
    if (hit) {
      candidates = hit.candidates;
      notes.push(`${said}: ${t(lang, 'results', { n: candidates.length })}${t(lang, 'fromCacheSuffix')}`);
    } else if (session.remaining() <= 0) {
      notes.push(t(lang, 'retryNotPossible', { said, max: MAX_REQUESTS_PER_SHOP }));
    } else {
      const page = await session.get(buildSearchUrl(shop.search_url_template, shorter), 'search');
      if (page.blocked) {
        await markBlocked(page.blocked);
        return finish('blocked', `${said}: ${t(lang, 'blockedSearch', { vendor: page.blocked })}`, { route });
      }
      const failed = page.robotsDisallowed ? t(lang, 'redirectRobots', { url: page.robotsDisallowed })
        : page.offsiteRedirect ? t(lang, 'redirectOffsite', { url: page.offsiteRedirect })
        : page.budgetExhausted ? t(lang, 'budgetUsedUp', { max: MAX_REQUESTS_PER_SHOP })
        : !page.ok ? (page.error ? techNote(lang, page.error) : `HTTP ${page.status}`) : null;
      if (failed) notes.push(t(lang, 'retryFailed', { said, failed }));
      else {
        const fromList = extractListCandidates(page.text, page.finalUrl);
        candidates = fromList.length ? fromList : extractLinkCandidates(page.text, page.finalUrl, shorter, shop.link_exclude_regex);
        await opts.cache.set('candidates', retryKey, { route, candidates } satisfies CachedCandidates, CACHE_TTL.candidates);
        notes.push(`${said}: ${t(lang, 'results', { n: candidates.length })}`);
      }
    }
  }

  const first = await readCandidates(ctx, route, candidates, notes);
  const result = (o: RouteOutcome, r: ShopResult['route'], detail: string): ShopResult => finish(o.status, detail, {
    route: r, offers: o.offers, candidates: o.candidates, requestsUsed: session.used, fromCache: session.used === 0,
  });

  // ---- 4. second route: the shop's own search found nothing matching -> try the web search --------
  // Not for blocked, robots-disallowed, needs_js or failed outcomes: only a plain "nothing matching".
  if (first.status !== 'no_match' || route !== 'shop_search' || !fallback) return result(first, route, `${first.detail}${tail(notes)}`);
  const firstText = t(lang, 'shopSearchPrefix', { detail: `${first.detail}${tail(notes)}` });
  if (session.remaining() <= 0) {
    return result(first, route, t(lang, 'webNotTried', { first: firstText, max: MAX_REQUESTS_PER_SHOP }));
  }
  const reuse = await known();
  if (reuse && !reuse.pages.length) {
    storedAt = reuse.webAt;
    return result(first, 'both', `${firstText}; ${t(lang, 'webNothingReused', { date: day(lang, reuse.webAt) })}`);
  }
  const r = reuse ? null : await fallback.find(shop.domain, shop.country);
  if (r && (r.unavailable || r.error)) {
    return result(first, route, t(lang, 'webCouldNotTry', { first: firstText, reason: techNote(lang, (r.unavailable ?? r.error) as string) }));
  }
  const notes2: string[] = [];
  if (reuse) {
    storedAt = reuse.webAt;
    notes2.push(t(lang, 'webReused', { n: reuse.pages.length, date: day(lang, reuse.webAt) }));
  }
  const second = await readCandidates(ctx, 'search_provider', reuse ? reuse.pages : providerCandidates(r ? r.hits : []), notes2);
  const merged: RouteOutcome = {
    ...second,
    offers: [...first.offers, ...second.offers],
    candidates: [...second.candidates.slice(0, 6), ...first.candidates].slice(0, 10),
  };
  const webText = t(lang, 'webSearchPrefix', { provider: r ? String(r.provider) : t(lang, 'localDatabase'), detail: `${second.detail}${tail(notes2)}` });
  if (second.status === 'ok') {
    return result(merged, 'both', t(lang, 'foundBySecond', { detail: second.detail, first: firstText, web: webText }));
  }
  // A product page behind bot protection is reported as blocked; otherwise the shop stays no_match.
  const status: ShopStatus = second.status === 'blocked' ? 'blocked' : 'no_match';
  return result({ ...merged, status }, 'both', t(lang, 'bothNothing', { first: firstText, web: webText }));
}
