// End-to-end search over mocked shops (no network).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HostScheduler, type FetchLike } from '../src/core/http.ts';
import { runSearch, type SearchEvent } from '../src/core/pipeline.ts';
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
