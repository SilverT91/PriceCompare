// The matcher cases the brief requires. Titles are real ones seen at the shops (probe 2026-11-24)
// or written the way those shops name products.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { matchTitle, scoreCandidate, parseQuery, cleanTitle, displayTitle } from '../src/core/matcher.ts';
import { tokenize } from '../src/core/text.ts';

const m = (q: string, title: string, extra: Record<string, string> = {}) => matchTitle(q, { title, ...extra });

describe('tokenizer', () => {
  test('hyphens, units, diacritics', () => {
    assert.deepEqual(tokenize('Oral-B PRO 3-3900'), ['oralb', 'pro', '3', '3900']);
    assert.deepEqual(tokenize('Bosch GSR 12V-15'), ['bosch', 'gsr', '12v15']);
    assert.deepEqual(tokenize('iPhone 16 128 GB'), ['iphone', '16', '128gb']);
    assert.deepEqual(tokenize('2x 2,0 Ah'), ['2x', '2ah']);
    assert.deepEqual(tokenize('Čierna Zahnbürste'), ['cierna', 'zahnburste']);
    assert.deepEqual(tokenize('6.1"'), ['6.1in']);
  });
});

describe('rule 1: model and number tokens of the query must be in the title', () => {
  test('"3000" missing -> different', () => {
    assert.equal(m('Oral-B Pro 3 3000', 'Oral-B Pro 3 Black').level, 'different');
  });
  test('"12V-15" vs 12V-35 -> different', () => {
    assert.equal(m('Bosch GSR 12V-15', 'Bosch GSR 12V-35 Professional').level, 'different');
  });
  test('"128GB" vs 256 GB -> different; "128 GB" written apart still matches', () => {
    assert.equal(m('iPhone 16 128GB', 'Apple iPhone 16 256GB Black').level, 'different');
    assert.equal(m('iPhone 16 128GB', 'Apple iPhone 16 128 GB Black').level, 'exact');
  });
  test('a number token is never matched as a substring ("16" is not in "16e")', () => {
    const r = m('iPhone 16 128GB', 'Mobilný telefón Apple iPhone 16e 128 GB čierny (MD1Q4SX/A)');
    assert.equal(r.level, 'different');
    assert.ok(r.missing.includes('16'));
  });
  test('"Oral B" and "Oral-B", "12V 15" and "12V-15" are the same tokens', () => {
    assert.equal(m('Oral-B Pro 3 3000', 'Oral B Pro 3 3000 Black').level, 'exact');
    assert.equal(m('Bosch GSR 12V-15', 'Bosch GSR 12V 15').level, 'exact');
  });
});

describe('rule 2: an extra distinguishing token makes it a different product', () => {
  const q = 'iPhone 16 128GB';
  for (const t of [
    'APPLE IPHONE 16 PRO 128GB DESERT TITANIUM 128 GB Titan Wüstensand Dual SIM',
    'APPLE IPHONE 16 PLUS 128GB WHITE 128 GB Weiß Dual SIM',
    'Apple iPhone 16 Plus 128 GB čierny',
    'Mobilný telefón Apple iPhone 16e 128 GB čierny (MD1Q4SX/A)',
    'Apple iPhone 16 Pro Max 128GB',
  ]) {
    test(`"${q}" does not match "${t}"`, () => assert.equal(m(q, t).level, 'different'));
  }
  for (const t of [
    'ORAL-B PRO 3-3900 DUOPACK BLACK EDITION Elektrische Zahnbürste Schwarz',
    'Oral-B Pro 3 3900 Duo Pack',
    'Zubná kefka Oral-B PRO 3 Kids Lion King',
    'Oral-B Pro 3 3000 Kids',
    'Oral-B Pro 3 3000 Duopack',
    'Náhradné hlavice Oral-B Pro 3 3000 (4 ks)',
  ]) {
    test(`"Oral-B Pro 3 3000" does not match "${t}"`, () => assert.equal(m('Oral-B Pro 3 3000', t).level, 'different'));
  }
  test('Bosch GSR 12V-15: bare tool, FC and 39-piece kit are three different products', () => {
    const q2 = 'Bosch GSR 12V-15';
    const plain = m(q2, 'Aku vŕtačka Bosch GSR 12V-15, 060186810F', { brand: 'Bosch Professional' });
    const bare = m(q2, 'Bosch Professional GSR 12V-15 solo (bez akumulátora)');
    const fc = m(q2, 'Bosch GSR 12V-15 FC Professional');
    const kit = m(q2, 'Bosch GSR 12V-15 Professional + 39-dielna sada príslušenstva');
    const kitDe = m(q2, 'Bosch Professional GSR 12V-15 Akku-Bohrschrauber 39-tlg. Zubehör-Set');
    assert.equal(plain.level, 'exact');
    for (const r of [bare, fc, kit, kitDe]) assert.equal(r.level, 'different');
    const sigs = new Set([plain.signature, bare.signature, fc.signature, kit.signature]);
    assert.equal(sigs.size, 4, 'each must get its own signature');
    assert.ok(fc.distinguishing.includes('fc'));
    assert.ok(kit.distinguishing.includes('39pc'));
    assert.equal(kit.signature, m(q2, 'Bosch GSR 12V-15 + 39 dielna sada prislusenstva').signature);
  });
  test('Slovak "súprava" is a package word like Czech "souprava"', () => {
    // Teta drogérie, 2026-11-25: a gift set of a brush and a toothpaste
    const r = m('Oral-B Vitality Pro', 'Oral B darčeková súprava Elektrická kefka Vitality Pro Protect X Clean White + Zubná pasta Profesional Gum&Enamel Extra fresh 75 ml');
    assert.equal(r.level, 'different');
    assert.ok(r.distinguishing.includes('suprava'));
  });
  test('the query may itself ask for the variant ("Pro", "Duopack", "FC")', () => {
    assert.equal(m('iPhone 16 Pro 128GB', 'APPLE IPHONE 16 PRO 128GB WHITE TITANIUM').level, 'exact');
    assert.equal(m('Oral-B Pro 3 3000 Duopack', 'Oral-B Pro 3 3000 Duopack čierna').level, 'exact');
    assert.equal(m('Bosch GSR 12V-15 FC', 'Bosch GSR 12V-15 FC Professional').level, 'exact');
  });
});

describe('rule 3: used / refurbished / unpacked items are flagged and never grouped with new ones', () => {
  const q = 'Oral-B Pro 3 3000';
  const fresh = m(q, 'Oral-B Pro 3 3000 čierna');
  const cases: [string, Record<string, string>?][] = [
    ['BAZAR Oral-B Pro 3 3000 čierna'],
    ['Oral-B Pro 3 3000 čierna - rozbalené'],
    ['Oral-B Pro 3 3000 čierna (použité)'],
    ['Oral-B Pro 3 3000 Black refurbished'],
    ['Oral-B Pro 3 3000 Schwarz gebraucht'],
    ['Oral-B Pro 3 3000 čierna', { itemCondition: 'UsedCondition' }],
    ['Oral-B Pro 3 3000 Black', { itemCondition: 'https://schema.org/RefurbishedCondition' }],
    ['Zubná kefka Oral-B Pro 3 3000 s kozmetickou chybou'],
    ['Oral-B Pro 3 3000', { url: 'https://www.nay.sk/bazar/zubna-kefka-oral-b-pro-3-3000' }],
  ];
  for (const [title, extra] of cases) {
    test(`flags "${title}"${extra ? ` ${JSON.stringify(extra)}` : ''}`, () => {
      const r = m(q, title, extra);
      assert.notEqual(r.condition, 'new');
      assert.notEqual(r.signature, fresh.signature);
    });
  }
  test('a new item stays new', () => assert.equal(fresh.condition, 'new'));
  test('"Použitie:" (use) in a spec list and the verb "použít" are not the condition "used"; the adjective is', () => {
    // TPD Euronics and Andreashop, 2026-11-25
    const tpd = 'Typ: Zubná kefka • Použitie: Pre dospelých • Napájanie: Akumulátorové • Počet rýchlostí: 3 ORAL-B Series iO 2 Black + Cashback 10€ pri nákupe min. za 70€';
    assert.equal(m('Oral-B iO Series 2', tpd).condition, 'new');
    assert.equal(m(q, 'Jaký elektrický kartáček Oral-B použít pro obnažené krčky.').condition, 'new');
    for (const w of ['použitý', 'použitá', 'použitého', 'použitou', 'použitých']) assert.equal(m(q, `Oral-B Pro 3 3000 ${w}`).condition, 'used', w);
  });
});

describe('rule 4: colour variants are the same model, colour kept', () => {
  test('black, white and teal iPhone 16 128GB share a signature and differ in colour', () => {
    const q = 'iPhone 16 128GB';
    const a = m(q, 'Mobilný telefón Apple iPhone 16 128 GB čierny (MYE73SX/A)');
    const b = m(q, 'Apple iPhone 16 128GB biela');
    const c = m(q, 'Mobilný telefón Apple iPhone 16 128 GB modrozelený (MYED3SX/A)');
    assert.equal(a.signature, b.signature);
    assert.equal(b.signature, c.signature);
    assert.deepEqual([a.colour, b.colour, c.colour], ['black', 'white', 'teal']);
    for (const r of [a, b, c]) assert.equal(r.level, 'exact');
  });
  test('the JSON-LD color property is used when present', () => {
    assert.equal(m('iPhone 16 128GB', 'Smartfon Apple iPhone 16 128GB', { color: 'Czarny' }).colour, 'black');
  });
});

describe('rule 5: diacritics, case and languages', () => {
  const q = 'Oral-B Pro 3 3000';
  const titles = [
    'Elektrická zubná kefka Oral-B Pro 3 3000 čierna', // sk
    'Elektrický zubní kartáček Oral-B Pro 3 3000 černý', // cs
    'ORAL-B Pro 3 3000 Elektrische Zahnbürste Schwarz', // de
    'Szczoteczka elektryczna Oral-B Pro 3 3000 czarna', // pl
    'Oral-B Pro 3 3000 Electric Toothbrush, Black', // en
    'oral-b PRO 3 3000 ČIERNA',
  ];
  const results = titles.map((t) => m(q, t));
  for (const [i, t] of titles.entries()) {
    test(`exact: ${t}`, () => {
      assert.equal(results[i].level, 'exact', results[i].reasons.join('; '));
      assert.equal(results[i].colour, 'black');
    });
  }
  test('all languages give one signature', () => assert.equal(new Set(results.map((r) => r.signature)).size, 1));
  test('a query with diacritics and category words matches a German title', () => {
    assert.equal(m('zubná kefka Oral-B Pro 3 3000', 'ORAL-B Pro 3 3000 Elektrische Zahnbürste Black').level, 'exact');
  });
});

describe('uncertain matches are "possible", not hidden and not certain', () => {
  test('unknown extra words', () => {
    const r = m('Oral-B Pro 3 3000', 'Oral-B Pro 3 3000 Cross Action čierna');
    assert.equal(r.level, 'possible');
    assert.deepEqual(r.unknownExtras, ['cross', 'action']);
  });
  test('storage variant when the query has none', () => {
    const r = m('iPhone 16', 'Apple iPhone 16 128GB Black');
    assert.equal(r.level, 'possible');
    assert.notEqual(r.signature, m('iPhone 16', 'Apple iPhone 16 256GB Black').signature);
  });
  test('a typo in a word of the query is tolerated but noted', () => {
    const r = m('Bosch GSR 12V-15 Profesional', 'Bosch GSR 12V-15 Professional');
    assert.notEqual(r.level, 'different');
  });
});

describe('found in live runs (2026-11-24)', () => {
  test('another brand and line with the same numbers is different ("Braun Series 3 3000")', () => {
    assert.equal(m('Oral-B Pro 3 3000', 'Braun Series 3 3000 Holiaci strojček | Pilulka.sk').level, 'different');
  });
  test('"Pro 3000" for "Pro 3 3000" is only possible: Dr.Max names the Pro 3 that way, and an older Pro 3000 exists', () => {
    // Seen 2026-11-24: Dr.Max lists "Oral B Elektrická kefka Pro 3000 Blue 1×1 ks" next to "Pro 3500 Black/White"
    // and has no title with "Pro 3 3000"; rejecting it left the shop with no candidate at all.
    for (const t of ['Oral B EK Pro 3000 White 1×1 set', 'Oral B Elektrická kefka Pro 3000 Blue 1×1 ks, elektrická zubná kefka']) {
      const r = m('Oral-B Pro 3 3000', t);
      assert.equal(r.level, 'possible', r.reasons.join('; '));
      assert.match(r.reasons.join('; '), /without "3"/);
    }
    // Only the line digit in front of a model number that starts with it; other numbers stay required.
    assert.equal(m('Oral-B Pro 3 3000', 'Oral B Elktrická kefka Pro 3500 White 1×1 ks').level, 'different');
    assert.equal(m('Oral-B Pro 3 3000', 'Oral-B Pro 3000 Kids').level, 'different');
    assert.equal(m('Oral-B Pro 3 3000', 'Oral-B 3000 Pro').level, 'different');
  });
  test('Dr.Max pack notation "1×1 ks", "1×1 set", "1×150 ml" is one item; "1×2 ks" is two', () => {
    assert.equal(m('Oral-B Pro 3 3000', 'Oral-B Elektrická kefka Pro 3 3000 Blue 1×1 ks').level, 'exact');
    assert.equal(m('Oral-B Pro 3 3000', 'Oral-B Pro 3 3000 Black 1×1 set').level, 'exact');
    assert.notEqual(m('NIVEA Creme 150 ml', 'NIVEA Creme 1×150 ml, univerzálny krém').level, 'different');
    const two = m('Oral-B Pro 3 3000', 'Oral-B Pro 3 3000 Black 1×2 ks');
    assert.equal(two.level, 'different');
    assert.ok(two.distinguishing.includes('2pc'));
  });
  test('words inside an mpn ("Pro 3 3000 Cross Action bk") do not hide extra title words', () => {
    const r = m('Oral-B Pro 3 3000', 'Szczoteczka Oral-B Pro 3 3000 CrossAction Czarna', { mpn: 'Pro 3 3000 Cross Action bk' });
    assert.equal(r.level, 'possible');
  });
  test('Mironet "name / spec / spec" titles: spec numbers are ignored, "2x2.0Ah" (two batteries) is not', () => {
    const r = m('Bosch GSR 12V-15', 'BOSCH 060186810F GSR 12V-15 / Aku Vrtací šroubovák / 12V / 2x2.0Ah / 10mm sklíčidlo / 1300 ot/min / 30 Nm');
    assert.equal(r.level, 'different');
    assert.deepEqual(r.distinguishing, ['2x']);
    assert.deepEqual(r.codes, ['060186810f']);
    assert.equal(m('iPhone 16 128GB', 'Apple iPhone 16 128GB černá / 6.1" / 128GB / iOS18').level, 'exact');
  });
  test('"with battery" in Slovak/Czech is a different package; "12 V" next to "12V-15" is not an extra', () => {
    assert.equal(m('Bosch GSR 12V-15', 'Aku skrutkovač Bosch Professional GSR 12V-15 (s batériou)').level, 'different');
    assert.equal(m('Bosch GSR 12V-15', 'Aku šroubovák Bosch Professional GSR 12V-15 (s baterií)').level, 'different');
    assert.equal(m('Bosch GSR 12V-15', 'Wiertarko-wkrętarka Bosch GSR 12V-15 12 V').level, 'exact');
  });
  test('an Andreashop cashback promotion in the title is not part of the product', () => {
    // Seen 2026-11-24 for "Oral-B iO Series 3": the 10 and 70 of the promotion made it "another product".
    const r = m('Oral-B iO Series 3', 'ORAL-B IO Series 3 Ice Blue  + Cashback 10€ pri nákupe min. za 70€');
    assert.notEqual(r.level, 'different', r.reasons.join('; '));
    assert.equal(m('Oral-B iO Series 3', 'ORAL-B IO Series 3 Ice Blue').signature, r.signature);
    assert.equal(m('Oral-B Pro 3 3000', 'BRAUN ORAL-B PROFESSIONAL CARE 3000 (D20.535) + CASHBACK AŽ 60€').level, 'different', 'the older model stays different');
  });
  test('a title colour wins over a less specific JSON-LD color', () => {
    assert.equal(m('iPhone 16 128GB', 'Smartfon Apple iPhone 16 128GB Teal (MYED3HN/A)', { color: 'Zielony' }).colour, 'teal');
  });
});

describe('part codes and page-title noise', () => {
  test('bracketed codes and shop suffixes are removed', () => {
    assert.equal(cleanTitle('iPhone 16 128 GB čierna | iStores - Apple Premium Partner'), 'iPhone 16 128 GB čierna');
    assert.equal(cleanTitle('Apple iPhone 16 128 GB (MYED3SX/A)'), 'Apple iPhone 16 128 GB');
  });
  test('the product name to show: suffix, appended promotion, spec list and doubled text go; bundle contents and codes stay', () => {
    // titles of shop search results for "Oral-B Pro 3 3000" (2026-11-25); the last but one is hand-written
    assert.equal(displayTitle('ORAL-B IO Series 3 Ice Blue + Cashback 10€ pri nákupe min. za 70€ ORAL-B IO Series 3 Ice Blue + Cashback 10€ pri nákupe min. za 70€', 'Andreashop'),
      'ORAL-B IO Series 3 Ice Blue');
    assert.equal(displayTitle('BRAUN ORAL-B PROFESSIONAL CARE 3000 (D20.535) + CASHBACK AŽ 60€ | Andrea Shop', 'Andreashop'), 'BRAUN ORAL-B PROFESSIONAL CARE 3000 (D20.535)');
    assert.equal(displayTitle('Zubní kartáček Oral-B PRO 3 3500 Cross Action Black + cestovní pouzdro | DATART', 'Datart.cz'),
      'Zubní kartáček Oral-B PRO 3 3500 Cross Action Black + cestovní pouzdro');
    assert.equal(displayTitle('ORAL-B PRO 3 3500 Sensitive Clean White zubná kefka + cestovné puzdro - MojaLekáreň.sk', 'MojaLekáreň.sk'),
      'ORAL-B PRO 3 3500 Sensitive Clean White zubná kefka + cestovné puzdro');
    assert.equal(displayTitle('Typ: Zubná kefka • Použitie: Pre dospelých • Napájanie: Akumulátorové • Počet rýchlostí: 3 ORAL-B Series iO 2 Black + Cashback 10€ pri nákupe min. za 70€', 'TPD Euronics'),
      'ORAL-B Series iO 2 Black');
    assert.equal(displayTitle('Zubná kefka Oral-B iO Series 3 Ice Blue Zubná kefka Oral-B iO Series 3 Ice Blue', 'NAY'), 'Zubná kefka Oral-B iO Series 3 Ice Blue');
    assert.equal(displayTitle('ORAL-B Vitality PRO D103+Vitality Kids D100 Frozen ORAL-B Vitality PRO D103+Vitality Kids D100 Frozen', 'Andreashop'),
      'ORAL-B Vitality PRO D103+Vitality Kids D100 Frozen');
    assert.equal(displayTitle('Oral-B Pro 3 3000 Cross Action + CASHBACK 10 €'), 'Oral-B Pro 3 3000 Cross Action');
    assert.equal(displayTitle('Oral-B Pro 3 3000 Cross Action'), 'Oral-B Pro 3 3000 Cross Action');
  });
  test('order numbers do not count as distinguishing tokens', () => {
    assert.equal(m('Bosch GSR 12V-15', 'Aku vŕtačka Bosch GSR 12V-15, 060186810F').level, 'exact');
    assert.equal(m('iPhone 16 128GB', 'Smartfon Apple iPhone 16 128GB Black MYE73', { mpn: 'MYE73' }).level, 'exact');
  });
});

describe('candidate scoring (search results before fetching)', () => {
  const pq = parseQuery('iPhone 16 128GB');
  test('slug-only candidate with a size like 6.1 -> "61" is not rejected', () => {
    const r = scoreCandidate(pq, '', 'https://www.mironet.cz/apple-iphone-16-128gb-cerna-61-128gb-ios18+dp702612/');
    assert.notEqual(r.level, 'different');
  });
  test('slug with "pro" rejects', () => {
    const r = scoreCandidate(pq, 'APPLE IPHONE 16 128GB', 'https://www.mediamarkt.de/de/product/_apple-iphone-16-pro-128-gb-beige-dual-sim-145402270.html');
    assert.equal(r.level, 'different');
  });
  test('review, comparison and manual pages are not product candidates', () => {
    // Seen 2026-11-24: Nazuby.eu's own search listed "RECENZIA: elektrická kefka Oral-B PRO 3 3000" and two such
    // pages were fetched instead of products; Datart's "/navod/" manual page repeated the product's offer.
    const pq2 = parseQuery('Oral-B Pro 3 3000');
    for (const [title, url] of [
      ['RECENZIA: elektrická kefka Oral-B PRO 3 3000 RECENZIA: elektrická kefka Oral-B PRO 3 3000', 'https://www.nazuby.eu/recenzia-elektricka-kefka-oral-b-pro-3-3000'],
      ['Návod pro Zubní kartáček Oral-B Pro 3 3000 | DATART', 'https://www.datart.cz/navod/zubni-kartacek-oral-b-pro-3-3000.html'],
      ['Oral-B Pro 3 3000 - recenzie a skúsenosti', 'https://www.pilulka.sk/oral-b-pro-3-3000/recenzie-skusenosti'],
      // Nazuby.eu, 2026-11-25: an advice article
      ['Jaký elektrický kartáček Oral-B použít pro obnažené krčky.', 'https://www.nazuby.eu/aku-elektricku-kefku-oral-b-pouzit-pre-obnazene-krcky'],
    ]) assert.equal(scoreCandidate(pq2, title, url).level, 'different', title);
    assert.notEqual(scoreCandidate(pq2, 'Oral-B Pro 3 3000 čierna', 'https://www.nazuby.eu/oral-b-pro-3-3000-cierna').level, 'different');
  });
  test('bazar URL ranks below the new item', () => {
    const pq2 = parseQuery('Oral-B Pro 3 3000');
    const a = scoreCandidate(pq2, 'Oral-B Pro 3 3000', 'https://www.nay.sk/zubna-kefka-oral-b-pro-3-3000');
    const b = scoreCandidate(pq2, 'Oral-B Pro 3 3000', 'https://www.nay.sk/bazar/zubna-kefka-oral-b-pro-3-3000');
    assert.ok(a.score > b.score);
  });
});
