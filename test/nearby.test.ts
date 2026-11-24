// Similar models the shops list (src/core/nearby.ts). Titles and URLs are from a live search for
// "Oral-B Pro 3 3000" on 2026-11-25 unless marked as hand-written.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { matchTitle, parseQuery } from '../src/core/matcher.ts';
import { deriveName, familyTokens, nearbyDistance, nearbyModels, NEARBY_LIMIT, productPart } from '../src/core/nearby.ts';
import type { Candidate, Offer, ShopResult, Totals } from '../src/core/types.ts';

const Q = 'Oral-B Pro 3 3000';
const pq = parseQuery(Q);

const SHOPS: Record<string, [string, 'local' | 'online']> = {
  planeo_sk: ['Planeo Elektro', 'local'],
  nay_sk: ['NAY', 'local'],
  profimed_eu: ['Profimed', 'local'],
  mojalekaren_sk: ['MojaLekáreň.sk', 'online'],
  datart_cz: ['Datart.cz', 'online'],
  teta_sk: ['Teta drogérie', 'online'],
  pilulka_sk: ['Pilulka.sk', 'online'],
  nazuby_eu: ['Nazuby.eu', 'online'],
  andreashop_sk: ['Andreashop', 'online'],
  tpd_sk: ['TPD Euronics', 'online'],
  sanitino_sk: ['Sanitino.sk', 'online'],
  morele_net: ['Morele.net', 'online'],
  h: ['Shop H', 'online'],
  m: ['Shop M', 'online'],
};

const totals = (itemEur: number | null): Totals => ({
  itemEur, shippingEur: null, shippingSource: 'unknown', shippingNote: '', totalEur: null, pickupEur: null, pickupTotalEur: null,
  pickupNote: '', deliversToSk: 'unknown', bestTotalEur: null, bestTotalKind: null, rate: 1, rateDate: null,
});

function offer(shopId: string, title: string, url: string, price: number): Offer {
  const [shopName, section] = SHOPS[shopId];
  return {
    shopId, url, title, brand: 'Oral-B', gtin: null, sku: null, mpn: null, color: null, price, currency: 'EUR', availability: 'InStock',
    itemCondition: null, seller: null, shipping: [], source: 'Product', shopName, section, shipsToSk: true, branchKnown: section === 'local',
    match: matchTitle(pq, { title, brand: 'Oral-B', url, shopName }), totals: totals(price),
  };
}

function shop(shopId: string, cands: [string, string][], offers: Offer[] = []): ShopResult {
  const [shopName, section] = SHOPS[shopId];
  const candidates: Candidate[] = cands.map(([title, url]) => ({ title, url, from: 'search_provider' }));
  return {
    shopId, shopName, domain: `${shopId}.test`, section, status: 'no_match', detail: '', route: 'search_provider', manualUrl: null,
    offers, candidates, requestsUsed: 0, fromCache: true, ms: 0,
  };
}

/** The name derived from one title, as nearbyModels() derives it. */
function nameOf(title: string, shopName?: string) {
  const text = productPart(title, shopName);
  return deriveName(text, matchTitle(pq, { title: text, shopName }));
}

const names = (results: ShopResult[]) => nearbyModels(pq, results).models.map((m) => m.query);

describe('family rule', () => {
  test('the family tokens of the query are the brand and line words', () => {
    assert.deepEqual(familyTokens(pq), ['oralb']);
    assert.deepEqual(familyTokens(parseQuery('iPhone 16 128GB')), ['iphone']);
    assert.deepEqual(familyTokens(parseQuery('Bosch GSR 12V-15')), ['bosch', 'gsr']);
  });

  test('Oral-B neighbours are in; other brands are out', () => {
    const r = [
      shop('planeo_sk', [['Zubná kefka Oral B PRO 3 3500 CROSS ACTION | Planeo', 'https://www.planeo.sk/oral-b-pro-3-3500-cross-action']]),
      shop('teta_sk', [['Oral B elektrická zubná kefka iO Series 3 bledá modrá | Teta drogérie eshop',
        'https://www.tetadrogerie.sk/produkty/Elek-a-bater-zubne-kefky-a-sprchy/D160500-Oral-B-elektricka-zubna-kefka-iO-Series-3-bleda-modra/']]),
      // hand-written: the same numbers under another brand
      shop('nay_sk', [['Braun Series 3 3000s holiaci strojček', 'https://www.nay.sk/braun-series-3-3000s'],
        ['Philips Sonicare 3100 HX3671/14 zubná kefka', 'https://www.nay.sk/philips-sonicare-3100-hx3671-14']]),
    ];
    // the brand in the query's spelling ("Oral B" in both titles)
    assert.deepEqual(names(r).sort(), ['Oral-B PRO 3 3500', 'Oral-B iO Series 3']);
  });

  test('a page that only names the brand or a broader line is not a model', () => {
    const r = [
      shop('datart_cz', [['Oral-B PRO produkty | DATART', 'https://www.datart.cz/sis-oral-b-pro.html']]),
      shop('pilulka_sk', [['OralB - Zľava až do 22% | Pilulka.sk', 'https://www.pilulka.sk/oralb'],
        ['Oral-B - Zľava až do 58% | Pilulka.sk', 'https://www.pilulka.sk/dentalna-hygiena-oral-b']]),
    ];
    assert.deepEqual(names(r), []);
  });
});

describe('left out', () => {
  test('accessories, toothpaste and article pages', () => {
    const r = [
      shop('pilulka_sk', [['Oral-B Pro 3D White náhradné hlavice 2 ks | Pilulka.sk', 'https://www.pilulka.sk/oral-b-pro-3d-white-kartackove-hlavy-2-ks']]),
      shop('sanitino_sk', [['Oral-B - Náhradná hlavica Sensi UltraThin, biela, 10 ks 4210201176923 | Sanitino.sk',
        'https://www.sanitino.sk/oral-b-nahradna-hlavica-sensi-ultrathin-biela-10-ks-4210201176923']]),
      shop('nazuby_eu', [['Oral-B Pro 3Dwhite Clinical Intensive Whitening Bright Brilliance zubná pasta 75 ml - Nazuby.eu',
        'https://www.nazuby.eu/oral-b-pro-3dwhite-clinical-intensive-whitening-bright-brilliance-zubna-pasta-75-ml']]),
      // hand-written, in the form of review titles seen earlier
      shop('mojalekaren_sk', [['RECENZIA: elektrická kefka Oral-B PRO 3 3500', 'https://www.mojalekaren.sk/blog/recenzia-oral-b-pro-3-3500/']]),
    ];
    assert.deepEqual(names(r), []);
  });

  test('used or ex-display items, also when the condition word follows the bundle', () => {
    const r = [shop('tpd_sk', [['ORAL-B PRO 3 3500 - Elektrická zubná kefka Cross Action Black + CP vystavený kus', 'https://www.tpd.sk/oral-b-pro-3-3500-p241007']])];
    assert.deepEqual(names(r), []);
  });

  test("the query's own model in a bundle is not a nearby model", () => {
    const r = [shop('morele_net', [['Oral-B Szczoteczka rotacyjna Pro 3 3000 Sensitive Czarna + końcówka - Szczoteczka - Morele.net',
      'https://www.morele.net/szczoteczka-oral-b-szczoteczka-rotacyjna-pro-3-3000-sensitive-czarna-koncowka-11811144/']])];
    assert.deepEqual(names(r), []);
  });

  test('a page that is the source of a matching offer is left out', () => {
    // hand-written: the candidate title says 3500, but the page read gave a matching 3000 offer
    const url = 'https://h.test/p/1';
    const r = [shop('h', [['Oral-B Pro 3 3500 Black', url]], [offer('h', 'Oral-B Pro 3 3000 Black', url, 59.9)])];
    assert.deepEqual(names(r), []);
    // hand-written: one page with two variants, one of them the query's model
    const two = [shop('h', [], [offer('h', 'Oral-B Pro 3 3000 Black', url, 59.9), offer('h', 'Oral-B Pro 3 3500 Black', url, 64.9)])];
    assert.deepEqual(names(two), []);
    assert.deepEqual(names([shop('h', [], [offer('h', 'Oral-B Pro 3 3500 Black', url, 64.9)])]), ['Oral-B Pro 3 3500']);
  });
});

describe('name derivation', () => {
  test('from the first matched word to the last placed word; category, colour and trailing words dropped', () => {
    assert.equal(nameOf('ORAL-B PRO 3 3500 Sensitive Clean White zubná kefka + cestovné puzdro - MojaLekáreň.sk', 'MojaLekáreň.sk'), 'ORAL-B PRO 3 3500');
    assert.equal(nameOf('Oral B elektrická zubná kefka iO Series 3 bledá modrá | Teta drogérie eshop', 'Teta drogérie'), 'Oral B iO Series 3');
    assert.equal(nameOf('Zubná kefka Oral-B iO Series 3 Ice Blue Zubná kefka Oral-B iO Series 3 Ice Blue', 'NAY'), 'Oral-B iO Series 3');
    assert.equal(nameOf('Oral-B Elektrická kefka Pro 3500 White | Pilulka.sk', 'Pilulka.sk'), 'Oral-B Pro 3500');
    assert.equal(nameOf('BRAUN ORAL-B PROFESSIONAL CARE 3000 (D20.535) + CASHBACK AŽ 60€ | Andrea Shop', 'Andreashop'), 'ORAL-B PROFESSIONAL CARE 3000');
    assert.equal(nameOf('Oral B elektrická zubná kefka iO Series 3 duo čierna a bledá modrá | Teta drogérie eshop', 'Teta drogérie'), 'Oral B iO Series 3 duo');
    assert.equal(nameOf('Oral-B Vitality Pro fialový / Elektrický zubní kartáček / oscilační / 3 režimy / časovač', 'Mironet.cz'), 'Oral-B Vitality Pro');
    // TPD Euronics: a spec list in front of the name; its "3" (speeds) is not part of the name
    const tpd = 'Typ: Zubná kefka • Použitie: Pre dospelých • Napájanie: Akumulátorové • Počet rýchlostí: 3 ORAL-B Series iO 2 Black + Cashback 10€ pri nákupe min. za 70€';
    assert.equal(productPart(tpd, 'TPD Euronics'), 'ORAL-B Series iO 2 Black');
    const pq2 = parseQuery('Oral-B iO Series 3');
    const text = productPart(tpd, 'TPD Euronics');
    assert.equal(deriveName(text, matchTitle(pq2, { title: text }), null, familyTokens(pq2)), 'ORAL-B Series iO 2');
    // hand-written, the example of the feature request
    assert.equal(nameOf('Elektrická zubná kefka Oral-B Pro 3 3500 Black + cestovné puzdro'), 'Oral-B Pro 3 3500');
  });

  test('the URL slug stands in when the title names nothing of the query, or is missing', () => {
    const r = [
      shop('mojalekaren_sk', [['Oscilačné zubné kefky, magnetické zubné kefky - MojaLekáreň.sk', 'https://mojalekaren.sk/oral-b-pro-3-3900-cross-action-duo-elektricke-zubne-kefky']]),
      shop('planeo_sk', [['', 'https://www.planeo.sk/oral-b-pro-3-3500-cross-action']]),
    ];
    // the brand in the query's spelling; the rest as the slug writes it
    assert.deepEqual(names(r).sort(), ['Oral-B pro 3 3500', 'Oral-B pro 3 3900 cross action duo']);
  });

  test('self-check: a name that does not find its own listing again is left out', () => {
    // "Set" before the brand is not in the name, and it makes the listing another product for that name.
    const title = 'Set zubních kartáčků Oral-B PRO 3 3900 Cross Action DUO | DATART';
    const name = nameOf(title, 'Datart.cz');
    assert.equal(name, 'Oral-B PRO 3 3900 Cross Action DUO');
    assert.equal(matchTitle(parseQuery(name as string), { title: productPart(title, 'Datart.cz') }).level, 'different');
    assert.deepEqual(names([shop('datart_cz', [[title, 'https://www.datart.cz/set-zubnich-kartacku-oral-b-pro-3-3900-cross-action-duo.html']])]), []);
  });
});

// The 3500 as four shops list it.
const PRO3500 = [
  shop('planeo_sk', [
    ['Zubná kefka Oral B PRO 3 3500 CROSS ACTION | Planeo', 'https://www.planeo.sk/oral-b-pro-3-3500-cross-action'],
    ['Zubná kefka Oral B PRO 3 3500 SENSITIVE CL. | Planeo', 'https://www.planeo.sk/oral-b-pro-3-3500-sensitive-cl'],
  ]),
  shop('mojalekaren_sk', [['ORAL-B PRO 3 3500 Sensitive Clean White zubná kefka + cestovné puzdro - MojaLekáreň.sk',
    'https://www.mojalekaren.sk/oral-b-pro-3-3500-sensitive-clean-white-zubna-kefka-cestovne-puzdro/']]),
  shop('datart_cz', [['Zubní kartáček Oral-B PRO 3 3500 Cross Action Black + cestovní pouzdro | DATART',
    'https://www.datart.cz/zubni-kartacek-oral-b-pro-3-3500-cross-action-black-cestovni-pouzdro.html']]),
  shop('nay_sk', [['Oral-B Pro3 3500 SC+TC zubná kefka | Nay.sk', 'https://www.nay.sk/oral-b-pro3-3500-sc-tc-zubna-kefka']]),
];

describe('clustering and ordering', () => {
  test('one model across shops, one entry per shop, the name in the form most shops use', () => {
    const { models, total } = nearbyModels(pq, PRO3500);
    assert.equal(total, 1);
    const m = models[0];
    assert.equal(m.query, 'Oral-B PRO 3 3500');
    assert.deepEqual(m.shops.map((s) => s.shopName), ['Planeo Elektro', 'MojaLekáreň.sk', 'Datart.cz', 'NAY']);
    assert.equal(m.shops[0].title, 'Zubná kefka Oral B PRO 3 3500 CROSS ACTION | Planeo', 'the title as the shop wrote it');
    assert.equal(m.differs, 'has "3500", lacks "3000"');
    assert.equal(m.distance, 1, 'one number for another is one step');
    assert.equal(m.seenPrice, null, 'no page of it was read');
  });

  test('distance: a swapped number 1, a tier or package word 2, anything else 1', () => {
    assert.equal(nearbyDistance(['3000'], ['3500']), 1);
    assert.equal(nearbyDistance(['3', '3000'], ['3500']), 2);
    assert.equal(nearbyDistance(['3000'], ['kids']), 3);
    assert.equal(nearbyDistance(['pro', '3000'], []), 3);
    assert.equal(nearbyDistance(['3000'], ['3900', 'duo']), 3);
    assert.equal(nearbyDistance(['3', '3000'], []), 2);
    assert.equal(nearbyDistance(['3000'], ['2pc']), 3, 'a pack count is a package');
  });

  test('the same line with another number first; then the models most shops list, then distance, then a local branch', () => {
    const r = [
      ...PRO3500,
      shop('pilulka_sk', [['Oral-B Elektrická kefka Pro 3500 White | Pilulka.sk', 'https://www.pilulka.sk/oral-b-elektricka-kefka-pro-3500-white']]),
      shop('nazuby_eu', [['Oral-B PRO 3500 Black oscilačná kefka - Nazuby.eu', 'https://www.nazuby.eu/oral-b-pro-3500-black-oscilacna-kefka'],
        ['Braun Oral-B TriZone 3000 zubná kefka - Nazuby.eu', 'https://www.nazuby.eu/braun-oral-b-trizone-3000-zubna-kefka']]),
      shop('profimed_eu', [['Oral-B Professional Care 3000 oscilačno-rotačná kefka - Profimed.eu', 'https://www.profimed.eu/oral-b-professional-care-3000-oscilacno-rotacna-kefka-p2543']]),
      shop('planeo_sk', [['Zubná kefka Oral B PRO 3 3900 CROSS ACTION | Planeo', 'https://planeo.sk/katalog/1317999-oral-b-pro-3-3900-cross-action-zubna-kefka.html']]),
      shop('teta_sk', [['Oral B elektrická zubná kefka iO Series 3 bledá modrá | Teta drogérie eshop',
        'https://www.tetadrogerie.sk/produkty/Elek-a-bater-zubne-kefky-a-sprchy/D160500-Oral-B-elektricka-zubna-kefka-iO-Series-3-bleda-modra/']]),
      shop('nay_sk', [['Zubná kefka Oral-B iO Series 3 Ice Blue Zubná kefka Oral-B iO Series 3 Ice Blue', 'https://www.nay.sk/zubna-kefka-oral-b-io-series-3-ice-blue']]),
      shop('andreashop_sk', [['ORAL-B IO Series 3 PINK + Cashback 10€ pri nákupe min. za 70€ ORAL-B IO Series 3 PINK + Cashback 10€ pri nákupe min. za 70€',
        'https://www.andreashop.sk/oral-b-io-series-3-pink-p318647']]),
    ];
    const { models } = nearbyModels(pq, r);
    assert.deepEqual(models.map((m) => [m.query, m.distance, m.shops.length]), [
      // tier 1: the same line with another number, by shops
      ['Oral-B PRO 3 3500', 1, 4],
      ['Oral-B PRO 3 3900', 1, 1],
      // tier 2: by shops, then distance, then a local branch
      ['Oral-B iO Series 3', 3, 3],
      ['Oral-B Pro 3500', 2, 2],
      ['Oral-B Professional Care 3000', 3, 1], // Profimed has a Košice branch
      ['Oral-B TriZone 3000', 3, 1],
    ]);
    assert.equal(models[4].differs, 'lacks "pro", "3"');
  });

  test(`at most ${NEARBY_LIMIT}, with the total`, () => {
    const r = [
      ...PRO3500,
      shop('planeo_sk', [
        ['Zubná kefka Oral B PRO 3 3900 CROSS ACTION | Planeo', 'https://planeo.sk/katalog/1317999-oral-b-pro-3-3900-cross-action-zubna-kefka.html'],
        ['Zubná kefka Oral B Pro 3 Junior - Frozen | Planeo', 'https://www.planeo.sk/oral-b-pro-3-junior-frozen'],
        ['Oscilačná zubná kefka Oral B Pro Kids 3+ Lion King | Planeo', 'https://www.planeo.sk/oral-b-pro-kids-3plus-lion-king'],
      ]),
      shop('teta_sk', [
        ['Oral B elektrická zubná kefka iO Series 3 bledá modrá | Teta drogérie eshop', 'https://www.tetadrogerie.sk/produkty/x/D160500-Oral-B-iO-Series-3-bleda-modra/'],
        ['Oral B elektrická zubná kefka PRO Series 1 Caribbean blue | Teta drogérie eshop', 'https://www.tetadrogerie.sk/produkty/x/D160496-Oral-B-PRO-Series-1-Caribbean-blue/'],
      ]),
      shop('nay_sk', [['Zubná kefka Oral-B PRO 3 Kids Lion King', 'https://www.nay.sk/zubna-kefka-oral-b-pro-3-kids-lion-king']]),
      shop('andreashop_sk', [['ORAL-B Precision Clean Pro ORAL-B Precision Clean Pro', 'https://www.andreashop.sk/oral-b-precision-clean-pro-p318652']]),
      shop('pilulka_sk', [['Oral-B Elektrická kefka Pro 3500 White | Pilulka.sk', 'https://www.pilulka.sk/oral-b-elektricka-kefka-pro-3500-white']]),
      shop('profimed_eu', [['Oral-B Professional Care 3000 oscilačno-rotačná kefka - Profimed.eu', 'https://www.profimed.eu/oral-b-professional-care-3000-oscilacno-rotacna-kefka-p2543']]),
    ];
    const { models, total } = nearbyModels(pq, r);
    assert.equal(total, 10);
    assert.equal(models.length, NEARBY_LIMIT);
    assert.ok(!models.some((m) => m.query === 'Oral B PRO Series 1'), 'the farthest are cut');
  });
});

describe('seen price', () => {
  test('the lowest item price of a read page of the model, with its shop; unread listings have none', () => {
    // hand-written shops in the pipeline test's form: pages that were read and turned out to be the 3500
    const r = [
      shop('h', [], [offer('h', 'Oral-B Pro 3 3500 Black', 'https://h.test/p/old', 64.9)]),
      shop('m', [], [offer('m', 'Oral-B Pro 3 3500 A', 'https://m.test/p/a', 70), offer('m', 'Oral-B Pro 3 3500 B', 'https://m.test/p/b', 61)]),
      ...PRO3500,
    ];
    const { models } = nearbyModels(pq, r);
    assert.equal(models.length, 1);
    assert.equal(models[0].shops.length, 6);
    assert.deepEqual(models[0].seenPrice, { eur: 61, shopName: 'Shop M' });
    assert.equal(models[0].shops.find((s) => s.shopId === 'm')?.url, 'https://m.test/p/a', 'one entry for the shop');
  });
});
