// End-to-end search over mocked shops (no network).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HostScheduler, type FetchLike } from '../src/core/http.ts';
import { dedupeOffers, runSearch, type SearchEvent } from '../src/core/pipeline.ts';
import { SerperProvider } from '../src/core/search/serper.ts';
import { DEFAULT_LOCATION, validateShops } from '../src/core/shops.ts';
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
  assert.deepEqual(model.seenPrice, { eur: 64.9, shopName: 'Shop H' });
  assert.equal(done.nearby, 1);
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
