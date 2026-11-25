// Slovak as a second language: the catalogue, plurals and number formats, a whole search in both
// languages (mocked shops, no network), the Slovak shop notes, and a cache that does not depend on
// the language.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { parse } from 'yaml';
import { createApp } from '../src/app.ts';
import { chooseCategories, guessCategories, RULE_IDS } from '../src/core/categories.ts';
import { groupNotes } from '../src/core/group.ts';
import { HostScheduler, type FetchLike } from '../src/core/http.ts';
import { catalogueKeys, eur, localizeShop, money, parseLang, plural, pluralSk, reasonCodes, reasonText, t, techNote, type ShopTexts } from '../src/core/i18n.ts';
import { matchTitle, parseQuery } from '../src/core/matcher.ts';
import { runSearch, type SearchEvent } from '../src/core/pipeline.ts';
import { statusSummary } from '../src/core/report.ts';
import { DEFAULT_LOCATION, validateShops, validateShopTexts } from '../src/core/shops.ts';
import { headlineText } from '../src/core/totals.ts';
import type { ShopResult } from '../src/core/types.ts';
import { loadShops } from '../src/node/setup.ts';
import { MemoryCache } from './helpers.ts';

const SLOVAK = /[áäčďéíĺľňóôŕšťúýžÁÄČĎÉÍĹĽŇÓÔŔŠŤÚÝŽ„“]/;

test('both languages have the same message keys', () => {
  assert.deepEqual(catalogueKeys('sk'), catalogueKeys('en'));
  assert.ok(catalogueKeys('en').length > 50);
});

test('Slovak plural: 1, 2 to 4, 5 and more (the same as Intl.PluralRules for whole numbers)', () => {
  const f = (n: number) => `${n} ${pluralSk(n, 'ponuka', 'ponuky', 'ponúk')}`;
  assert.deepEqual([0, 1, 2, 3, 4, 5, 11, 21, 22].map(f), ['0 ponúk', '1 ponuka', '2 ponuky', '3 ponuky', '4 ponuky', '5 ponúk', '11 ponúk', '21 ponúk', '22 ponúk']);
  const rules = new Intl.PluralRules('sk');
  for (let n = 0; n <= 30; n++) {
    const cat = rules.select(n);
    assert.equal(pluralSk(n, 'one', 'few', 'other'), cat === 'one' ? 'one' : cat === 'few' ? 'few' : 'other', String(n));
  }
  assert.equal(plural('en', 1, { one: 'offer', few: 'offers', other: 'offers' }), 'offer');
  assert.equal(plural('en', 3, { one: 'offer', few: 'x', other: 'offers' }), 'offers');
  assert.equal(plural('sk', 3, { one: 'ponuka', few: 'ponuky', other: 'ponúk' }), 'ponuky');
});

test('numbers and money follow the language', () => {
  assert.equal(eur('en', 297.9), '297.90 €');
  assert.equal(eur('sk', 297.9), '297,90 €');
  assert.equal(eur('sk', 1265), '1 265,00 €');
  assert.equal(money('sk', 1265, 'PLN'), '1 265 PLN');
  assert.equal(money('sk', 0.99, 'EUR'), '0,99 €');
  assert.equal(money('en', 0.99, 'EUR'), '0.99 EUR');
  assert.equal(headlineText({ bestItemEur: 797.85, bestItemShop: 'A', bestItemTotalKnown: false, bestTotalEur: 849, bestTotalShop: 'NAY', bestTotalKind: 'pickup' }, 'sk'),
    'od 797,85 € + doprava? · najnižšia známa cena spolu 849,00 € (NAY, osobný odber)');
  assert.equal(parseLang('SK'), 'sk');
  assert.equal(parseLang('de'), 'en');
  assert.equal(parseLang(undefined), 'en');
});

test('status summary and product notes in Slovak; English unchanged', () => {
  const r = (status: ShopResult['status']) => ({ status });
  const list = [r('ok'), r('blocked'), r('blocked'), r('needs_js'), r('error'), r('error'), r('error'), r('error'), r('error'), r('not_relevant')];
  assert.equal(statusSummary(list), '1 found, 2 blocked, 1 needs a browser, 5 errors, 1 not asked (not relevant)');
  assert.equal(statusSummary(list, 'sk'), '1 nájdený, 2 blokované, 1 vyžaduje prehliadač, 5 chýb, 1 mimo výberu (iný sortiment)');
  const facts = { noDelivery: 2, gtins: 1, mixed: true, noGtin: true };
  assert.deepEqual(groupNotes(facts), ['2 offers from shops that do not deliver to Slovakia (not ranked)', '1 GTIN', 'some offers only possibly match: check them', 'some offers grouped by name only (no GTIN)']);
  assert.deepEqual(groupNotes(facts, 'sk'), ['2 ponuky z obchodov, ktoré nedoručujú na Slovensko (mimo poradia)', '1 kód GTIN', 'niektoré ponuky sa zhodujú len možno: overte ich', 'niektoré ponuky sú zoskupené len podľa názvu (bez GTIN)']);
});

test('technical notes: known phrases translated, other text kept', () => {
  assert.equal(techNote('sk', 'serper: Serper credits used up (HTTP 432) (since 2026-11-25T07:00:00.000Z)'), 'serper: Serper: kredit je vyčerpaný (HTTP 432) (od 2026-11-25T07:00:00.000Z)');
  assert.equal(techNote('sk', 'robots.txt HTTP 404 (no rules)'), 'robots.txt: HTTP 404 (bez pravidiel)');
  assert.equal(techNote('sk', 'TypeError: fetch failed'), 'TypeError: fetch failed');
  assert.equal(techNote('en', 'too many redirects'), 'too many redirects');
});

// ---- a whole search in both languages ---------------------------------------------------------------

const product = (name: string, price: number, gtin: string) =>
  `<html><script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"${name}","gtin13":"${gtin}","brand":"Oral-B",
  "offers":{"@type":"Offer","price":${price},"priceCurrency":"EUR","availability":"https://schema.org/InStock"}}</script></html>`;
const ITEMLIST = `<html><script type="application/ld+json">{"@type":"ItemList","itemListElement":[
  {"@type":"ListItem","item":{"@type":"Product","name":"Oral-B Pro 3 3000 Black","url":"https://a.test/p/black"}},
  {"@type":"ListItem","item":{"@type":"Product","name":"Oral-B Pro 3 3000 White","url":"https://a.test/p/white"}}]}</script></html>`;

const { shops } = validateShops({
  shops: [
    {
      id: 'a', name: 'Shop A', domain: 'a.test', categories: ['electronics'], has_kosice_branch: true, search_url_template: 'https://a.test/s?q={query}',
      shipping_to_sk: { price: 1.99, currency: 'EUR', free_from: null, method: 'Packeta pickup point', checked: '2026-11-24' },
      pickup_kosice: { available: true, price: 0, currency: 'EUR' },
    },
    { id: 'b', name: 'Shop B', domain: 'b.test', categories: ['electronics'], search_url_template: 'https://b.test/search?q={query}' },
    { id: 'c', name: 'Shop C', domain: 'c.test', categories: ['electronics'], search_url_template: 'https://c.test/s?q={query}' },
    { id: 'd', name: 'Shop D', domain: 'd.test', categories: ['electronics'], search_url_template: 'https://d.test/s?q={query}', needs_js: true },
    { id: 'e', name: 'Shop E', domain: 'e.test', categories: ['electronics'], search_url_template: null, no_route_reason: 'the site search is a POST form' },
    { id: 'g', name: 'Shop G', domain: 'g.test', categories: ['electronics'], search_url_template: null, no_route_reason: 'no plain search URL', unreachable: true },
    { id: 'k', name: 'Books', domain: 'k.test', categories: ['books'], search_url_template: 'https://k.test/?q={query}' },
  ],
});
const shopTexts: ShopTexts = {
  sk: {
    a: { shipping_to_sk: { method: 'výdajné miesto Packeta' } },
    e: { no_route_reason: 'vyhľadávanie na webe je formulár POST' },
    // g has no translation: its English note is shown
  },
};

function site() {
  const calls: string[] = [];
  const routes: Record<string, () => Response> = {
    'https://a.test/robots.txt': () => new Response('User-agent: *\nDisallow: /cart'),
    'https://a.test/s?q=Oral-B+Pro+3+3000': () => new Response(ITEMLIST),
    'https://a.test/p/black': () => new Response(product('Oral-B Pro 3 3000 Black', 59.9, '8006540759790')),
    'https://a.test/p/white': () => new Response(product('Oral-B Pro 3 3000 White', 62.5, '8006540760161')),
    'https://b.test/robots.txt': () => new Response('User-agent: *\nDisallow: /search'),
    'https://c.test/robots.txt': () => new Response('<title>Just a moment...</title>', { status: 403 }),
  };
  const f: FetchLike = async (url) => {
    calls.push(url);
    const r = routes[url];
    return r ? r() : new Response('nf', { status: 404 });
  };
  return { f, calls };
}

async function search(lang: 'en' | 'sk' | undefined, cache = new MemoryCache(), f = site().f) {
  const events: SearchEvent[] = [];
  for await (const e of runSearch('Oral-B Pro 3 3000', {
    shops, cache, scheduler: new HostScheduler({ intervalMs: 0 }), location: DEFAULT_LOCATION, providers: [], fetch: f, lang, shopTexts,
  })) events.push(e);
  const results = new Map(events.filter((e): e is Extract<SearchEvent, { type: 'shop' }> => e.type === 'shop').map((e) => [e.result.shopId, e.result]));
  const products = events.filter((e): e is Extract<SearchEvent, { type: 'products' }> => e.type === 'products').at(-1);
  const done = events.at(-1) as Extract<SearchEvent, { type: 'done' }>;
  return { events, results, products, done, cache };
}

test('a search in English: the texts are the ones the page always showed', async () => {
  const { results, products } = await search(undefined);
  const d = (id: string) => results.get(id)?.detail;
  assert.equal(d('a'), '2 matching offer(s): 2 exact, 0 possible');
  assert.equal(d('b'), "robots.txt disallows the shop's search page; set SERPER_API_KEY or BRAVE_API_KEY to find product pages through a web search");
  assert.equal(d('c'), 'bot protection (cloudflare) on robots.txt; skipped for an hour');
  assert.equal(d('d'), 'prices on this shop only appear after JavaScript runs; not fetched (open the manual link)');
  assert.equal(d('e'), 'the site search is a POST form; a web search key (BRAVE_API_KEY or SERPER_API_KEY) would let the app search it');
  assert.equal(d('g'), 'not asked: no plain search URL');
  assert.match(d('k') ?? '', /^not asked: its categories \(books\) do not fit /);
  const offer = results.get('a')?.offers[0];
  assert.equal(offer?.totals.shippingNote, "Packeta pickup point (shop's delivery page, checked 2026-11-24)");
  assert.equal(offer?.totals.pickupNote, 'pickup in the branch: free');
  const g = products?.groups[0];
  assert.deepEqual(g?.notes, ['2 GTINs']);
  assert.deepEqual(g?.variants.map((v) => v.label).sort(), ['black, GTIN 8006540759790', 'white, GTIN 8006540760161']);
  // the explicit 'en' is the same as no language
  const again = await search('en');
  assert.deepEqual([...again.results.values()].map((r) => r.detail), [...results.values()].map((r) => r.detail));
});

test('a search in Slovak: shop details, notes, labels and the summary in Slovak; codes unchanged', async () => {
  const { results, products, done } = await search('sk');
  const d = (id: string) => results.get(id)?.detail;
  assert.equal(results.get('a')?.status, 'ok');
  assert.equal(results.get('b')?.status, 'needs_search_key');
  assert.equal(results.get('c')?.status, 'blocked');
  assert.equal(d('a'), '2 zodpovedajúce ponuky: presne 2, možno 0');
  assert.equal(d('b'), 'robots.txt nepovoľuje stránku vyhľadávania obchodu; nastavte SERPER_API_KEY alebo BRAVE_API_KEY, aby sa stránky produktov dali nájsť cez webové vyhľadávanie');
  assert.equal(d('c'), 'ochrana proti robotom (cloudflare) na robots.txt; obchod na hodinu vynechávame');
  assert.equal(d('d'), 'ceny sa v tomto obchode zobrazia až po spustení JavaScriptu; nenačítava sa (otvorte si odkaz na obchod)');
  // the shop's note from data/shops.sk.yaml, and the English one where no translation exists
  assert.equal(d('e'), 'vyhľadávanie na webe je formulár POST; s kľúčom webového vyhľadávania (BRAVE_API_KEY alebo SERPER_API_KEY) by ho aplikácia vedela prehľadať');
  assert.equal(d('g'), 'nepýtali sme sa: no plain search URL');
  assert.equal(d('k'), 'mimo výberu: kategórie obchodu (knihy) nezodpovedajú hľadaniu (spotrebiče, elektronika, drogéria, lekáreň, kozmetika)');
  const offer = results.get('a')?.offers[0];
  assert.equal(offer?.totals.shippingNote, 'výdajné miesto Packeta (stránka obchodu o doprave, overené 24. 11. 2026)');
  assert.equal(offer?.totals.pickupNote, 'osobný odber v predajni: zadarmo');
  assert.equal(offer?.totals.shippingEur, 1.99, 'the facts do not change with the language');
  const g = products?.groups[0];
  assert.deepEqual(g?.notes, ['2 kódy GTIN']);
  assert.deepEqual(g?.noteFacts, { noDelivery: 0, gtins: 2, mixed: false, noGtin: false });
  assert.deepEqual(g?.variants.map((v) => v.label).sort(), ['biela, GTIN 8006540760161', 'čierna, GTIN 8006540759790']);
  assert.deepEqual(g?.variants.map((v) => v.colour).sort(), ['black', 'white'], 'the colour code stays');
  assert.equal(statusSummary([...results.values()], 'sk'), '1 nájdený, 1 blokovaný, 1 vyžaduje prehliadač, 1 bez kľúča vyhľadávania, 2 bez automatického hľadania, 1 mimo výberu (iný sortiment)');
  assert.deepEqual(done.summary.statusCounts, { ok: 1, blocked: 1, needs_js: 1, needs_search_key: 1, no_route: 2, not_relevant: 1 });
});

test('a pasted link without a name is rejected in the search language', async () => {
  const run = async (lang: 'en' | 'sk') => {
    const out: SearchEvent[] = [];
    for await (const e of runSearch('https://www.alza.sk/d123456.htm', { shops, cache: new MemoryCache(), scheduler: new HostScheduler({ intervalMs: 0 }), location: DEFAULT_LOCATION, providers: [], lang })) out.push(e);
    return out[0] as Extract<SearchEvent, { type: 'rejected' }>;
  };
  assert.equal((await run('en')).message, "This link does not contain the product's name, so nothing was searched. Type or paste the product's name instead.");
  assert.match((await run('sk')).message, /^Tento odkaz neobsahuje názov produktu/);
  assert.equal(t('sk', 'rejectedLink'), (await run('sk')).message);
});

test('GET /api/search?lang=sk streams Slovak details; without lang they are English', async () => {
  const { shops: jsOnly } = validateShops({ shops: [{ id: 'd', name: 'Shop D', domain: 'd.test', search_url_template: 'https://d.test/s?q={query}', needs_js: true }] });
  const app = createApp({ shops: () => jsOnly, cache: new MemoryCache(), scheduler: new HostScheduler({ intervalMs: 0 }), providers: () => [] });
  const detail = async (path: string) => {
    const text = await (await app.request(path)).text();
    const shop = /^event: shop\r?\ndata: (.*)$/m.exec(text)?.[1];
    return JSON.parse(shop ?? '{}').result?.detail as string;
  };
  assert.match(await detail('/api/search?q=Thing%201&cat=all&lang=sk'), /^ceny sa v tomto obchode zobrazia až po spustení JavaScriptu/);
  assert.match(await detail('/api/search?q=Thing%201&cat=all'), /^prices on this shop only appear after JavaScript runs/);
});

// ---- the cache does not depend on the language ------------------------------------------------------

/** The cache contents with the times of day removed (blocked marks and the like carry them). */
function cacheSnapshot(c: MemoryCache): string {
  const strip = (v: unknown): unknown => (Array.isArray(v) ? v.map(strip)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'at').map(([k, x]) => [k, strip(x)])) : v);
  return JSON.stringify([...c.map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, strip(v)]));
}

test('nothing language-specific is cached, and each search shows its own language', async () => {
  const sk = await search('sk');
  const en = await search('en');
  assert.equal(cacheSnapshot(sk.cache), cacheSnapshot(en.cache), 'the same cache whatever the language');
  assert.doesNotMatch(cacheSnapshot(sk.cache), SLOVAK);

  // English after Slovak on the same cache: English texts (from the cache, as after an English search)
  const { f: f1 } = site();
  const shared = new MemoryCache();
  await search('sk', shared, f1);
  const enAfterSk = await search('en', shared, f1);
  const { f: f2 } = site();
  const enOnly = new MemoryCache();
  await search('en', enOnly, f2);
  const enAfterEn = await search('en', enOnly, f2);
  const details = (r: Awaited<ReturnType<typeof search>>) => [...r.results.values()]
    .map((x) => `${x.shopId}: ${x.detail.replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/, '<time>')}`).sort();
  assert.deepEqual(details(enAfterSk), details(enAfterEn));
  for (const line of details(enAfterSk)) assert.doesNotMatch(line, SLOVAK);
  assert.ok(details(enAfterSk).some((l) => l.includes('candidates from cache')));

  // and Slovak after English
  const skAfterEn = await search('sk', enOnly, f2);
  assert.match(skAfterEn.results.get('a')?.detail ?? '', /^2 zodpovedajúce ponuky: presne 2, možno 0 \(výsledky vyhľadávania z vyrovnávacej pamäte\)$/);
  assert.match(skAfterEn.products?.groups[0].notes[0] ?? '', /kódy GTIN/);
});

// ---- the Slovak shop notes ------------------------------------------------------------------------

test('shop notes: a translation replaces the shown English note; a missing one falls back to English', () => {
  const a = shops.find((s) => s.id === 'a')!;
  const g = shops.find((s) => s.id === 'g')!;
  assert.equal(localizeShop(a, 'sk', shopTexts).shipping_to_sk?.method, 'výdajné miesto Packeta');
  assert.equal(localizeShop(a, 'sk', shopTexts).shipping_to_sk?.price, 1.99);
  assert.equal(localizeShop(a, 'en', shopTexts), a);
  assert.equal(localizeShop(g, 'sk', shopTexts).no_route_reason, 'no plain search URL');
  assert.equal(localizeShop(a, 'sk', undefined), a);
  const { texts, problems } = validateShopTexts({ shops: { a: { shipping_to_sk: { method: 'x' }, notes: 'y' }, zz: { no_route_reason: 'z' }, b: { no_route_reason: 'w' } } }, shops);
  assert.deepEqual(texts, { a: { shipping_to_sk: { method: 'x' } } });
  assert.equal(problems.length, 3, problems.join('\n'));
});

test('data/shops.sk.yaml: every entry belongs to a shop note, and keeps its numbers, dates and URLs', () => {
  const real = loadShops();
  const doc = parse(readFileSync(new URL('../data/shops.sk.yaml', import.meta.url), 'utf8'));
  const { texts, problems } = validateShopTexts(doc, real);
  assert.deepEqual(problems, []);
  assert.ok(Object.keys(texts).length >= 15);
  // Facts stay as they are: the same numbers (decimal comma read as a point), dates and URLs.
  const facts = (s: string) => (s.match(/\d+(?:[.,]\d+)?|https?:\/\/\S+/g) ?? []).map((x) => x.replace(',', '.')).sort();
  for (const [id, tr] of Object.entries(texts)) {
    const shop = real.find((s) => s.id === id)!;
    if (tr.no_route_reason) assert.deepEqual(facts(tr.no_route_reason), facts(shop.no_route_reason ?? ''), `${id} no_route_reason`);
    if (tr.shipping_to_sk?.method) assert.deepEqual(facts(tr.shipping_to_sk.method), facts(shop.shipping_to_sk?.method ?? ''), `${id} method`);
  }
});

// ---- matcher reasons and category reasons as codes --------------------------------------------------

/** public/i18n.js run as the page would, with just enough of a browser for it (no DOM work is done). */
function pageI18n(): { setLang(l: string): void; reasonText(r: unknown): string | undefined; MESSAGES: Record<string, Record<string, Record<string, unknown>>> } {
  const window: Record<string, unknown> = { location: { search: '' } };
  const document = { documentElement: {}, querySelectorAll: () => [] };
  runInNewContext(readFileSync(new URL('../public/i18n.js', import.meta.url), 'utf8'), { window, document, navigator: { languages: ['en'] }, Intl, URLSearchParams });
  return window.I18N as never;
}

// One title per reason code the matcher can give (query, title).
const REASON_CASES: [string, string][] = [
  ['Lenovo IdeaPad Slim 5 16', 'Notebook Lenovo IdeaPad Slim 5 16ARP10 sivý'], // codeStart
  ['Dyson Supersonic HD07', 'Dyson Supersonik HD07'], // nearSpelling
  ['Oral-B Pro 3 3000', 'Oral-B Pro 3 3000 bazar'], // condition
  ['Logitech MX Master 3S', 'Logitech MX Anywhere 3S'], // insteadOf, titleLacks
  ['Oral-B Pro 3 3000', 'Oral-B Pro 3 3500'], // titleLacks, titleHas
  ['Oral-B Pro 3 3000', 'Oral-B Pro 3000 Black'], // sameOrOlder
  ['iPhone 16', 'Apple iPhone 16 128GB'], // variantNotInQuery
  ['Oral-B Pro 3 3000', 'Oral-B Pro 3 3000 CrossAction'], // extraWords
];

test('every matcher reason has a code with both languages, and the English text is the reason as before', () => {
  assert.deepEqual(reasonCodes('sk'), reasonCodes('en'));
  const page = pageI18n();
  assert.deepEqual(Object.keys(page.MESSAGES.sk.matchReason).sort(), reasonCodes('en'));
  assert.deepEqual(Object.keys(page.MESSAGES.en.matchReason).sort(), reasonCodes('en'));
  const seen = new Set<string>();
  for (const [q, title] of REASON_CASES) {
    const r = matchTitle(parseQuery(q), { title });
    assert.equal(r.reasonCodes.length, r.reasons.length, title);
    r.reasonCodes.forEach((code, i) => {
      seen.add(code.code);
      assert.equal(reasonText('en', code), r.reasons[i]);
      // the page writes the same texts as the core in both languages
      page.setLang('en');
      assert.equal(page.reasonText(code), r.reasons[i]);
      page.setLang('sk');
      assert.equal(page.reasonText(code), reasonText('sk', code));
      assert.match(reasonText('sk', code), SLOVAK, reasonText('sk', code));
    });
  }
  assert.deepEqual([...seen].sort(), reasonCodes('en'), 'every code is produced by one of the cases');
  const lenovo = matchTitle(parseQuery('Lenovo IdeaPad Slim 5 16'), { title: 'Notebook Lenovo IdeaPad Slim 5 16ARP10 sivý' });
  assert.equal(reasonText('sk', lenovo.reasonCodes[0]), '„16“ sa našlo len ako začiatok „16arp10“');
  const mx = matchTitle(parseQuery('Logitech MX Master 3S'), { title: 'Logitech MX Anywhere 3S' });
  assert.equal(reasonText('sk', mx.reasonCodes[0]), 'v názve je „anywhere“ namiesto „master“');
});

test('category reasons carry rule ids, and every rule id has a Slovak text on the page', () => {
  const page = pageI18n();
  for (const id of [...RULE_IDS, 'no_hint', 'all_chosen']) assert.ok(page.MESSAGES.sk.reason[id], id);
  const g = guessCategories('Oral-B io9 doublepack');
  assert.deepEqual(g.reasonIds, ['toothbrush_shaver']);
  assert.equal(g.reasons.length, g.reasonIds.length);
  assert.deepEqual(guessCategories('ryzen 7 9800x3d').reasonIds, ['pc_part']);
  assert.deepEqual(guessCategories('xyz').reasonIds, ['no_hint']);
  assert.deepEqual(chooseCategories('xyz', 'all').reasonIds, ['all_chosen']);
  assert.deepEqual(chooseCategories('xyz', 'tools').reasonIds, ['group_chosen:tools']);
  assert.equal(new Set(RULE_IDS).size, RULE_IDS.length, 'ids are unique');
});
