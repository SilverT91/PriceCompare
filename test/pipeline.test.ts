// End-to-end search over mocked shops (no network).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HostScheduler, type FetchLike } from '../src/core/http.ts';
import { dedupeOffers, runSearch, type SearchEvent } from '../src/core/pipeline.ts';
import { SerperProvider } from '../src/core/search/serper.ts';
import { buildSearchUrl, DEFAULT_LOCATION, validateShops } from '../src/core/shops.ts';
import type { ShopResult } from '../src/core/types.ts';
import { MemoryCache } from './helpers.ts';

const product = (name: string, price: number, gtin: string, extra = '', currency = 'EUR') =>
  `<html><script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"${name}","gtin13":"${gtin}","brand":"Oral-B",
  "offers":{"@type":"Offer","price":${price},"priceCurrency":"${currency}","availability":"https://schema.org/InStock"${extra}}}</script></html>`;

const { shops } = validateShops({
  shops: [
    { id: 'a', name: 'Shop A', domain: 'a.test', country: 'SK', currency: 'EUR', has_kosice_branch: true, search_url_template: 'https://a.test/s?q={query}' },
    { id: 'b', name: 'Shop B', domain: 'b.test', country: 'SK', currency: 'EUR', search_url_template: 'https://b.test/search?q={query}' },
    { id: 'c', name: 'Shop C', domain: 'c.test', country: 'SK', currency: 'EUR', search_url_template: 'https://c.test/s?q={query}' },
    { id: 'd', name: 'Shop D', domain: 'd.test', country: 'SK', currency: 'EUR', search_url_template: 'https://d.test/s?q={query}', needs_js: true },
    { id: 'e', name: 'Shop E', domain: 'e.test', country: 'SK', currency: 'EUR', search_url_template: null },
    { id: 'f', name: 'Shop F', domain: 'f.test', country: 'CZ', currency: 'CZK', search_url_template: 'https://f.test/hledat?q={query}' },
    { id: 'x', name: 'Grocery', domain: 'x.test', in_scope: false, search_url_template: 'https://x.test/?q={query}' },
  ],
});

const ITEMLIST = `<html><script type="application/ld+json">{"@type":"ItemList","itemListElement":[
  {"@type":"ListItem","item":{"@type":"Product","name":"Oral-B Pro 3 3000 Black","url":"https://a.test/p/black"}},
  {"@type":"ListItem","item":{"@type":"Product","name":"Oral-B Pro 3 3900 Duopack","url":"https://a.test/p/duo"}},
  {"@type":"ListItem","item":{"@type":"Product","name":"Oral-B Pro 3 3000 White","url":"https://a.test/p/white"}}]}</script></html>`;

function site() {
  const calls: string[] = [];
  const routes: Record<string, () => Response> = {
    'https://a.test/robots.txt': () => new Response('User-agent: *\nDisallow: /cart'),
    'https://a.test/s?q=Oral-B+Pro+3+3000': () => new Response(ITEMLIST),
    'https://a.test/p/black': () => new Response(product('Oral-B Pro 3 3000 Black', 59.9, '8006540759790')),
    'https://a.test/p/white': () => new Response(product('Oral-B Pro 3 3000 White', 62.5, '8006540760161')),
    'https://b.test/robots.txt': () => new Response('User-agent: *\nDisallow: /search'),
    'https://c.test/robots.txt': () => new Response('<title>Just a moment...</title>', { status: 403 }),
    'https://f.test/robots.txt': () => new Response('User-agent: *\nDisallow: /hledat'),
    'https://f.test/oral-b-pro-3-3000': () => new Response(product('Oral-B Pro 3 3000 černá', 1290, '8006540759790',
      ',"shippingDetails":{"@type":"OfferShippingDetails","shippingDestination":{"addressCountry":"SK"},"shippingRate":{"value":99,"currency":"CZK"}}', 'CZK')),
    'https://api.frankfurter.dev/v2/providers/ecb/rates?base=EUR&quotes=CZK': () => new Response(JSON.stringify([{ date: '2026-11-24', base: 'EUR', quote: 'CZK', rate: 24.428 }])),
  };
  const f: FetchLike = async (url, init) => {
    calls.push(url);
    if (url === 'https://google.serper.dev/search') {
      const q = JSON.parse(String(init?.body)).q as string;
      assert.match(q, /site:f\.test/);
      return new Response(JSON.stringify({ organic: [{ title: 'Oral-B Pro 3 3000 černá', link: 'https://f.test/oral-b-pro-3-3000' }] }));
    }
    const r = routes[url];
    return r ? r() : new Response('nf', { status: 404 });
  };
  return { f, calls };
}

async function collect(gen: AsyncGenerator<SearchEvent>) {
  const events: SearchEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

test('full search: statuses, routes, offers, totals, grouping, politeness', async () => {
  const { f, calls } = site();
  const cache = new MemoryCache();
  const opts = { shops, cache, scheduler: new HostScheduler({ intervalMs: 0 }), location: DEFAULT_LOCATION, providers: [], fetch: f, category: 'all' };
  const events = await collect(runSearch('Oral-B Pro 3 3000', opts));
  assert.equal(events[0].type, 'start');
  assert.equal(events.at(-1)?.type, 'done');
  const results = new Map(events.filter((e): e is Extract<SearchEvent, { type: 'shop' }> => e.type === 'shop').map((e) => [e.result.shopId, e.result]));
  assert.equal(results.size, 6, 'out-of-scope shop skipped');
  const st = (id: string) => (results.get(id) as ShopResult).status;
  assert.equal(st('a'), 'ok');
  assert.equal(st('b'), 'needs_search_key');
  assert.equal(st('c'), 'blocked');
  assert.equal(st('d'), 'needs_js');
  assert.equal(st('e'), 'no_route');
  assert.equal(st('f'), 'needs_search_key');
  // manual links for shops without offers that have a template
  assert.equal(results.get('b')?.manualUrl, 'https://b.test/search?q=Oral-B+Pro+3+3000');
  assert.equal(results.get('d')?.manualUrl, 'https://d.test/s?q=Oral-B+Pro+3+3000');
  // the Duopack candidate was not fetched; disallowed search URLs were never fetched
  assert.ok(!calls.includes('https://a.test/p/duo'));
  assert.ok(!calls.some((u) => u.startsWith('https://b.test/search') || u.startsWith('https://f.test/hledat')));
  assert.ok(!calls.some((u) => u.startsWith('https://d.test')), 'needs_js shop not fetched');
  assert.ok(!calls.some((u) => u.includes('heureka')), 'Heureka is never fetched');
  for (const r of results.values()) assert.ok(r.requestsUsed <= 6);
  const a = results.get('a') as ShopResult;
  assert.equal(a.section, 'local');
  assert.equal(a.offers.length, 2);
  assert.ok(a.offers.every((o) => o.totals.totalEur === null && o.totals.itemEur !== null), 'unknown shipping stays unknown');
  const products = events.filter((e): e is Extract<SearchEvent, { type: 'products' }> => e.type === 'products').at(-1);
  assert.equal(products?.groups[0].variants.length, 2, 'black and white side by side');
  const start = events[0] as Extract<SearchEvent, { type: 'start' }>;
  assert.match(start.heurekaUrl, /^https:\/\/www\.heureka\.sk\/\?h%5Bfraze%5D=Oral-B\+Pro\+3\+3000$/);

  // second search: the blocked shop is skipped without any request, everything else from the cache
  const before = calls.length;
  const again = await collect(runSearch('Oral-B Pro 3 3000', opts));
  const c2 = again.find((e) => e.type === 'shop' && e.result.shopId === 'c') as Extract<SearchEvent, { type: 'shop' }>;
  assert.equal(c2.result.status, 'blocked');
  assert.equal(c2.result.requestsUsed, 0);
  assert.equal(calls.length, before, 'no new requests at all on a repeated search');
});

test('with a search provider: robots-disallowed shop found via a site: query, CZK converted, SK shipping from JSON-LD', async () => {
  const { f, calls } = site();
  const events = await collect(runSearch('Oral-B Pro 3 3000', {
    shops: shops.filter((s) => s.id === 'f' || s.id === 'a'), cache: new MemoryCache(), scheduler: new HostScheduler({ intervalMs: 0 }),
    location: DEFAULT_LOCATION, providers: [new SerperProvider('test')], fetch: f, category: 'all',
  }));
  const r = (events.find((e) => e.type === 'shop' && e.result.shopId === 'f') as Extract<SearchEvent, { type: 'shop' }>).result;
  assert.equal(r.status, 'ok');
  assert.equal(r.route, 'search_provider');
  const o = r.offers[0];
  assert.equal(o.totals.itemEur, 52.81);
  assert.equal(o.totals.shippingEur, 4.05);
  assert.equal(o.totals.totalEur, 56.86);
  assert.equal(calls.filter((u) => u.includes('serper')).length, 1, 'shop A declined, one query for F');
  const done = events.at(-1) as Extract<SearchEvent, { type: 'done' }>;
  assert.equal(done.summary.providerCalls.length, 1);
});

// ---- second route: own search found nothing matching -> web search ---------------------------------

const Q = 'Oral-B Pro 3 3000';
const QS = 'Oral-B+Pro+3+3000';
const list = (...items: [string, string][]) => `<html><script type="application/ld+json">{"@type":"ItemList","itemListElement":[${
  items.map(([name, url]) => `{"@type":"ListItem","item":{"@type":"Product","name":"${name}","url":"${url}"}}`).join(',')}]}</script></html>`;
const robotsOk = () => new Response('User-agent: *\nDisallow: /cart');

const { shops: fbShops } = validateShops({
  shops: ['g', 'h', 'j', 'k', 'm'].map((id) => ({
    id, name: `Shop ${id.toUpperCase()}`, domain: `${id}.test`, country: 'SK', currency: 'EUR', search_url_template: `https://${id}.test/s?q={query}`,
  })),
});

function fallbackSite(serper: (q: string) => Response) {
  const calls: string[] = [];
  const serperQueries: string[] = [];
  const routes: Record<string, () => Response> = {
    'https://api.frankfurter.dev/v2/providers/ecb/rates?base=EUR&quotes=CZK': () => new Response('[]'),
    // g: the own search lists nothing; the web search finds the product.
    'https://g.test/robots.txt': robotsOk,
    [`https://g.test/s?q=${QS}`]: () => new Response('<html><body><p>Nenašli sme žiadne produkty.</p></body></html>'),
    'https://g.test/oral-b-pro-3-3000-cierna': () => new Response(product('Oral-B Pro 3 3000 čierna', 59.9, '8006540759790')),
    // h: the own search lists a page that turns out to be another model; the web search finds the model,
    // with a tracking parameter, and the page the first route already read.
    'https://h.test/robots.txt': () => new Response('User-agent: *\nDisallow: /*srsltid='),
    [`https://h.test/s?q=${QS}`]: () => new Response(list(['Oral-B Pro 3 3000 Black', 'https://h.test/p/old'])),
    'https://h.test/p/old': () => new Response(product('Oral-B Pro 3 3500 Black', 64.9, '8006540760000')),
    'https://h.test/p/new': () => new Response(product('Oral-B Pro 3 3000 Cross Action čierna', 61.5, '8006540759790')),
    // j: the own search finds the product, but its page has no schema.org data -> needs_js, no second route.
    'https://j.test/robots.txt': robotsOk,
    [`https://j.test/s?q=${QS}`]: () => new Response(list(['Oral-B Pro 3 3000', 'https://j.test/p/1'])),
    'https://j.test/p/1': () => new Response('<html><body>price rendered later</body></html>'),
    // k: bot protection on the search page -> blocked, no second route.
    'https://k.test/robots.txt': robotsOk,
    [`https://k.test/s?q=${QS}`]: () => new Response('<title>Just a moment...</title>', { status: 403 }),
    // m: the own search uses 5 of the 6 requests (robots, search, 3 pages, all another model).
    'https://m.test/robots.txt': robotsOk,
    [`https://m.test/s?q=${QS}`]: () => new Response(list(['Oral-B Pro 3 3000 A', 'https://m.test/p/a'], ['Oral-B Pro 3 3000 B', 'https://m.test/p/b'], ['Oral-B Pro 3 3000 C', 'https://m.test/p/c'])),
    'https://m.test/p/a': () => new Response(product('Oral-B Pro 3 3500 A', 70, '8006540761001')),
    'https://m.test/p/b': () => new Response(product('Oral-B Pro 3 3500 B', 70, '8006540761002')),
    'https://m.test/p/c': () => new Response(product('Oral-B Pro 3 3500 C', 70, '8006540761003')),
    'https://m.test/p/q1': () => new Response(product('Oral-B Pro 3 3000 Black', 58, '8006540759790')),
    'https://m.test/p/q2': () => new Response(product('Oral-B Pro 3 3000 White', 58, '8006540760161')),
  };
  const f: FetchLike = async (url, init) => {
    if (url === 'https://google.serper.dev/search') {
      const q = JSON.parse(String(init?.body)).q as string;
      serperQueries.push(q);
      return serper(q);
    }
    calls.push(url);
    const r = routes[url];
    return r ? r() : new Response('nf', { status: 404 });
  };
  return { f, calls, serperQueries };
}

const organic = (...links: [string, string][]) => new Response(JSON.stringify({ organic: links.map(([title, link]) => ({ title, link })) }));
const allHits = () => organic(
  ['Oral-B Pro 3 3000 čierna', 'https://g.test/oral-b-pro-3-3000-cierna'],
  ['Oral-B Pro 3 3000 Black', 'https://h.test/p/old'],
  ['Oral-B Pro 3 3000 Cross Action', 'https://h.test/p/new?srsltid=AfmBOo123'],
  ['Oral-B Pro 3 3000 Black', 'https://m.test/p/q1'],
  ['Oral-B Pro 3 3000 White', 'https://m.test/p/q2'],
);

async function fallbackRun(f: FetchLike, ids: string[], providers = [new SerperProvider('test')]) {
  const events = await collect(runSearch(Q, {
    shops: fbShops.filter((s) => ids.includes(s.id)), cache: new MemoryCache(), scheduler: new HostScheduler({ intervalMs: 0 }),
    location: DEFAULT_LOCATION, providers, fetch: f, category: 'all', fallbackDeadlineMs: 50,
  }));
  const results = new Map(events.filter((e): e is Extract<SearchEvent, { type: 'shop' }> => e.type === 'shop').map((e) => [e.result.shopId, e.result]));
  const done = (events.at(-1) as Extract<SearchEvent, { type: 'done' }>).summary;
  const products = events.filter((e): e is Extract<SearchEvent, { type: 'products' }> => e.type === 'products');
  return { results, done, products };
}

test('second route: own search found nothing matching -> one batched web search for those shops; others do not get it', async () => {
  const { f, calls, serperQueries } = fallbackSite(allHits);
  const { results, done } = await fallbackRun(f, ['g', 'h', 'j', 'k']);
  const g = results.get('g') as ShopResult;
  const h = results.get('h') as ShopResult;
  assert.equal(g.status, 'ok');
  assert.equal(g.route, 'both');
  assert.match(g.detail, /both routes tried/);
  assert.match(g.detail, /shop search: the shop search returned no products/);
  assert.equal(h.status, 'ok');
  assert.equal(h.route, 'both');
  // the uncertain match stays "possible"
  assert.match(h.detail, /0 exact, 1 possible/);
  assert.ok(h.offers.some((o) => o.url === 'https://h.test/p/new' && o.match.level === 'possible'));
  // one query for both shops (several site: domains), none for the needs_js and the blocked shop
  assert.equal(serperQueries.length, 1);
  assert.match(serperQueries[0], /site:g\.test OR site:h\.test$/);
  assert.equal(results.get('j')?.status, 'needs_js');
  assert.equal(results.get('k')?.status, 'blocked');
  assert.equal(done.fallbackQueries, 1);
  assert.equal(done.fallbackShops, 2);
  assert.equal(done.siteQueries, 1, 'no first-route query: every shop used its own search');
  // the page read by the first route is not fetched again; the tracking parameter is dropped
  assert.equal(calls.filter((u) => u === 'https://h.test/p/old').length, 1);
  assert.ok(calls.includes('https://h.test/p/new'));
  assert.ok(!calls.some((u) => u.includes('srsltid')));
  assert.match(h.detail, /already read in this search/);
});

test('second route: the 6-request budget holds across both routes', async () => {
  const { f, calls } = fallbackSite(allHits);
  const { results } = await fallbackRun(f, ['m']);
  const m = results.get('m') as ShopResult;
  assert.equal(m.requestsUsed, 6);
  assert.equal(calls.filter((u) => u.startsWith('https://m.test/')).length, 6);
  assert.ok(calls.includes('https://m.test/p/q1'));
  assert.ok(!calls.includes('https://m.test/p/q2'), 'no seventh request');
  assert.equal(m.status, 'ok');
  assert.match(m.detail, /request budget \(6 per shop\) reached/);
});

test('products event: similar models from the pages that turned out to be another model; count in the summary', async () => {
  const { f, calls } = fallbackSite(allHits);
  const { products, done } = await fallbackRun(f, ['g', 'h', 'm']);
  const before = calls.length;
  assert.ok(products.length >= 3, 'one products event per finished shop');
  assert.ok(products.every((p) => Array.isArray(p.nearby.models) && typeof p.nearby.total === 'number'));
  const { nearby } = products.at(-1) as Extract<SearchEvent, { type: 'products' }>;
  // H's page /p/old and M's three pages were the 3500: one model, two shops, the lowest price seen.
  assert.equal(nearby.total, 1);
  const model = nearby.models[0];
  assert.equal(model.query, 'Oral-B Pro 3 3500');
  assert.deepEqual(model.shops.map((s) => s.shopId).sort(), ['h', 'm']);
  assert.equal(model.differs, 'has "3500", lacks "3000"');
  assert.deepEqual(model.seenPrice, { eur: 64.9, shopName: 'Shop H', url: 'https://h.test/p/old', from: 'search' });
  assert.equal(done.nearby, 1);
  assert.equal(done.nearbyPrices, 0, 'G has the exact model: no price reads');
  assert.equal(calls.length, before, 'no request after the search');
});

test('second route: nothing found either -> no_match that names both routes; no provider -> first-route no_match', async () => {
  const empty = fallbackSite(() => organic());
  const { results } = await fallbackRun(empty.f, ['g']);
  const g = results.get('g') as ShopResult;
  assert.equal(g.status, 'no_match');
  assert.equal(g.route, 'both');
  assert.match(g.detail, /^both routes tried, nothing matching: shop search: .*; serper web search: the web search returned no pages on this domain/);

  const none = fallbackSite(allHits);
  const r2 = await fallbackRun(none.f, ['g'], []);
  assert.equal(r2.results.get('g')?.status, 'no_match');
  assert.equal(r2.results.get('g')?.route, 'shop_search');
  assert.equal(none.serperQueries.length, 0);

  const broke = fallbackSite(() => new Response('{"message":"Not enough credits"}', { status: 400 }));
  const r3 = await fallbackRun(broke.f, ['g']);
  assert.equal(r3.results.get('g')?.status, 'no_match');
  assert.match(r3.results.get('g')?.detail ?? '', /web search route could not be tried: serper: Serper credits used up/);
});

test('pages without product data at a shop known to publish it: no_match (not needs_js), and the second route is tried', async () => {
  // j's own search lists a page without schema.org data. Once a j product page with data has been seen
  // (remembered in the cache), that page is taken for a non-product page.
  const { f, serperQueries } = fallbackSite(() => organic(['Oral-B Pro 3 3000', 'https://j.test/p/real']));
  const routes: Record<string, () => Response> = { 'https://j.test/p/real': () => new Response(product('Oral-B Pro 3 3000 čierna', 60, '8006540759790')) };
  const f2: FetchLike = async (url, init) => (routes[url] ? routes[url]() : f(url, init));
  const cache = new MemoryCache();
  await cache.set('structured_data', 'j', { at: '2026-11-24T00:00:00Z' });
  const events = await collect(runSearch(Q, {
    shops: fbShops.filter((s) => s.id === 'j'), cache, scheduler: new HostScheduler({ intervalMs: 0 }),
    location: DEFAULT_LOCATION, providers: [new SerperProvider('test')], fetch: f2, category: 'all', fallbackDeadlineMs: 50,
  }));
  const j = (events.find((e) => e.type === 'shop') as Extract<SearchEvent, { type: 'shop' }>).result;
  assert.equal(j.status, 'ok');
  assert.equal(j.route, 'both');
  assert.match(j.detail, /shop search: fetched 1 page\(s\) without schema\.org Product data; this shop's product pages carry it/);
  assert.equal(serperQueries.length, 1);

  // The mark is written when a page with data is read, so the next search knows it.
  const c2 = new MemoryCache();
  const { f: f3 } = fallbackSite(allHits);
  await collect(runSearch(Q, {
    shops: fbShops.filter((s) => s.id === 'g'), cache: c2, scheduler: new HostScheduler({ intervalMs: 0 }),
    location: DEFAULT_LOCATION, providers: [new SerperProvider('test')], fetch: f3, category: 'all', fallbackDeadlineMs: 50,
  }));
  assert.ok(await c2.get('structured_data', 'g'));
});

test('dedupeOffers: one offer per page and price; different seller, price or GTIN stay apart', () => {
  // Datart, 2026-11-24: the product page, the same page with ltm_ tracking parameters and its /navod/ manual
  // page (no GTIN, no seller) gave three copies of one offer.
  const base = {
    shopId: 'datart_cz', url: 'https://www.datart.cz/zubni-kartacek-oral-b-io-series-3-ice-blue.html', title: 'Zubní kartáček Oral-B iO Series 3 Ice Blue',
    brand: 'Oral-B', gtin: '08006540731321', sku: 'BRAIO3ICEBLUE', mpn: null, color: null, price: 1590, currency: 'CZK', availability: 'InStock',
    itemCondition: 'NewCondition', seller: 'DATART', shipping: [], source: 'Product',
  };
  const manual = { ...base, brand: null, gtin: null, sku: null, seller: null, itemCondition: null };
  const tracked = { ...base, url: `${base.url}?ltm_source=letak&ltm_medium=interni` };
  const out = dedupeOffers([manual, base, tracked]);
  assert.equal(out.length, 1);
  assert.equal(out[0].gtin, '08006540731321', 'the merged offer keeps the GTIN');
  assert.equal(out[0].seller, 'DATART');
  assert.equal(dedupeOffers([base, { ...base, seller: 'Other seller' }]).length, 2);
  assert.equal(dedupeOffers([base, { ...base, price: 1490 }]).length, 2);
  assert.equal(dedupeOffers([base, { ...base, gtin: '08006540731222' }]).length, 2);
});

test('provider out of credit: shops get needs_search_key with the reason', async () => {
  const f: FetchLike = async (url) => {
    if (url.includes('serper')) return new Response('{"message":"Not enough credits"}', { status: 400 });
    if (url.endsWith('robots.txt')) return new Response('User-agent: *\nDisallow: /hledat');
    return new Response('[]');
  };
  const events = await collect(runSearch('x 1', {
    shops: shops.filter((s) => s.id === 'f'), cache: new MemoryCache(), scheduler: new HostScheduler({ intervalMs: 0 }),
    location: DEFAULT_LOCATION, providers: [new SerperProvider('test')], fetch: f, category: 'all',
  }));
  const r = (events.find((e) => e.type === 'shop') as Extract<SearchEvent, { type: 'shop' }>).result;
  assert.equal(r.status, 'needs_search_key');
  assert.match(r.detail, /credits used up/);
});

// ---- a brand typo in the query ----------------------------------------------------------------------

test('a brand typo: the corrected query is searched and both forms are in the stream; as typed on request', async () => {
  const { shops: typoShops } = validateShops({
    shops: [{ id: 't', name: 'Shop T', domain: 't.test', country: 'SK', currency: 'EUR', categories: ['drugstore'], search_url_template: 'https://t.test/s?q={query}' }],
  });
  const calls: string[] = [];
  const f: FetchLike = async (url) => {
    calls.push(url);
    if (url === 'https://t.test/robots.txt') return robotsOk();
    if (url === 'https://t.test/s?q=Oral-B+io9+doublepack') return new Response(list(['Oral-B iO Series 9 Duo, 2 ks', 'https://t.test/p/io9-duo']));
    if (url === 'https://t.test/p/io9-duo') return new Response(product('Zubná kefka Oral-B iO Series 9 Duo, 2 ks', 449, '8006540900001'));
    return new Response('nf', { status: 404 });
  };
  const run = (asTyped: boolean) => collect(runSearch('Iral b io9 doublepack', {
    shops: typoShops, cache: new MemoryCache(), scheduler: new HostScheduler({ intervalMs: 0 }), location: DEFAULT_LOCATION, providers: [], fetch: f, asTyped,
  }));

  const events = await run(false);
  const start = events[0] as Extract<SearchEvent, { type: 'start' }>;
  assert.deepEqual([start.query, start.typed, start.corrected], ['Oral-B io9 doublepack', 'Iral b io9 doublepack', true]);
  assert.ok(start.categories.reasons.includes('electric toothbrush / shaver'), 'the category guess runs on the corrected query');
  assert.match(start.heurekaUrl, /Oral-B\+io9\+doublepack$/);
  assert.ok(calls.includes('https://t.test/s?q=Oral-B+io9+doublepack'), 'the shop search gets the corrected query, the pack word as typed');
  const t = (events.find((e) => e.type === 'shop') as Extract<SearchEvent, { type: 'shop' }>).result;
  assert.equal(t.status, 'ok');
  assert.equal(t.offers[0].match.level, 'exact');
  const done = (events.at(-1) as Extract<SearchEvent, { type: 'done' }>).summary;
  assert.deepEqual([done.query, done.typed], ['Oral-B io9 doublepack', 'Iral b io9 doublepack']);

  calls.length = 0;
  const asTyped = await run(true);
  const start2 = asTyped[0] as Extract<SearchEvent, { type: 'start' }>;
  assert.deepEqual([start2.query, start2.typed, start2.corrected], ['Iral b io9 doublepack', 'Iral b io9 doublepack', false]);
  assert.ok(calls.includes('https://t.test/s?q=Iral+b+io9+doublepack'));
  assert.ok(!calls.some((u) => u.includes('Oral-B')));
});

// ---- a pasted product link ----------------------------------------------------------------------------

test('a pasted link: its name is searched, the link itself is never requested, the events carry the pasted text', async () => {
  const { shops: linkShops } = validateShops({
    shops: [{ id: 'z', name: 'Shop Z', domain: 'z.test', country: 'SK', currency: 'EUR', search_url_template: 'https://www.z.test/s?q={query}' }],
  });
  const pasted = 'https://www.z.test/roborock-qrevo-edge-2-pro-d13260955.htm?utm_source=newsletter#reviews';
  const calls: string[] = [];
  const f: FetchLike = async (url) => {
    calls.push(url);
    if (url === 'https://www.z.test/robots.txt') return robotsOk();
    if (url === 'https://www.z.test/s?q=Roborock+Qrevo+Edge+2+Pro') return new Response('<html><body><p>Nenašli sme žiadne produkty.</p></body></html>');
    return new Response('nf', { status: 404 });
  };
  const events = await collect(runSearch(pasted, {
    shops: linkShops, cache: new MemoryCache(), scheduler: new HostScheduler({ intervalMs: 0 }), location: DEFAULT_LOCATION, providers: [], fetch: f,
    category: 'all', asTyped: true,
  }));
  const start = events[0] as Extract<SearchEvent, { type: 'start' }>;
  assert.deepEqual([start.query, start.typed, start.fromLink, start.corrected, start.linkShop], ['Roborock Qrevo Edge 2 Pro', pasted, true, false, 'Shop Z']);
  // the shop of the link is asked like any other: robots.txt and its search page with the name, nothing else
  assert.deepEqual(calls, ['https://www.z.test/robots.txt', 'https://www.z.test/s?q=Roborock+Qrevo+Edge+2+Pro']);
  assert.ok(!calls.some((u) => /d13260955|utm_|newsletter|reviews/.test(u)), 'nothing of the link but the name goes out');
  const done = (events.at(-1) as Extract<SearchEvent, { type: 'done' }>).summary;
  assert.deepEqual([done.query, done.typed], ['Roborock Qrevo Edge 2 Pro', pasted]);
});

test('a pasted title with its specification list: the name is searched and the start event says so; as typed searches it all', async () => {
  const { shops: listShops } = validateShops({
    shops: [{ id: 'z', name: 'Shop Z', domain: 'z.test', country: 'SK', currency: 'EUR', search_url_template: 'https://www.z.test/s?q={query}' }],
  });
  // ASBIS SK's title of the configuration, as the owner pasted it on 2026-11-27
  const pasted = 'HP Z2 Tower G1i, Ultra9 285K/vPro, RTXPRO4000Blw/24GB, 32GB, SSD 1TB, W11Pro, 3-3-3, WiFi/BT';
  const calls: string[] = [];
  const f: FetchLike = async (url) => {
    calls.push(url);
    if (url === 'https://www.z.test/robots.txt') return robotsOk();
    if (url.startsWith('https://www.z.test/s?q=')) return new Response('<html><body><p>Nenašli sme žiadne produkty.</p></body></html>');
    return new Response('nf', { status: 404 });
  };
  const run = (asTyped: boolean) => collect(runSearch(pasted, {
    shops: listShops, cache: new MemoryCache(), scheduler: new HostScheduler({ intervalMs: 0 }), location: DEFAULT_LOCATION, providers: [], fetch: f,
    category: 'all', asTyped,
  }));
  const start = (await run(false))[0] as Extract<SearchEvent, { type: 'start' }>;
  assert.deepEqual([start.query, start.typed, start.fromList, start.fromLink], ['HP Z2 Tower G1i', pasted, true, false]);
  assert.ok(calls.includes('https://www.z.test/s?q=HP+Z2+Tower+G1i'));
  calls.length = 0;
  const whole = (await run(true))[0] as Extract<SearchEvent, { type: 'start' }>;
  assert.deepEqual([whole.query, whole.fromList], [pasted, false]);
  assert.ok(!calls.includes('https://www.z.test/s?q=HP+Z2+Tower+G1i'));
});

test('a pasted link without the name: no search, no request, one event that asks for the name', async () => {
  const calls: string[] = [];
  const f: FetchLike = async (url) => {
    calls.push(url);
    return new Response('nf', { status: 404 });
  };
  const events = await collect(runSearch('https://www.amazon.de/dp/B0C1234567', {
    shops, cache: new MemoryCache(), scheduler: new HostScheduler({ intervalMs: 0 }), location: DEFAULT_LOCATION, providers: [], fetch: f, category: 'all',
  }));
  assert.equal(events.length, 1);
  const ev = events[0] as Extract<SearchEvent, { type: 'rejected' }>;
  assert.equal(ev.type, 'rejected');
  assert.equal(ev.typed, 'https://www.amazon.de/dp/B0C1234567');
  assert.match(ev.message, /does not contain the product's name/);
  assert.deepEqual(calls, []);
});

// ---- the text a shop in another country receives ---------------------------------------------------------

test('home shop gets the query as typed (then the core query once); a shop abroad gets the core query; offers judged by the full query', async () => {
  const { shops: twoShops } = validateShops({
    shops: [
      { id: 'hs', name: 'Home Shop', domain: 'hs.test', country: 'SK', currency: 'EUR', search_url_template: 'https://hs.test/s?q={query}' },
      { id: 'fc', name: 'Foreign Shop', domain: 'fc.test', country: 'CZ', currency: 'EUR', search_url_template: 'https://fc.test/hledat?q={query}' },
    ],
  });
  const typed = 'Oral-B iO Series 9 čierna zubná kefka';
  const full = buildSearchUrl('https://hs.test/s?q={query}', typed);
  const both = list(['Oral-B iO Series 9 Black', '/p/black'], ['Oral-B iO Series 9 White', '/p/white']);
  const calls: string[] = [];
  const f: FetchLike = async (url) => {
    calls.push(url);
    if (url.endsWith('/robots.txt')) return robotsOk();
    if (url === full) return new Response('<html><body><p>Nenašli sme žiadne produkty.</p></body></html>');
    if (url === 'https://hs.test/s?q=Oral-B+iO+Series+9' || url === 'https://fc.test/hledat?q=Oral-B+iO+Series+9') {
      return new Response(both.replace(/"\/p\//g, `"https://${new URL(url).host}/p/`));
    }
    if (url.endsWith('/p/black')) return new Response(product('Oral-B iO Series 9 Black', 299, '8006540900201'));
    if (url.endsWith('/p/white')) return new Response(product('Oral-B iO Series 9 White', 289, '8006540900202'));
    return new Response('nf', { status: 404 });
  };
  const events = await collect(runSearch(typed, {
    shops: twoShops, cache: new MemoryCache(), scheduler: new HostScheduler({ intervalMs: 0 }), location: DEFAULT_LOCATION, providers: [], fetch: f, category: 'all',
  }));
  const results = new Map(events.filter((e): e is Extract<SearchEvent, { type: 'shop' }> => e.type === 'shop').map((e) => [e.result.shopId, e.result]));
  const hs = results.get('hs') as ShopResult;
  const fc = results.get('fc') as ShopResult;
  // what each was sent
  assert.ok(calls.includes(full), 'the home shop gets the query as typed');
  assert.ok(calls.includes('https://hs.test/s?q=Oral-B+iO+Series+9'), 'then, with no products, the core query once');
  assert.ok(calls.includes('https://fc.test/hledat?q=Oral-B+iO+Series+9'), 'the shop abroad gets the core query');
  assert.ok(!calls.some((u) => u.startsWith('https://fc.test/hledat') && /kefka|ierna/i.test(decodeURIComponent(u))), 'no Slovak words abroad');
  assert.equal(calls.filter((u) => u.startsWith('https://fc.test/hledat')).length, 1, 'no retry abroad: it already got the core query');
  assert.match(hs.detail, /repeated as "Oral-B iO Series 9"/);
  assert.match(fc.detail, /searched as "Oral-B iO Series 9": the query without its category, colour and generic words, for a shop in another country/);
  assert.equal(hs.manualUrl, full);
  assert.equal(fc.manualUrl, 'https://fc.test/hledat?q=Oral-B+iO+Series+9', 'the manual link uses the text the shop was sent');
  // the colour the user asked for still decides: black matches, white only possibly
  for (const r of [hs, fc]) {
    assert.equal(r.offers.find((o) => o.title.endsWith('Black'))?.match.level, 'exact', r.shopId);
    assert.equal(r.offers.find((o) => o.title.endsWith('White'))?.match.level, 'possible', r.shopId);
  }
});

// ---- the shop search finds nothing for a pack word: once more without it -------------------------------

function packSite() {
  const calls: string[] = [];
  const f: FetchLike = async (url) => {
    calls.push(url);
    if (url === 'https://u.test/robots.txt') return robotsOk();
    if (url === 'https://u.test/s?q=Oral-B+io9') {
      return new Response(list(
        ['Súprava zubných kefiek Oral-B iO9 Series Duo Pack Black', 'https://u.test/p/duo'],
        ['Zubná kefka Oral-B iO9 Series Black', 'https://u.test/p/single'],
      ));
    }
    if (url === 'https://u.test/p/duo') return new Response(product('Súprava zubných kefiek Oral-B iO9 Series Duo Pack Black', 499, '8006540900101'));
    if (url === 'https://u.test/p/single') return new Response(product('Zubná kefka Oral-B iO9 Series Black', 299, '8006540900102'));
    // every other search: no products
    if (url.startsWith('https://u.test/s?q=')) return new Response('<html><body><p>Nenašli sme žiadne produkty.</p></body></html>');
    return new Response('nf', { status: 404 });
  };
  return { f, calls };
}

const { shops: packShops } = validateShops({
  shops: [{ id: 'u', name: 'Shop U', domain: 'u.test', country: 'SK', currency: 'EUR', search_url_template: 'https://u.test/s?q={query}' }],
});

async function packRun(q: string, f: FetchLike, cache = new MemoryCache()) {
  const events = await collect(runSearch(q, {
    shops: packShops, cache, scheduler: new HostScheduler({ intervalMs: 0 }), location: DEFAULT_LOCATION, providers: [], fetch: f, category: 'all',
  }));
  return (events.find((e) => e.type === 'shop') as Extract<SearchEvent, { type: 'shop' }>).result;
}

test('own search returned no products for a query with a package word: asked once more without it; the duo is read, the single is not', async () => {
  const { f, calls } = packSite();
  const cache = new MemoryCache();
  const u = await packRun('Oral-B io9 doublepack', f, cache);
  assert.equal(u.status, 'ok');
  assert.deepEqual(u.offers.map((o) => [o.url, o.match.level]), [['https://u.test/p/duo', 'exact']]);
  assert.ok(!calls.includes('https://u.test/p/single'), 'the single brush is scored against the full query and not read');
  assert.deepEqual(calls, ['https://u.test/robots.txt', 'https://u.test/s?q=Oral-B+io9+doublepack', 'https://u.test/s?q=Oral-B+io9', 'https://u.test/p/duo']);
  assert.equal(u.requestsUsed, 4, 'the repeated search counts in the budget');
  assert.match(u.detail, /the shop search returned no products for "Oral-B io9 doublepack"; repeated as "Oral-B io9" \(without category, colour, generic and package words\): 2 result\(s\)/);

  // the same search again within 6 hours: everything from the cache, the detail still says it
  calls.length = 0;
  const again = await packRun('Oral-B io9 doublepack', f, cache);
  assert.equal(again.status, 'ok');
  assert.equal(again.requestsUsed, 0);
  assert.deepEqual(calls, []);
  assert.match(again.detail, /repeated as "Oral-B io9" \(without category, colour, generic and package words\): 2 result\(s\) \(from cache\)/);
});

test('repeated search: also after an empty first answer from the cache; once only; not without a package word', async () => {
  // an empty answer cached by an earlier search does not prevent the repeated search
  const { f, calls } = packSite();
  const cache = new MemoryCache();
  await cache.set('candidates', 'u|oral-b io9 doublepack|none|combined', { route: 'shop_search', candidates: [] });
  const u = await packRun('Oral-B io9 doublepack', f, cache);
  assert.equal(u.status, 'ok');
  assert.ok(calls.includes('https://u.test/s?q=Oral-B+io9'));
  assert.ok(!calls.includes('https://u.test/s?q=Oral-B+io9+doublepack'), 'the first answer came from the cache');

  // the repeated search finds nothing either: no third search, and the detail says it was repeated
  const empty = packSite();
  const series = await packRun('Oral-B iO Series 9 Duo', empty.f);
  assert.equal(series.status, 'no_match');
  assert.deepEqual(empty.calls, ['https://u.test/robots.txt', 'https://u.test/s?q=Oral-B+iO+Series+9+Duo', 'https://u.test/s?q=Oral-B+iO+Series+9']);
  assert.match(series.detail, /repeated as "Oral-B iO Series 9" \(without category, colour, generic and package words\): 0 result\(s\)/);

  // a query without a package word: no repeated search
  const plain = packSite();
  const single = await packRun('Oral-B iO Series 9', plain.f);
  assert.equal(single.status, 'no_match');
  assert.deepEqual(plain.calls, ['https://u.test/robots.txt', 'https://u.test/s?q=Oral-B+iO+Series+9']);
  assert.doesNotMatch(single.detail, /repeated/);
});

// ---- prices for the similar-models list -------------------------------------------------------------

const { shops: priceShops } = validateShops({
  shops: [
    // K and N have a branch in the city, so they come first when a listing is picked.
    { id: 'k', name: 'Shop K', domain: 'k.test', country: 'SK', currency: 'EUR', has_kosice_branch: true, search_url_template: 'https://k.test/s?q={query}' },
    { id: 'n', name: 'Shop N', domain: 'n.test', country: 'SK', currency: 'EUR', has_kosice_branch: true, search_url_template: 'https://n.test/s?q={query}' },
    { id: 'p', name: 'Shop P', domain: 'p.test', country: 'SK', currency: 'EUR', ships_to_sk: true, search_url_template: 'https://p.test/s?q={query}' },
    { id: 'q', name: 'Shop Q', domain: 'q.test', country: 'SK', currency: 'EUR', search_url_template: 'https://q.test/s?q={query}' },
    { id: 'a2', name: 'Shop A2', domain: 'a2.test', country: 'SK', currency: 'EUR', search_url_template: 'https://a2.test/s?q={query}' },
    { id: 'r', name: 'Shop R', domain: 'r.test', country: 'SK', currency: 'EUR', search_url_template: 'https://r.test/s?q={query}' },
  ],
});

function priceSite() {
  const calls: string[] = [];
  const routes: Record<string, () => Response> = {
    'https://api.frankfurter.dev/v2/providers/ecb/rates?base=EUR&quotes=CZK': () => new Response('[]'),
    // K: the product page that matches the query is behind bot protection -> blocked; it also lists the 3500.
    'https://k.test/robots.txt': robotsOk,
    [`https://k.test/s?q=${QS}`]: () => new Response(list(['Oral-B Pro 3 3000 Black', 'https://k.test/p/1'], ['Oral-B Pro 3 3500 Black', 'https://k.test/p/3500'])),
    'https://k.test/p/1': () => new Response('<title>Just a moment...</title>', { status: 403 }),
    'https://k.test/p/3500': () => new Response(product('Oral-B Pro 3 3500 Black', 60, '8006540762001')),
    // N: robots.txt redirects (2 requests), the search, three pages of possible matches: 6 of 6 used. It also lists the 3600.
    'https://n.test/robots.txt': () => new Response('', { status: 301, headers: { location: 'https://n.test/robots2.txt' } }),
    'https://n.test/robots2.txt': robotsOk,
    [`https://n.test/s?q=${QS}`]: () => new Response(list(
      ['Oral-B Pro 3 3000 Cross Action A', 'https://n.test/p/a'], ['Oral-B Pro 3 3000 Cross Action B', 'https://n.test/p/b'],
      ['Oral-B Pro 3 3000 Cross Action C', 'https://n.test/p/c'], ['Oral-B Pro 3 3600 Black', 'https://n.test/p/3600'])),
    'https://n.test/p/a': () => new Response(product('Oral-B Pro 3 3000 Cross Action A', 58, '8006540763001')),
    'https://n.test/p/b': () => new Response(product('Oral-B Pro 3 3000 Cross Action B', 58, '8006540763002')),
    'https://n.test/p/c': () => new Response(product('Oral-B Pro 3 3000 Cross Action C', 58, '8006540763003')),
    'https://n.test/p/3600': () => new Response(product('Oral-B Pro 3 3600 Black', 70, '8006540763004')),
    // P: lists the 3500 and the 3600, nothing matching.
    'https://p.test/robots.txt': robotsOk,
    [`https://p.test/s?q=${QS}`]: () => new Response(list(['Oral-B Pro 3 3500 White', 'https://p.test/p/3500'], ['Oral-B Pro 3 3600 White', 'https://p.test/p/3600'])),
    'https://p.test/p/3500': () => new Response(product('Oral-B Pro 3 3500 White', 66.5, '8006540762002')),
    'https://p.test/p/3600': () => new Response(product('Oral-B Pro 3 3600 White', 71, '8006540763005')),
    // Q: the 3500 listing's page turns out to be another model; Q also lists a 3700.
    'https://q.test/robots.txt': robotsOk,
    [`https://q.test/s?q=${QS}`]: () => new Response(list(['Oral-B Pro 3 3500 Black', 'https://q.test/p/x'], ['Oral-B Pro 3 3700 Black', 'https://q.test/p/y'])),
    'https://q.test/p/x': () => new Response(product('Oral-B Pro 3 3900 White', 70, '8006540764001')),
    'https://q.test/p/y': () => new Response(product('Oral-B Pro 3 3700 Black', 69, '8006540764002')),
    // A2: the exact model, and a 3500 listing.
    'https://a2.test/robots.txt': robotsOk,
    [`https://a2.test/s?q=${QS}`]: () => new Response(list(['Oral-B Pro 3 3000 Black', 'https://a2.test/p/1'], ['Oral-B Pro 3 3500 Black', 'https://a2.test/p/3500'])),
    'https://a2.test/p/1': () => new Response(product('Oral-B Pro 3 3000 Black', 59.9, '8006540759790')),
    'https://a2.test/p/3500': () => new Response(product('Oral-B Pro 3 3500 Black', 64, '8006540765001')),
    // R: robots.txt redirects (2 requests), the search, two pages of possible matches: 5 of 6 used. It alone lists the 3500 and the 3600.
    'https://r.test/robots.txt': () => new Response('', { status: 301, headers: { location: 'https://r.test/robots2.txt' } }),
    'https://r.test/robots2.txt': robotsOk,
    [`https://r.test/s?q=${QS}`]: () => new Response(list(
      ['Oral-B Pro 3 3000 Cross Action A', 'https://r.test/p/a'], ['Oral-B Pro 3 3000 Cross Action B', 'https://r.test/p/b'],
      ['Oral-B Pro 3 3500 Black', 'https://r.test/p/3500'], ['Oral-B Pro 3 3600 Black', 'https://r.test/p/3600'])),
    'https://r.test/p/a': () => new Response(product('Oral-B Pro 3 3000 Cross Action A', 58, '8006540766001')),
    'https://r.test/p/b': () => new Response(product('Oral-B Pro 3 3000 Cross Action B', 58, '8006540766002')),
    'https://r.test/p/3500': () => new Response(product('Oral-B Pro 3 3500 Black', 63, '8006540766003')),
    'https://r.test/p/3600': () => new Response(product('Oral-B Pro 3 3600 Black', 68, '8006540766004')),
  };
  // "> url" when a request starts, "< url" when its answer is back; P's 3500 page answers slowly.
  const log: string[] = [];
  const f: FetchLike = async (url) => {
    calls.push(url);
    log.push(`> ${url}`);
    if (url === 'https://p.test/p/3500') await new Promise((r) => setTimeout(r, 30));
    log.push(`< ${url}`);
    const r = routes[url];
    return r ? r() : new Response('nf', { status: 404 });
  };
  return { f, calls, log };
}

async function priceRun(ids: string[]) {
  const { f, calls, log } = priceSite();
  const events = await collect(runSearch(Q, {
    shops: priceShops.filter((s) => ids.includes(s.id)), cache: new MemoryCache(), scheduler: new HostScheduler({ intervalMs: 0 }),
    location: DEFAULT_LOCATION, providers: [], fetch: f, category: 'all',
  }));
  const results = new Map(events.filter((e): e is Extract<SearchEvent, { type: 'shop' }> => e.type === 'shop').map((e) => [e.result.shopId, e.result]));
  const products = events.filter((e): e is Extract<SearchEvent, { type: 'products' }> => e.type === 'products');
  const done = (events.at(-1) as Extract<SearchEvent, { type: 'done' }>).summary;
  const model = (name: string) => products.at(-1)?.nearby.models.find((m) => m.query === name);
  return { calls, log, events, results, products, done, model };
}

test('similar-model prices: one page read for a model, after the shops, with its URL; blocked and spent shops not asked; a shop asked twice reads in sequence', async () => {
  const { calls, log, events, results, products, done, model } = await priceRun(['k', 'n', 'p']);
  assert.equal(results.get('k')?.status, 'blocked');
  assert.equal(results.get('n')?.requestsUsed, 6);
  // The list came first without the price, then once more with it, before "done".
  const last = products.at(-1) as Extract<SearchEvent, { type: 'products' }>;
  const shopEvents = events.map((e, i) => (e.type === 'shop' ? i : -1)).filter((i) => i >= 0);
  assert.ok(events.indexOf(last) > Math.max(...shopEvents) && events.at(-1)?.type === 'done');
  assert.equal(products.at(-2)?.nearby.models.find((m) => m.query === 'Oral-B Pro 3 3500')?.seenPrice, null);
  // The 3500: K has the branch but was blocked, so P was asked.
  assert.deepEqual(model('Oral-B Pro 3 3500')?.seenPrice, { eur: 66.5, shopName: 'Shop P', url: 'https://p.test/p/3500', from: 'list' });
  assert.ok(!calls.includes('https://k.test/p/3500'), 'a blocked shop is not asked');
  // The 3600: N has the branch but no request left, so P is asked again, after its first read is done.
  assert.deepEqual(model('Oral-B Pro 3 3600')?.seenPrice, { eur: 71, shopName: 'Shop P', url: 'https://p.test/p/3600', from: 'list' });
  assert.ok(!calls.includes('https://n.test/p/3600'), 'a shop out of budget is not asked');
  assert.equal(calls.filter((u) => u.startsWith('https://n.test/')).length, 6);
  assert.equal(calls.filter((u) => u === 'https://p.test/p/3500').length, 1);
  assert.equal(calls.filter((u) => u === 'https://p.test/p/3600').length, 1);
  assert.ok(log.indexOf('< https://p.test/p/3500') < log.indexOf('> https://p.test/p/3600'), 'the second read starts after the first one is back');
  // The read offers stay out of the results: no new product, the same offer count.
  assert.equal(results.get('p')?.offers.length, 0);
  assert.deepEqual(last.groups.map((g) => g.id), products.at(-2)?.groups.map((g) => g.id));
  assert.equal(done.offers, 3);
  assert.equal(done.nearbyPrices, 2);
  assert.equal(done.shopRequests, [...results.values()].reduce((a, r) => a + r.requestsUsed, 0) + 2, 'the price reads are counted');
});

test('similar-model prices: a page whose offer is another model gives no price and no second page; the shop is asked again for the next model', async () => {
  const { calls, done, model } = await priceRun(['q']);
  assert.equal(calls.filter((u) => u === 'https://q.test/p/x').length, 1);
  assert.equal(model('Oral-B Pro 3 3500')?.seenPrice, null);
  assert.deepEqual(model('Oral-B Pro 3 3700')?.seenPrice, { eur: 69, shopName: 'Shop Q', url: 'https://q.test/p/y', from: 'list' });
  assert.equal(calls.filter((u) => u === 'https://q.test/p/y').length, 1);
  assert.equal(done.nearbyPrices, 1);
  assert.equal(done.shopRequests, 4, 'robots.txt, the search and one page for each model');
});

test('similar-model prices: a shop with one request left gives the second model no price, without going past the budget', async () => {
  const { calls, results, done, model } = await priceRun(['r']);
  assert.equal(results.get('r')?.requestsUsed, 5);
  assert.deepEqual(model('Oral-B Pro 3 3500')?.seenPrice, { eur: 63, shopName: 'Shop R', url: 'https://r.test/p/3500', from: 'list' });
  assert.equal(model('Oral-B Pro 3 3600')?.seenPrice, null);
  assert.ok(!calls.includes('https://r.test/p/3600'));
  assert.equal(calls.filter((u) => u.startsWith('https://r.test/')).length, 6, 'six requests, no more');
  assert.equal(done.shopRequests, 6);
  assert.equal(done.nearbyPrices, 1);
});

test('similar-model prices: nothing is read when a product matches exactly', async () => {
  const { calls, done, model } = await priceRun(['a2']);
  assert.equal(model('Oral-B Pro 3 3500')?.seenPrice, null, 'the model is listed, without a price');
  assert.ok(!calls.includes('https://a2.test/p/3500'));
  assert.equal(done.nearbyPrices, 0);
});
