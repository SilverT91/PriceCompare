// Extraction tests on trimmed JSON-LD taken from real shop pages (see tools/extract_fixtures.ts).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractJsonLdBlocks, extractListCandidates, extractOffers, offerUrl, parsePrice } from '../src/core/jsonld.ts';
import { fixtureHtml } from './helpers.ts';

const offersOf = (name: string) => {
  const { html, url } = fixtureHtml(name);
  return extractOffers(html, url, 'shop');
};

test('NAY Product: sale price wins over the regular price, GTIN from the 12-digit "gtin" key', () => {
  const r = offersOf('nay_iphone16_product');
  assert.equal(r.offers.length, 1);
  const o = r.offers[0];
  assert.equal(o.price, 849);
  assert.equal(o.currency, 'EUR');
  assert.equal(o.gtin, '00195949822650');
  assert.equal(o.brand, 'Apple');
  assert.equal(o.availability, 'InStock');
  assert.equal(o.itemCondition, 'NewCondition');
  assert.match(o.source, /sale price; regular 1029/);
  // isRelatedTo services (insurance) must not become offers
  assert.ok(!r.offers.some((x) => /Poistenie/.test(x.title)));
});

test('Datart (Czech sister shop) has the same GTIN as NAY for the same phone', () => {
  const nay = offersOf('nay_iphone16_product').offers[0];
  const datart = offersOf('datart_iphone16_product').offers[0];
  assert.equal(datart.gtin, nay.gtin);
  assert.equal(datart.currency, 'CZK');
  assert.equal(datart.price, 19990);
});

test('MediaMarkt Product inside BuyAction.object, marketplace seller and DE-only shippingDetails', () => {
  const [o] = offersOf('mediamarkt_de_oralb3000_product').offers;
  assert.equal(o.title, 'ORAL-B Pro 3 3000 Elektrische Zahnbürste Black');
  assert.equal(o.price, 117.62);
  assert.equal(o.gtin, '08006540759790'); // from gtin13
  assert.equal(o.seller, 'Procomponentes DE');
  assert.deepEqual(o.shipping, [{ countries: ['DE'], rate: 7.9, currency: 'EUR', freeFrom: null }]);
});

test('MediaMarkt ProductGroup: one offer per variant with its own GTIN and colour, add-on services ignored', () => {
  const r = offersOf('mediamarkt_at_iphone16_group');
  const titles = r.offers.map((o) => o.title);
  assert.ok(r.offers.length >= 4, `expected variants, got ${r.offers.length}`);
  assert.ok(titles.every((t) => /iPhone 16 128 GB/i.test(t)));
  assert.equal(new Set(r.offers.map((o) => o.gtin)).size, r.offers.length);
  assert.ok(r.offers.some((o) => o.color === 'Schwarz'));
  assert.ok(!r.offers.some((o) => /Schutzfolie|AppleCare/.test(o.title)));
});

test('MediaMarkt ProductGroup with refurbished marketplace offers keeps itemCondition per offer', () => {
  const r = offersOf('mediamarkt_de_iphone16pro_group');
  const conds = new Set(r.offers.map((o) => o.itemCondition));
  assert.ok(conds.has('RefurbishedCondition'));
  assert.ok(conds.has('NewCondition'));
});

test('Mironet: string price, CZK, no GTIN, shippingDetails that only reference a service (no rate)', () => {
  const [o] = offersOf('mironet_iphone16_product').offers;
  assert.equal(o.price, 19990);
  assert.equal(o.currency, 'CZK');
  assert.equal(o.gtin, null);
  assert.equal(o.mpn, 'MYE73');
  assert.ok(o.shipping.every((s) => s.rate === null));
});

test('Pilulka: several shippingDetails for SK', () => {
  const [o] = offersOf('pilulka_nivea_product').offers;
  const sk = o.shipping.filter((s) => s.countries.includes('SK'));
  assert.equal(sk.length, 5);
  assert.ok(sk.some((s) => s.rate === 1.99));
});

test('IKEA: priceSpecification list, strikethrough price skipped', () => {
  const [o] = offersOf('ikea_desk_product').offers;
  assert.equal(o.price, 104.8);
});

test('iStores: shipping to SK for free', () => {
  const [o] = offersOf('istores_iphone16_product').offers;
  assert.deepEqual(o.shipping[0], { countries: ['SK'], rate: 0, currency: 'EUR', freeFrom: null });
  assert.equal(o.gtin, '00195949821936');
});

test('Morele: array root with a separate ProductGroup and Product, PLN, colour, shipping range not usable', () => {
  const r = offersOf('morele_iphone16_product');
  assert.equal(r.offers.length, 1);
  const o = r.offers[0];
  assert.equal(o.currency, 'PLN');
  assert.equal(o.color, 'Czarny');
  assert.equal(o.shipping[0].rate, null); // minValue 0 .. maxValue 25.99
});

test('Martinus: Book typed ["Product","Book"], GTIN from isbn', () => {
  const [o] = offersOf('martinus_book_product').offers;
  assert.equal(o.gtin, '09788025707418');
  assert.equal(o.price, 14);
});

test('Andreashop: brand as a plain string, OutOfStock with http:// schema URL', () => {
  const [o] = offersOf('andreashop_iphone16_product').offers;
  assert.equal(o.brand, 'Apple');
  assert.equal(o.availability, 'OutOfStock');
});

test('search pages: ItemList candidates (NAY, Hornbach, MediaMarkt)', () => {
  for (const [name, n] of [['nay_iphone16_search', 9], ['hornbach_gsr_search', 2], ['mediamarkt_de_oralb_search', 12]] as const) {
    const { html, url } = fixtureHtml(name);
    const c = extractListCandidates(html, url);
    assert.equal(c.length, n, name);
    assert.ok(c.every((x) => x.url.startsWith('https://') && x.title));
  }
  // ItemList products on a search page are not offers of that page
  const { html, url } = fixtureHtml('hornbach_gsr_search');
  assert.equal(extractOffers(html, url, 'h').offers.length, 0);
});

test('broken JSON-LD with raw newlines inside strings is still parsed; garbage is skipped', () => {
  const html = `<script type="application/ld+json">{"@type":"Product","name":"A\nB","offers":{"price":"1 029,90","priceCurrency":"EUR"}}</script>
  <script type="application/ld+json">{not json</script>`;
  const { blocks, errors } = extractJsonLdBlocks(html);
  assert.equal(blocks.length, 1);
  assert.equal(errors, 1);
  const r = extractOffers(html, 'https://x.sk/p', 's');
  assert.equal(r.offers[0].price, 1029.9);
});

test('AggregateOffer without nested offers gives the lowest price, marked as such', () => {
  const html = `<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"X 1","gtin14":"00195949822650",
    "offers":{"@type":"AggregateOffer","lowPrice":"99.90","highPrice":"120","priceCurrency":"EUR","offerCount":3}}</script>`;
  const [o] = extractOffers(html, 'https://x.sk/p', 's').offers;
  assert.equal(o.price, 99.9);
  assert.match(o.source, /AggregateOffer/);
  assert.equal(o.gtin, '00195949822650');
});

test('@graph with WebPage.mainEntity and @id references', () => {
  const html = `<script type="application/ld+json">{"@context":"https://schema.org","@graph":[
    {"@type":"WebPage","mainEntity":{"@id":"#p"}},
    {"@type":"Product","@id":"#p","name":"Thing 2","offers":{"@id":"#o"}},
    {"@type":"Offer","@id":"#o","price":5,"priceCurrency":"EUR"}]}</script>`;
  const r = extractOffers(html, 'https://x.sk/p', 's');
  assert.equal(r.offers.length, 1);
  assert.equal(r.offers[0].price, 5);
});

test('price 0 (Datart lists sold-out items so) is not an offer', () => {
  const html = `<script type="application/ld+json">{"@type":"Product","name":"X 1","offers":{"@type":"Offer","price":0,"priceCurrency":"CZK","availability":"https://schema.org/SoldOut"}}</script>`;
  assert.equal(extractOffers(html, 'https://x.cz/p', 's').offers.length, 0);
});

test('a page without Product data yields no offers', () => {
  const r = extractOffers('<html><script type="application/ld+json">{"@type":"BreadcrumbList"}</script></html>', 'https://x.sk/', 's');
  assert.equal(r.productNodes, 0);
  assert.equal(r.offers.length, 0);
});

test('parsePrice handles common formats', () => {
  assert.equal(parsePrice('1 029,90 €'), 1029.9);
  assert.equal(parsePrice('1.029,90'), 1029.9);
  assert.equal(parsePrice('1,029.90'), 1029.9);
  assert.equal(parsePrice('133.20'), 133.2);
  assert.equal(parsePrice(849), 849);
  assert.equal(parsePrice(''), null);
});

test('Nazuby.eu: the offer url is the site root, so the offer links to the page it was read from', () => {
  // Every Nazuby.eu product page says "url": "https://www.nazuby.eu" in its Offer (seen 2026-11-24).
  const r = offersOf('nazuby_io3_product');
  assert.equal(r.offers.length, 1);
  assert.equal(r.offers[0].url, 'https://www.nazuby.eu/oral-b-io-series-3-white-magneticka-kefka');
  assert.equal(r.offers[0].price, 67.01);
});

test('offerUrl keeps a real product URL and replaces a root or non-web one', () => {
  const page = 'https://shop.test/p/kefka-123';
  assert.equal(offerUrl('https://shop.test/p/kefka-123?variant=2', page), 'https://shop.test/p/kefka-123?variant=2');
  assert.equal(offerUrl('/p/other-variant', page), 'https://shop.test/p/other-variant');
  for (const u of ['https://shop.test', 'https://shop.test/', '/', 'https://shop.test/sk/', 'https://shop.test/index.html', 'mailto:x@shop.test', null]) {
    assert.equal(offerUrl(u, page), page, String(u));
  }
  assert.equal(offerUrl('https://shop.test/', 'https://shop.test/'), 'https://shop.test/', 'a root page keeps its root URL');
});
