// Builds the test fixtures in test/fixtures/ from the probe's cached pages in .cache/probe/
// (git-ignored). Only trimmed JSON-LD blocks (and, for link tests, a list of anchors) are written:
// shops' whole HTML pages are not committed to this public repository.
//
//   npm run fixtures

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { load } from 'cheerio/slim';
import { extractJsonLdBlocks } from '../src/core/jsonld.ts';

const ROOT = new URL('../', import.meta.url);
const CACHE = new URL('.cache/probe/', ROOT);
const OUT = new URL('test/fixtures/jsonld/', ROOT);
const OUT_LINKS = new URL('test/fixtures/links/', ROOT);

interface Spec { file: string; name: string; url: string }

const PRODUCT_PAGES: Spec[] = [
  { file: 'nay_sk-e168e7c7ef', name: 'nay_iphone16_product', url: 'https://www.nay.sk/mobilny-telefon-apple-iphone-16-128-gb-modrozeleny-myed3sx-a' },
  { file: 'nay_sk-a2d3ede94f', name: 'nay_oralb_kids_product', url: 'https://www.nay.sk/zubna-kefka-oral-b-pro-3-kids-lion-king' },
  { file: 'mediamarkt_de-d7bd120b0d', name: 'mediamarkt_de_oralb3000_product', url: 'https://www.mediamarkt.de/de/product/_oral-b-pro-3-3000-elektrische-zahnburste-schwarz-100959625.html' },
  { file: 'mediamarkt_de-1c2ceb1937', name: 'mediamarkt_de_iphone16pro_group', url: 'https://www.mediamarkt.de/de/product/_apple-iphone-16-pro-128-gb-beige-dual-sim-145402270.html' },
  { file: 'mediamarkt_at-1239d59117', name: 'mediamarkt_at_iphone16_group', url: 'https://www.mediamarkt.at/de/product/_apple-iphone-16-128gb-black-2002635.html' },
  { file: 'mironet_cz-db548d9a46', name: 'mironet_iphone16_product', url: 'https://www.mironet.cz/apple-iphone-16-128gb-cerna-61-128gb-ios18+dp702612/' },
  { file: 'hornbach_sk-3fc219823d', name: 'hornbach_gsr_product', url: 'https://www.hornbach.sk/p/aku-vrtacka-bosch-gsr-12v-15-060186810f/10114594/' },
  { file: 'andreashop_sk-44209f1de6', name: 'andreashop_iphone16_product', url: 'https://www.andreashop.sk/apple-iphone-16-128gb-biela-p296882' },
  { file: 'istores_sk-2496b52e06', name: 'istores_iphone16_product', url: 'https://www.istores.sk/produkt/iphone-16-128-gb-cierna-2242517' },
  { file: 'datart_cz-1aeba4e374', name: 'datart_iphone16_product', url: 'https://www.datart.cz/mobilni-telefon-apple-iphone-16-128-gb-modrozeleny-myed3sx-a.html' },
  { file: 'morele_net-64b8f90937', name: 'morele_iphone16_product', url: 'https://www.morele.net/smartfon-apple-iphone-16-128gb-black-mye73-14121922/' },
  { file: 'pilulka_sk-89bab5cae5', name: 'pilulka_nivea_product', url: 'https://www.pilulka.sk/nivea-men-krem-150ml' },
  { file: 'ikea_sk-9646496611', name: 'ikea_desk_product', url: 'https://www.ikea.com/sk/sk/p/lagkapten-alex-stol-biela-s69416817/' },
  { file: 'martinus_sk-98fb25b40b', name: 'martinus_book_product', url: 'https://www.martinus.sk/2638963-hobit/kniha' },
  { file: 'drmax_sk-dfdcc6f986', name: 'drmax_nivea_product', url: 'https://www.drmax.sk/nivea-creme-1' },
];

const SEARCH_PAGES: Spec[] = [
  { file: 'nay_sk-2e33c6d31f', name: 'nay_iphone16_search', url: 'https://www.nay.sk/apple-iphone-16' },
  { file: 'hornbach_sk-f6868dcdbf', name: 'hornbach_gsr_search', url: 'https://www.hornbach.sk/s/Bosch%2BGSR%2B12V-15' },
  { file: 'mediamarkt_de-7b547fbdec', name: 'mediamarkt_de_oralb_search', url: 'https://www.mediamarkt.de/de/search.html?query=Oral-B+Pro+3+3000' },
  { file: 'mediamarkt_de-3727a7e96a', name: 'mediamarkt_de_iphone16_search', url: 'https://www.mediamarkt.de/de/search.html?query=iPhone+16+128GB' },
];

// Search pages without an ItemList: keep only their anchors, for the HTML-link candidate tests.
const LINK_PAGES: Spec[] = [
  { file: 'nay_sk-1841ecadb3', name: 'nay_oralb_search_links', url: 'https://www.nay.sk/vyhladavanie?q=Oral-B+Pro+3+3000' },
  { file: 'mironet_cz-d942852ad2', name: 'mironet_iphone16_search_links', url: 'https://www.mironet.cz/ProductList/showSearch?EXPF=iPhone+16+128GB' },
];

const DROP = new Set([
  'description', 'image', 'images', 'additionalProperty', 'review', 'reviews', 'aggregateRating', 'author',
  'potentialAction', 'subjectOf', 'hasMerchantReturnPolicy', 'hasEnergyConsumptionDetails', 'thumbnailUrl',
  'translator', 'contributor', 'logo', 'sameAs', 'width', 'height', 'depth', 'weight', 'hasCertification',
  'warranty', 'deliveryTime', 'mainEntityOfPage', 'primaryImageOfPage',
]);

function trim(v: unknown, key = ''): unknown {
  if (Array.isArray(v)) {
    const limit = key === 'hasVariant' || key === 'offers' || key === 'itemListElement' || key === 'shippingDetails' ? 12 : 4;
    return v.slice(0, limit).map((x) => trim(x, key));
  }
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (!DROP.has(k)) out[k] = trim(x, k);
    return out;
  }
  if (typeof v === 'string' && v.length > 240) return v.slice(0, 240);
  return v;
}

const relevant = (b: unknown) =>
  /"@type":(\[[^\]]*)?"(?:https?:\/\/schema\.org\/)?(?:Product|ProductGroup|ItemList|Offer|AggregateOffer|BuyAction|Book)"/.test(JSON.stringify(b));

function writeJsonLd(spec: Spec, kind: 'product' | 'search') {
  const path = new URL(`${spec.file}.html`, CACHE);
  if (!existsSync(path)) {
    console.log(`skip ${spec.name}: ${spec.file}.html not in .cache/probe`);
    return;
  }
  const html = readFileSync(path, 'utf8');
  const { blocks } = extractJsonLdBlocks(html);
  const kept = blocks.filter(relevant).map((b) => trim(b));
  const doc = { source: `trimmed JSON-LD from ${spec.url}, fetched 2026-11-24 by tools/probe_shops.py`, kind, url: spec.url, blocks: kept };
  writeFileSync(new URL(`${spec.name}.json`, OUT), JSON.stringify(doc, null, 1) + '\n');
  console.log(`wrote ${spec.name}.json (${kept.length} blocks)`);
}

function writeLinks(spec: Spec) {
  const path = new URL(`${spec.file}.html`, CACHE);
  if (!existsSync(path)) {
    console.log(`skip ${spec.name}`);
    return;
  }
  const $ = load(readFileSync(path, 'utf8'));
  const lines: string[] = [];
  $('a[href]').each((_i, el) => {
    const a = $(el);
    const inChrome = a.parents('nav, header, footer').length > 0;
    const text = a.text().replace(/\s+/g, ' ').trim().slice(0, 160);
    const title = (a.attr('title') ?? '').slice(0, 160);
    const href = a.attr('href') ?? '';
    if (!href || href.startsWith('javascript:')) return;
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    const tag = `<a href="${esc(href)}"${title ? ` title="${esc(title)}"` : ''}>${esc(text)}</a>`;
    lines.push(inChrome ? `<nav>${tag}</nav>` : tag);
  });
  const html = `<!-- anchors only, from ${spec.url}, fetched 2026-11-24 -->\n<html><body>\n${lines.slice(0, 400).join('\n')}\n</body></html>\n`;
  writeFileSync(new URL(`${spec.name}.html`, OUT_LINKS), html);
  console.log(`wrote ${spec.name}.html (${Math.min(lines.length, 400)} anchors)`);
}

/**
 * One product page fetched now under the app's request rules (robots.txt, 3 s per host, no retry,
 * bot walls reported), for a page that is not in the probe cache:
 *   node tools/extract_fixtures.ts --fetch <domain> <url> <fixture name>
 */
async function fetchOne(domain: string, url: string, name: string) {
  const { ShopSession } = await import('../src/core/http.ts');
  const { makeScheduler, openStore } = await import('../src/node/setup.ts');
  const store = openStore();
  const session = new ShopSession(domain, { scheduler: makeScheduler(store), cache: store, budget: 2 });
  const page = await session.get(url, 'fixture');
  store.close();
  if (!page.ok) {
    console.log(`not written: ${url} -> ${page.status}${page.blocked ? ` blocked (${page.blocked})` : ''}${page.robotsDisallowed ? ' disallowed by robots.txt' : ''}${page.error ? ` ${page.error}` : ''}`);
    return;
  }
  const kept = extractJsonLdBlocks(page.text).blocks.filter(relevant).map((b) => trim(b));
  const day = new Date().toISOString().slice(0, 10);
  const doc = { source: `trimmed JSON-LD from ${url}, fetched ${day} by tools/extract_fixtures.ts --fetch`, kind: 'product', url: page.finalUrl, blocks: kept };
  writeFileSync(new URL(`${name}.json`, OUT), JSON.stringify(doc, null, 1) + '\n');
  console.log(`wrote ${name}.json (${kept.length} blocks)`);
}

mkdirSync(OUT, { recursive: true });
mkdirSync(OUT_LINKS, { recursive: true });
const fetchAt = process.argv.indexOf('--fetch');
if (fetchAt >= 0) {
  const [domain, url, name] = process.argv.slice(fetchAt + 1);
  if (!domain || !url || !name) throw new Error('usage: node tools/extract_fixtures.ts --fetch <domain> <url> <fixture name>');
  await fetchOne(domain, url, name);
  process.exit(0);
}
PRODUCT_PAGES.forEach((s) => writeJsonLd(s, 'product'));
SEARCH_PAGES.forEach((s) => writeJsonLd(s, 'search'));
LINK_PAGES.forEach(writeLinks);
