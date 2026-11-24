import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { parse } from 'yaml';
import { chooseCategories, guessCategories, shopIsRelevant } from '../src/core/categories.ts';
import { HostScheduler, type FetchLike } from '../src/core/http.ts';
import { runSearch, type SearchEvent } from '../src/core/pipeline.ts';
import { notCheckedList, statusSummary } from '../src/core/report.ts';
import { DEFAULT_LOCATION, validateShops } from '../src/core/shops.ts';
import type { ShopResult } from '../src/core/types.ts';
import { MemoryCache } from './helpers.ts';

const realShops = validateShops(parse(readFileSync(new URL('../data/shops.yaml', import.meta.url), 'utf8'))).shops.filter((s) => s.in_scope);
const asked = (q: string) => {
  const c = guessCategories(q);
  return new Set(realShops.filter((s) => shopIsRelevant(s, c.categories)).map((s) => s.id));
};

describe('category guess from the query', () => {
  test('a toothbrush goes to electronics and drugstore shops, not to furniture, DIY or books', () => {
    const c = guessCategories('Oral-B Pro 3 3000');
    assert.deepEqual(new Set(c.categories), new Set(['appliances', 'electronics', 'drugstore', 'pharmacy', 'beauty']));
    const ids = asked('Oral-B Pro 3 3000');
    for (const id of ['nay_sk', 'drmax_sk', 'pilulka_sk', 'dm_sk', 'notino_sk', 'mediamarkt_de', 'amazon_de', 'allegro_sk']) assert.ok(ids.has(id), id);
    for (const id of ['ikea_sk', 'jysk_sk', 'martinus_sk', 'hornbach_sk', 'mountfield_sk', 'sconto_sk', 'obi_sk']) assert.ok(!ids.has(id), id);
  });
  test('an iPhone goes to electronics shops, not to drugstores, pharmacies or the bookshop', () => {
    const ids = asked('iPhone 16 128GB');
    for (const id of ['nay_sk', 'istores_sk', 'alza_sk', 'datart_cz', 'mironet_cz', 'morele_net', 'andreashop_sk']) assert.ok(ids.has(id), id);
    for (const id of ['drmax_sk', 'pilulka_sk', 'dm_sk', 'teta_sk', 'drogerie101_sk', 'martinus_sk', 'ikea_sk', 'hornbach_sk']) assert.ok(!ids.has(id), id);
  });
  test('a Bosch Professional drill goes to DIY and electronics shops', () => {
    const c = guessCategories('Bosch GSR 12V-15');
    assert.deepEqual(new Set(c.categories), new Set(['tools', 'diy_garden', 'electronics']));
    const ids = asked('Bosch GSR 12V-15');
    for (const id of ['hornbach_sk', 'mountfield_sk', 'nay_sk', 'datart_cz', 'morele_net']) assert.ok(ids.has(id), id);
    for (const id of ['drmax_sk', 'pilulka_sk', 'ikea_sk', 'jysk_sk', 'martinus_sk']) assert.ok(!ids.has(id), id);
  });
  test('words in Slovak, Czech, German and Polish', () => {
    assert.ok(guessCategories('elektrická zubná kefka').categories?.includes('drugstore'));
    assert.ok(guessCategories('Akkuschrauber 18V').categories?.includes('tools'));
    assert.ok(guessCategories('pračka 8 kg').categories?.includes('appliances'));
    assert.ok(guessCategories('biurko 120 cm').categories?.includes('furniture'));
    assert.ok(guessCategories('písací stôl 120 cm').categories?.includes('furniture'));
    assert.ok(guessCategories('Nivea Creme 150 ml').categories?.includes('pharmacy'));
    assert.ok(guessCategories('Hobit Tolkien').categories?.includes('books'));
  });
  test('a product word beats a brand: "Bosch" alone is broad, "Bosch vysávač" is an appliance', () => {
    assert.ok(guessCategories('Bosch').categories?.includes('appliances'));
    assert.ok(guessCategories('Bosch').categories?.includes('tools'));
    assert.deepEqual(new Set(guessCategories('Bosch vysávač BGS').categories), new Set(['electronics', 'appliances']));
  });
  test('no hint: all shops', () => {
    const c = guessCategories('XYZ 123');
    assert.equal(c.categories, null);
    assert.equal(asked('XYZ 123').size, realShops.length);
  });
  test('explicit choices: all shops, or one group', () => {
    assert.equal(chooseCategories('Oral-B Pro 3 3000', 'all').categories, null);
    assert.deepEqual(chooseCategories('anything', 'books').categories, ['books']);
    assert.ok(chooseCategories('Oral-B Pro 3 3000', 'auto').categories?.includes('drugstore'));
  });
});

describe('not relevant shops in a search', () => {
  test('are reported as not_relevant, cost no request, and are not counted as failures', async () => {
    const { shops } = validateShops({
      shops: [
        { id: 'tv', name: 'TV shop', domain: 'tv.test', categories: ['electronics'], search_url_template: 'https://tv.test/s?q={query}' },
        { id: 'sofa', name: 'Sofa shop', domain: 'sofa.test', categories: ['furniture'], search_url_template: 'https://sofa.test/s?q={query}' },
      ],
    });
    const calls: string[] = [];
    const f: FetchLike = async (url) => {
      calls.push(url);
      return new Response(url.endsWith('robots.txt') ? '' : '<html></html>');
    };
    const events: SearchEvent[] = [];
    for await (const e of runSearch('iPhone 16 128GB', { shops, cache: new MemoryCache(), scheduler: new HostScheduler({ intervalMs: 0 }), location: DEFAULT_LOCATION, providers: [], fetch: f })) events.push(e);
    const results = events.filter((e): e is Extract<SearchEvent, { type: 'shop' }> => e.type === 'shop').map((e) => e.result);
    const sofa = results.find((r) => r.shopId === 'sofa') as ShopResult;
    assert.equal(sofa.status, 'not_relevant');
    assert.equal(sofa.requestsUsed, 0);
    assert.ok(!calls.some((u) => u.includes('sofa.test')));
    const done = events.at(-1) as Extract<SearchEvent, { type: 'done' }>;
    assert.equal(done.summary.shopsAsked, 1);
    assert.ok(!notCheckedList(results).some((x) => x.shopName === 'Sofa shop'));
    assert.match(statusSummary(results), /1 not asked \(not relevant\)/);
  });
});

describe('status summary and manual list', () => {
  const r = (shopName: string, status: ShopResult['status'], manualUrl: string | null = null): ShopResult => ({
    shopId: shopName, shopName, domain: `${shopName}.test`, section: 'online', status, detail: '', route: 'none', manualUrl, offers: [], candidates: [], requestsUsed: 0, fromCache: true, ms: 0,
  });
  test('one line, in a fixed order', () => {
    assert.equal(statusSummary([r('a', 'ok'), r('b', 'blocked'), r('c', 'blocked'), r('d', 'needs_js'), r('e', 'not_relevant')]),
      '1 found, 2 blocked, 1 needs a browser, 1 not asked (not relevant)');
  });
  test('the manual list has the shops that could not be checked, with a link even without a template', () => {
    const list = notCheckedList([r('a', 'ok'), r('b', 'blocked', 'https://b.test/s?q=x'), r('c', 'no_route'), r('d', 'no_match'), r('e', 'not_relevant')]);
    assert.deepEqual(list.map((x) => [x.shopName, x.url]), [['b', 'https://b.test/s?q=x'], ['c', 'https://c.test/']]);
  });
});
