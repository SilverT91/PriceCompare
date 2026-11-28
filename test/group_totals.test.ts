import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { groupOffers } from '../src/core/group.ts';
import { matchTitle } from '../src/core/matcher.ts';
import { computeTotals, headline, headlineText, sortOffers, toEur, type Rates } from '../src/core/totals.ts';
import type { Offer, RawOffer, ShippingOption } from '../src/core/types.ts';

const rates: Rates = { base: 'EUR', date: '2026-11-24', rates: { CZK: 24.428, PLN: 4.4599 }, source: 'test' };
const noShipShop = { name: 'S', shipping_to_sk: null };

function raw(p: Partial<RawOffer> & { title: string; price: number }): RawOffer {
  return {
    shopId: 's', url: `https://s.sk/${encodeURIComponent(p.title)}`, brand: null, gtin: null, sku: null, mpn: null, color: null,
    currency: 'EUR', availability: 'InStock', itemCondition: 'NewCondition', seller: null, shipping: [], source: 'Product', ...p,
  };
}

function offer(q: string, p: Partial<RawOffer> & { title: string; price: number }, shopId = 's', section: 'local' | 'online' = 'online'): Offer {
  const r = raw({ ...p, shopId });
  return {
    ...r, shopName: shopId, section, shipsToSk: true, branchKnown: section === 'local',
    match: matchTitle(q, { title: r.title, color: r.color, itemCondition: r.itemCondition, url: r.url, brand: r.brand }),
    totals: computeTotals(r, noShipShop, rates),
  };
}

describe('totals', () => {
  test('CZK and PLN are converted with the ECB rate, original kept on the offer', () => {
    assert.deepEqual(toEur(19990, 'CZK', rates), { eur: 818.32, rate: 24.428 });
    assert.equal(toEur(3591, 'PLN', rates).eur, 805.18);
    assert.equal(toEur(10, 'USD', rates).eur, null);
  });
  test('JSON-LD shipping for SK is used (cheapest option), free-shipping threshold honoured', () => {
    const shipping: ShippingOption[] = [
      { countries: ['SK'], rate: 3.39, currency: 'EUR', freeFrom: null },
      { countries: ['SK'], rate: 1.99, currency: 'EUR', freeFrom: null },
    ];
    const t = computeTotals(raw({ title: 'x', price: 6.19, shipping }), noShipShop, rates);
    assert.equal(t.shippingEur, 1.99);
    assert.equal(t.totalEur, 8.18);
    assert.equal(t.shippingSource, 'jsonld');
    const free = computeTotals(raw({ title: 'x', price: 60, shipping: [{ countries: ['SK'], rate: 4, currency: 'EUR', freeFrom: 50 }] }), noShipShop, rates);
    assert.equal(free.shippingEur, 0);
  });
  test('shipping that applies only to DE is not used for SK; unknown stays unknown', () => {
    const t = computeTotals(raw({ title: 'x', price: 117.62, shipping: [{ countries: ['DE'], rate: 7.9, currency: 'EUR', freeFrom: null }] }), noShipShop, rates);
    assert.equal(t.shippingEur, null);
    assert.equal(t.totalEur, null);
    assert.equal(t.itemEur, 117.62);
    assert.match(t.shippingNote, /only for DE/);
  });
  test('shops.yaml shipping_to_sk is the fallback, with free_from', () => {
    const shop = { name: 'S', shipping_to_sk: { price: 3.5, currency: 'EUR', free_from: 100, checked: '2026-11-24' } };
    assert.equal(computeTotals(raw({ title: 'x', price: 50 }), shop, rates).totalEur, 53.5);
    assert.equal(computeTotals(raw({ title: 'x', price: 150 }), shop, rates).totalEur, 150);
    const czk = { name: 'S', shipping_to_sk: { price: 99, currency: 'CZK', free_from: null } };
    assert.equal(computeTotals(raw({ title: 'x', price: 1000, currency: 'CZK' }), czk, rates).shippingEur, 4.05);
  });
  test('no rates: foreign currency gives an unknown total, never a guess', () => {
    const t = computeTotals(raw({ title: 'x', price: 19990, currency: 'CZK', shipping: [{ countries: ['SK'], rate: 0, currency: 'CZK', freeFrom: null }] }), noShipShop, null);
    assert.equal(t.itemEur, null);
    assert.equal(t.totalEur, null);
  });
  test('sorting: known totals first, ascending; unknown totals after, by item price; no delivery last', () => {
    const mk = (item: number, ship: number | null, delivers: true | false | 'unknown' = true) => ({
      availability: 'InStock', shopName: 's',
      totals: computeTotals(raw({ title: 'x', price: item }), { name: 's', ships_to_sk: delivers, shipping_to_sk: ship === null ? null : { price: ship, currency: 'EUR', free_from: null } }, rates),
    });
    const sorted = sortOffers([mk(90, null), mk(100, 5), mk(95, 0), mk(80, null), mk(10, 1, false)]);
    assert.deepEqual(sorted.map((o) => [o.totals.itemEur, o.totals.totalEur]), [[95, 95], [100, 105], [80, null], [90, null], [10, null]]);
  });
  test('Hornbach-style "free from 99 €, price below unknown"', () => {
    const shop = { name: 'H', shipping_to_sk: { price: null, currency: 'EUR', free_from: 99 } };
    assert.equal(computeTotals(raw({ title: 'x', price: 133.2 }), shop, rates).totalEur, 133.2);
    const below = computeTotals(raw({ title: 'x', price: 50 }), shop, rates);
    assert.equal(below.totalEur, null);
    assert.match(below.shippingNote, /free only from 99/);
  });
  test('a shop that does not deliver to Slovakia: no total, marked, not reachable', () => {
    const shop = { name: 'Datart.cz', ships_to_sk: false as const, shipping_to_sk: null };
    const t = computeTotals(raw({ title: 'x', price: 19990, currency: 'CZK', shipping: [{ countries: ['SK'], rate: 0, currency: 'CZK', freeFrom: null }] }), shop, rates);
    assert.equal(t.deliversToSk, false);
    assert.equal(t.totalEur, null);
    assert.equal(t.bestTotalEur, null);
    assert.equal(t.shippingNote, 'does not deliver to Slovakia');
    assert.equal(t.itemEur, 818.32, 'item price still shown');
  });
});

describe('pickup in the local branch', () => {
  const nay = { name: 'NAY', ships_to_sk: true as const, shipping_to_sk: { price: 1.99, currency: 'EUR', free_from: null },
    pickup_kosice: { available: true as const, price: 0, currency: 'EUR' } };
  test('free pickup: pickup total = item price, and it is the best total', () => {
    const t = computeTotals(raw({ title: 'x', price: 849 }), nay, rates, 'SK', { local: true });
    assert.equal(t.pickupTotalEur, 849);
    assert.equal(t.totalEur, 850.99);
    assert.equal(t.bestTotalEur, 849);
    assert.equal(t.bestTotalKind, 'pickup');
    assert.equal(t.pickupNote, 'pickup in the branch: free');
  });
  test('paid pickup (Mountfield 1 €) and unknown pickup', () => {
    const mf = { name: 'Mountfield', pickup_kosice: { available: true as const, price: 1, currency: 'EUR' }, shipping_to_sk: null };
    assert.equal(computeTotals(raw({ title: 'x', price: 50 }), mf, rates, 'SK', { local: true }).pickupTotalEur, 51);
    const hb = { name: 'Hornbach', pickup_kosice: { available: 'unknown' as const, price: null, currency: 'EUR' }, shipping_to_sk: null };
    const t = computeTotals(raw({ title: 'x', price: 50 }), hb, rates, 'SK', { local: true });
    assert.equal(t.pickupTotalEur, null);
    assert.equal(t.bestTotalEur, null);
  });
  test('pickup is only used for shops in the local section', () => {
    const t = computeTotals(raw({ title: 'x', price: 849 }), nay, rates, 'SK', { local: false });
    assert.equal(t.pickupTotalEur, null);
    assert.equal(t.bestTotalKind, 'delivery');
  });
});

describe('headline price', () => {
  const o = (shopName: string, item: number, ship: number | null, extra: Record<string, unknown> = {}) => ({
    shopName,
    totals: computeTotals(raw({ title: 'x', price: item }), { name: shopName, shipping_to_sk: ship === null ? null : { price: ship, currency: 'EUR', free_from: null }, ...extra }, rates, 'SK', { local: Boolean(extra.local) }),
  });
  test('the cheapest item is shown even when its shipping is unknown, with the cheapest known total separately', () => {
    const h = headline([o('iStores', 959, 0), o('Mironet', 797.85, null), o('NAY', 849, null, { local: true, pickup_kosice: { available: true, price: 0, currency: 'EUR' } })]);
    assert.equal(h.bestItemEur, 797.85);
    assert.equal(h.bestItemShop, 'Mironet');
    assert.equal(h.bestItemTotalKnown, false);
    assert.equal(h.bestTotalEur, 849);
    assert.equal(h.bestTotalShop, 'NAY');
    assert.equal(h.bestTotalKind, 'pickup');
    assert.equal(headlineText(h), 'from 797.85 € + shipping? · cheapest known total 849.00 € (NAY, pickup)');
  });
  test('offers from shops that do not deliver to Slovakia do not set the headline', () => {
    const h = headline([o('Datart.cz', 700, null, { ships_to_sk: false }), o('NAY', 849, 1.99)]);
    assert.equal(h.bestItemEur, 849);
    assert.equal(headlineText(h), 'from 849.00 € · cheapest known total 850.99 € (NAY)');
  });
  test('when the cheapest item has free shipping the headline says it once', () => {
    assert.equal(headlineText(headline([o('iStores', 959, 0)])), 'from 959.00 €');
  });
  test('no known total at all is said plainly', () => {
    assert.equal(headlineText(headline([o('A', 10, null)])), 'from 10.00 € + shipping? · no known total');
  });
});

describe('grouping into distinct products', () => {
  const q = 'iPhone 16 128GB';
  test('colour variants of one model form one product with variants side by side; Pro/16e/used are separate', () => {
    const offers = [
      offer(q, { title: 'Mobilný telefón Apple iPhone 16 128 GB modrozelený (MYED3SX/A)', price: 849, gtin: '00195949822650' }, 'nay', 'local'),
      offer(q, { title: 'Mobilní telefon Apple iPhone 16 128 GB modrozelený (MYED3SX/A)', price: 19990, currency: 'CZK', gtin: '00195949822650' }, 'datart'),
      offer(q, { title: 'APPLE iPhone 16 128 GB, Schwarz, Dual SIM', price: 949, gtin: '00195949821967', color: 'Schwarz' }, 'mm_at'),
      offer(q, { title: 'Apple iPhone 16 128GB černá / 6.1" / 128GB / iOS18', price: 19990, currency: 'CZK' }, 'mironet'),
      offer(q, { title: 'APPLE IPHONE 16 PRO 128GB DESERT TITANIUM', price: 1049, gtin: '00195949771583' }, 'mm_de'),
      offer(q, { title: 'Mobilný telefón Apple iPhone 16e 128 GB čierny', price: 669 }, 'nay', 'local'),
      offer(q, { title: 'Apple iPhone 16 128GB Black', price: 700, itemCondition: 'RefurbishedCondition' }, 'mm_de'),
    ];
    const groups = groupOffers(offers);
    const main = groups[0];
    assert.equal(main.level, 'exact');
    assert.equal(main.condition, 'new');
    assert.equal(main.offerCount, 4);
    assert.equal(main.shopCount, 4);
    const labels = main.variants.map((v) => v.colour);
    assert.ok(labels.includes('teal') && labels.includes('black'));
    // Mironet's black offer has no GTIN and joins the black GTIN variant from MediaMarkt
    const black = main.variants.find((v) => v.colour === 'black');
    assert.equal(black?.offers.length, 2);
    const teal = main.variants.find((v) => v.colour === 'teal');
    assert.equal(teal?.offers.length, 2, 'NAY and Datart share the GTIN');
    const refurb = groups.find((g) => g.condition === 'refurbished');
    assert.ok(refurb && refurb !== main);
    assert.equal(groups.filter((g) => g.level === 'different').length, 2);
  });
  test('the same GTIN under two different titles still forms one product', () => {
    const g = groupOffers([
      offer('Oral-B Pro 3 3000', { title: 'ORAL-B Pro 3 3000 Elektrische Zahnbürste Black', price: 117.62, gtin: '08006540759790' }, 'mm'),
      offer('Oral-B Pro 3 3000', { title: 'Oral-B Pro 3 3000 CrossAction Black', price: 99, gtin: '08006540759790' }, 'x'),
    ]);
    assert.equal(g.length, 1);
    assert.equal(g[0].level, 'exact');
    assert.match(g[0].notes.join(' '), /possibly match/);
  });
  test('an offer joined through an order code but titled as another package does not set the headline', () => {
    const g = groupOffers([
      offer('Bosch GSR 12V-15', { title: 'Aku vŕtačka Bosch GSR 12V-15, 060186810F', price: 133.2 }, 'hornbach'),
      offer('Bosch GSR 12V-15', { title: 'BOSCH 060186810F GSR 12V-15 / Aku Vrtací šroubovák / 12V / 2x2.0Ah / 10mm', price: 100 }, 'mironet'),
    ]);
    assert.equal(g.length, 1);
    assert.equal(g[0].bestItemEur, 133.2);
  });
  test('the product name comes from an offer the user can get: branch first, then delivery to SK', () => {
    // Seen 2026-11-24: "Oral-B iO Series 3" was named "Szczoteczka Oral-B iO Series 3 Pink" (Morele, no SK delivery).
    const q2 = 'Oral-B iO Series 3';
    const at = (o: Offer, ships: boolean | 'unknown') => ({ ...o, shipsToSk: ships, totals: computeTotals(o, { name: o.shopName, ships_to_sk: ships, shipping_to_sk: null }, rates) });
    const morele = at(offer(q2, { title: 'Szczoteczka Oral-B iO Series 3 Pink', price: 277.05, currency: 'PLN', gtin: '08006540731222' }, 'morele'), false);
    const mironet = at(offer(q2, { title: 'Oral-B iO Series 3 Blush Pink / Elektrický zubní kartáček / magnetický iO', price: 1690, currency: 'CZK', gtin: '08006540731222' }, 'mironet'), 'unknown');
    const teta = at(offer(q2, { title: 'Oral B elektrická zubná kefka iO Series 3 ružová', price: 69.99, gtin: '08006540731222' }, 'teta'), true);
    const nay = at(offer(q2, { title: 'Zubná kefka Oral-B iO Series 3 Pink', price: 64.9, gtin: '08006540731222' }, 'nay', 'local'), true);
    assert.equal(groupOffers([morele])[0].title, morele.title, 'last resort');
    assert.equal(groupOffers([morele, mironet])[0].title, mironet.title, 'delivery unknown beats "does not deliver"');
    assert.equal(groupOffers([morele, mironet, teta])[0].title, teta.title);
    assert.equal(groupOffers([morele, teta, nay])[0].title, nay.title);
    assert.equal(groupOffers([morele, teta, nay])[0].level, 'exact', 'the level still comes from the best match');
  });
  test('a product with a price that reaches the user comes before one no shop delivers, at the same level', () => {
    // Seen 2026-11-25 for "Oral-B Pro 3 3000": Morele (no SK delivery) was listed first, ahead of Nazuby.eu.
    const q3 = 'Oral-B Pro 3 3000';
    const at = (o: Offer, ships: boolean) => ({ ...o, shipsToSk: ships, totals: computeTotals(o, { name: o.shopName, ships_to_sk: ships, shipping_to_sk: null }, rates) });
    const morele = at(offer(q3, { title: 'Szczoteczka Oral-B Pro 3 3000 PureClean Czarna', price: 223.76, currency: 'PLN', gtin: '04210201291213' }, 'morele'), false);
    const nazuby = at(offer(q3, { title: 'Oral-B PRO 3000 Blue oscilačná kefka', price: 62.01 }, 'nazuby'), true);
    assert.ok(morele.match.score > nazuby.match.score, 'Morele is the closer match');
    const g = groupOffers([morele, nazuby]);
    assert.deepEqual(g.map((x) => [x.level, x.bestItemEur === null]), [['possible', false], ['possible', true]]);
    assert.equal(g[0].title, nazuby.title);
  });
  test('the product name is the tidied title; the offer keeps the shop title and the product id does not change', () => {
    // a shop search result title of 2026-11-25, used here as an offer title
    const q4 = 'Oral-B iO Series 3';
    const shopTitle = 'ORAL-B IO Series 3 Ice Blue + Cashback 10€ pri nákupe min. za 70€ ORAL-B IO Series 3 Ice Blue + Cashback 10€ pri nákupe min. za 70€';
    const g = groupOffers([offer(q4, { title: shopTitle, price: 69.9 }, 'andreashop')]);
    assert.equal(g[0].title, 'ORAL-B IO Series 3 Ice Blue');
    assert.equal(g[0].variants[0].offers[0].title, shopTitle);
    assert.equal(g[0].id, groupOffers([offer(q4, { title: 'ORAL-B IO Series 3 Ice Blue', price: 69.9 }, 'andreashop')])[0].id);
    // bundle contents are part of the product name
    const datart = offer('Oral-B Pro 3 3500', { title: 'Zubní kartáček Oral-B PRO 3 3500 Cross Action Black + cestovní pouzdro', price: 1299, currency: 'CZK' }, 'datart');
    assert.equal(groupOffers([datart])[0].title, 'Zubní kartáček Oral-B PRO 3 3500 Cross Action Black + cestovní pouzdro');
  });
  test('used and new offers with the same GTIN are not merged', () => {
    const g = groupOffers([
      offer('Oral-B Pro 3 3000', { title: 'Oral-B Pro 3 3000', price: 60, gtin: '08006540759790' }, 'a'),
      offer('Oral-B Pro 3 3000', { title: 'Oral-B Pro 3 3000 rozbalené', price: 40, gtin: '08006540759790' }, 'b'),
    ]);
    assert.equal(g.length, 2);
    assert.equal(g[0].condition, 'new');
  });
});

describe('configurations of one line (workstation test of 2026-11-27)', () => {
  const q = 'HP Z2 Tower G1i';
  test('two part codes of one colour are two products; the same code at two shops is one', () => {
    const groups = groupOffers([
      offer(q, { title: 'HP Z2 Tower G1i, EE7H6ES', price: 5306.65 }, 'datacomp'),
      offer(q, { title: 'HP Z2 Tower G1i, A40MKET', price: 3006.89 }, 'datacomp'),
      offer(q, { title: 'HP Z2 Tower G1i, A40SRET', price: 4750 }, 'datacomp'),
      offer(q, { title: 'Stolný počítač HP Z2 Tower G1i (A40SRET#BCM) čierny', price: 4699, gtin: '00199251749032' }, 'nay'),
    ]);
    assert.equal(groups.length, 3);
    const a40sret = groups.find((g) => g.offerCount === 2);
    assert.ok(a40sret);
    assert.deepEqual(a40sret.variants.flatMap((v) => v.offers.map((o) => o.price)).sort(), [4699, 4750]);
    assert.equal(new Set(groups.map((g) => g.id)).size, 3);
  });
  test('colour variants with their own part codes stay one product', () => {
    const groups = groupOffers([
      offer('iPhone 16 128GB', { title: 'Apple iPhone 16 128GB Black (MYE73SX/A)', price: 829 }),
      offer('iPhone 16 128GB', { title: 'Apple iPhone 16 128GB Teal (MYED3SX/A)', price: 839 }),
      offer('iPhone 16 128GB', { title: 'Apple iPhone 16 128GB Black (MYE73ZD/A)', price: 819 }, 't'),
    ]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].variants.length, 2);
  });
});
