// The matcher cases the brief requires. Titles are real ones seen at the shops (probe 2026-11-24)
// or written the way those shops name products.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  matchTitle, scoreCandidate, parseQuery, cleanTitle, coreQuery, displayTitle, linkInput, namesSomething, specList, withoutPackageWords,
} from '../src/core/matcher.ts';
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

describe('a model number glued to its line word, and a pack of two (the sentence a user typed, 2026-11-25)', () => {
  // Titles written the way shops name the iO Series 9 two-handle pack; the queries are the ones measured.
  const TITLES = {
    duopack: 'Oral-B iO 9 Duopack',
    seriesDuo: 'Oral-B iO Series 9 Duo Black Onyx + Rose Quartz',
    duoTwoPieces: 'Zubná kefka Oral-B iO Series 9 Duo, 2 ks',
    gluedDuoPack: 'Oral-B iO9 Duo Pack',
    single: 'Oral-B iO Series 9 Black Onyx',
  };
  const lvl = (q: string, t: string) => m(q, t).level;

  test('"Oral-B io9 doublepack" (the corrected typed query) finds every way of writing the duo pack', () => {
    const q = 'Oral-B io9 doublepack';
    assert.equal(lvl(q, TITLES.duopack), 'exact');
    assert.equal(lvl(q, TITLES.duoTwoPieces), 'exact', 'iO Series 9 = io9, Duo = doublepack, "2 ks" next to Duo is no extra count');
    assert.equal(lvl(q, TITLES.gluedDuoPack), 'exact');
    const colours = m(q, TITLES.seriesDuo);
    assert.equal(colours.level, 'possible', 'colour names the matcher does not know');
    assert.deepEqual([colours.missing, colours.distinguishing], [[], []]);
    assert.equal(lvl('Oral b io9 doublepack', TITLES.duopack), 'exact', 'the brand written as two words');
  });

  test('"Oral-B iO 9 duopack" and "Oral-B iO Series 9 Duo" find each other\'s forms', () => {
    assert.equal(lvl('Oral-B iO 9 duopack', TITLES.duopack), 'exact');
    assert.deepEqual(m('Oral-B iO 9 duopack', TITLES.seriesDuo).missing, []);
    assert.equal(lvl('Oral-B iO 9 duopack', TITLES.duoTwoPieces), 'exact');
    assert.equal(lvl('Oral-B iO Series 9 Duo', TITLES.duoTwoPieces), 'exact', 'no extra "2pc"');
    assert.equal(lvl('Oral-B iO Series 9 Duo', TITLES.gluedDuoPack), 'exact', '"iO9" = "iO Series 9", "Duo Pack" = "Duo"');
    assert.equal(lvl('Oral-B iO 9 Duo', 'Oral-B iO9 Duo'), 'exact');
    for (const two of ['Twin Pack', 'twinpack', 'Doppelpack', 'double pack', 'dvojbalenie', 'dvojbalení', 'Duo-Pack']) {
      assert.equal(lvl('Oral-B iO Series 9 Duo', `Oral-B iO Series 9 ${two}`), 'exact', two);
    }
  });

  test('NAY, 2026-11-25: a set word next to the two-pack word is no extra (search result title, doubled by the page)', () => {
    const nay = 'Súprava zubných kefiek Oral-B iO9 Series Duo Pack Black Súprava zubných kefiek Oral-B iO9 Series Duo Pack Black';
    const url = 'https://www.nay.sk/suprava-zubnych-kefiek-oral-b-io9-series-duo-pack-black';
    const r = m('Oral-B io9 doublepack', nay);
    assert.equal(r.level, 'exact');
    assert.deepEqual([r.missing, r.distinguishing], [[], []]);
    assert.equal(scoreCandidate(parseQuery('Oral-B io9 doublepack'), nay, url).level, 'exact', 'the candidate score accepts it too');
    assert.equal(lvl('Oral-B iO Series 9 Duo', 'Oral-B iO Series 9 Duo sada'), 'exact');
    // without the two-pack word a set word stays what it is
    assert.deepEqual(m('Oral-B iO Series 9', 'Súprava zubných kefiek Oral-B iO Series 9 Black').distinguishing, ['suprava']);
    assert.equal(lvl('Oral-B io9 doublepack', 'Oral-B iO Series 9 set'), 'different', 'a duo query is not a title that only says "set"');
    assert.deepEqual(m('Oral-B iO Series 9 Duo', 'Oral-B iO Series 9 Duo Family').distinguishing, ['family'], 'another package word stays');
  });

  test('the query without its package words, for a repeated shop search', () => {
    assert.equal(withoutPackageWords('Oral-B io9 doublepack'), 'Oral-B io9');
    assert.equal(withoutPackageWords('Oral-B iO 9 double pack'), 'Oral-B iO 9');
    assert.equal(withoutPackageWords('Oral-B iO Series 9 Duo'), 'Oral-B iO Series 9');
    assert.equal(withoutPackageWords('Oral-B io9'), null, 'no package word');
    assert.equal(withoutPackageWords('duopack'), null, 'nothing else');
  });

  test('a different package stays a different product', () => {
    assert.equal(lvl('Oral-B io9 doublepack', TITLES.single), 'different', 'the duo pack is not the single brush');
    assert.deepEqual(m('Oral-B io9 doublepack', TITLES.single).missing, ['duo']);
    assert.equal(lvl('Oral-B iO Series 9', TITLES.duoTwoPieces), 'different', 'a query without a pack word is not the duo pack');
    assert.deepEqual(m('Oral-B iO Series 9', TITLES.gluedDuoPack).distinguishing, ['duo']);
    assert.equal(lvl('Oral-B iO Series 9 Duo', 'Oral-B iO Series 9 Trio'), 'different', 'a trio is another package');
    assert.deepEqual(m('Oral-B iO Series 9 Duo', 'Oral-B iO Series 9 Duo, 3 ks').distinguishing, ['3pc'], 'only a count of 2 joins "Duo"');
    // a bare piece count stays a count: not the duo concept
    const bare = m('Oral-B io9 doublepack', 'Oral-B iO Series 9, 2 ks');
    assert.equal(bare.level, 'different');
    assert.deepEqual([bare.missing, bare.distinguishing], [['duo'], ['2pc']]);
    assert.equal(lvl('Oral-B iO Series 9 2 ks', 'Oral-B iO Series 9, 2 ks'), 'exact');
  });

  test('glued and apart: the same number only, close together, not after a connector word', () => {
    assert.equal(lvl('Oral-B iO9', 'Oral-B iO Series 90'), 'different', '"90" is not "9"');
    assert.equal(lvl('Oral-B iO9', 'Oral-B iO Series 9N'), 'different', '"9n" is not "9"');
    assert.equal(lvl('Oral-B iO9', 'Oral-B iO Series 9'), 'exact');
    // Datart, 2026-11-25: the model written once more, glued, is no extra model number
    assert.equal(lvl('Oral-B iO Series 3', 'Zubní kartáček Oral-B iO Series 3 iO3 Pink'), 'exact');
    assert.equal(lvl('Oral-B iO Series 3', 'Oral-B iO Series 3 iO4 Pink'), 'different', 'another number glued stays another model');
    // "s24": an "S" and a "24" in one title are not the model
    assert.equal(lvl('Samsung Galaxy S24', 'Samsung Galaxy A55 s nabíjačkou, záruka 24 mesiacov'), 'different');
    assert.equal(lvl('Samsung Galaxy S24', 'Samsung Galaxy A15 s 2 rokmi záruky 24'), 'different');
    // "Pro 3 3000" as before
    assert.equal(lvl('Oral-B Pro 3 3000', 'Oral-B Pro 3000'), 'possible');
    assert.equal(lvl('Oral-B Pro 3 3000', 'Oral-B Pro3 3000'), 'exact');
    assert.equal(lvl('Oral-B Pro 3 3000', 'Oral-B Pro 3 3500'), 'different');
  });
});

describe('PC components (titles from a live run, 2026-11-25)', () => {
  const lvl = (q: string, t: string) => m(q, t).level;

  test('Samsung 990 Pro 2TB: interface and part-type words and "2 TB" written apart are the same SSD; other capacities are not', () => {
    const q = 'Samsung 990 Pro 2TB';
    for (const t of ['Samsung SSD 990 PRO NVMe, M.2 SSD 2 TB', 'Samsung 990 PRO NVMe M.2 SSD, 2 TB', 'SSD Samsung 990 PRO 2TB (MZ-V9P2T0BW)',
      'SAMSUNG 990 PRO 2TB / SSD / M.2 NVMe PCI-E 4.0 / TLC / R:7450 MBps / W:6900 MBps']) {
      assert.equal(lvl(q, t), 'exact', t);
    }
    for (const t of ['Samsung 990 PRO 1TB', 'Samsung 990 PRO 4TB']) assert.equal(lvl(q, t), 'different', t);
  });

  test('rule 1: neutral specifications are ignored (interface and its version, clock, transfer rate, bus width, port counts)', () => {
    assert.equal(lvl('Samsung 990 Pro 2TB', 'Samsung 990 PRO 2TB PCIe 4.0 x4 NVMe 7450 MB/s 256-bit'), 'exact');
    assert.equal(lvl('ryzen 7 9800x3d', 'AMD RYZEN 7 9800X3D @ 4.7GHz'), 'exact');
    const pny = m('rtx 5070 ti', 'PNY GeForce RTX 5070 Ti OC / Grafická karta / 16 GB GDDR7 / 256-bit / 1x HDMI + 3x DP / 750W (1...');
    assert.equal(pny.level, 'possible', 'was different: "3x DP" was read as a pack of three');
    assert.deepEqual(pny.distinguishing, []);
    assert.equal(lvl('rtx 5070 ti', 'ASUS ProArt GeForce RTX 5070 Ti OC / Grafická karta / 16 GB GDDR7 / 256-bit / 1x HDMI + 2x DP + ...'), 'possible');
  });

  test('rule 1: a variant the query does not mention is "possible"; one it mentions must agree', () => {
    const fury = m('kingston fury 32gb ddr5', 'Kingston Fury Beast 32GB DDR5 6000MHz CL30');
    assert.equal(fury.level, 'possible');
    assert.deepEqual(fury.specExtras, ['6000mhz', 'cl30']);
    assert.equal(lvl('kingston fury 32gb ddr5 6000', 'Kingston Fury Beast 32GB DDR5 5600MHz'), 'different', 'another memory speed');
    assert.equal(lvl('kingston fury 32gb ddr5 6000', 'Kingston Fury Beast 64GB DDR5 6000MHz'), 'different', 'another capacity');
    assert.equal(lvl('kingston fury 32gb ddr5 6000', 'Kingston Fury Beast 32GB DDR4 6000MHz'), 'different', 'another memory type');
    assert.equal(lvl('notebook lenovo ideapad slim 5 16', 'Lenovo IdeaPad Slim 5 14" WUXGA'), 'different', 'another screen size');
  });

  test('rule 2: a bare number meets the same number with a frequency unit; not "3000 mAh"', () => {
    const q = 'kingston fury 32gb ddr5 6000';
    for (const t of ['Pamäťový modul Kingston FURY Beast Black EXPO 32GB DDR5 6000MHz CL36', 'Kingston Fury Beast Black RGB 32GB (1x 32GB) DDR5 6000MHz',
      'KINGSTON DIMM DDR5 32GB 6000MT/s CL30 Non-ECC FURY Beast RGB EXPO, Bílá', 'Kingston Fury Beast Black EXPO, 32 GB, 6000 MHz, DDR5']) {
      const r = m(q, t);
      assert.equal(r.level, 'possible', t);
      assert.deepEqual([r.missing, r.distinguishing], [[], []], t);
    }
    // hand-written guard: a toothbrush battery is not the model number
    const brush = m('Oral-B Pro 3 3000', 'Oral-B Pro 3 Black akumulátor 3000 mAh');
    assert.equal(brush.level, 'different');
    assert.deepEqual(brush.missing, ['3000']);
  });

  test('rule 3: part-type words are category words; "Edition" and "EMEA" are generic; "for Business" and "Performance" stay words to check', () => {
    assert.equal(lvl('ryzen 7 9800x3d', 'Procesor AMD Ryzen 7 9800X3D (100-100001084WOF)'), 'exact');
    assert.equal(lvl('ryzen 7 9800x3d', 'AMD Ryzen 7 9800X3D, TRAY balenie - iba na integráciu'), 'possible', 'the tray version is only possible');
    const q = 'logitech mx master 3s';
    assert.equal(lvl(q, 'Logitech MX Master 3S, bluetooth Edition, graphite'), 'exact');
    assert.equal(lvl(q, 'Bezdrôtová myš Logitech MX Master 3S, bledošedá'), 'exact');
    assert.deepEqual(m(q, 'Logitech MX Master 3S for Business Performance, EMEA').unknownExtras, ['business', 'performance']);
    assert.equal(lvl(q, 'Logitech MX Master 3S Performance černá / bezdrátová myš / Bluetooth'), 'possible');
  });

  test('rule 4: a missing query word with another word in its place is another product; with nothing in its place a doubt', () => {
    const q = 'logitech mx master 3s';
    for (const t of ['Myš Logitech MX Anywhere 3S (910-006930) sivá', 'Myš Logitech MX Anywhere 3S (910-006929) grafitová farba']) {
      const r = m(q, t);
      assert.equal(r.level, 'different', t);
      assert.deepEqual(r.missing, ['master']);
      assert.match(r.reasons.join('; '), /title has "anywhere" where the query has "master"/);
    }
    // hand-written: nothing where "master" would be
    assert.equal(lvl(q, 'Logitech MX 3S'), 'possible');
  });

  test('rule 5: a short number that starts a configuration code is "possible", with the code named; "16e", "9N" and "3000" are no such code', () => {
    const q = 'notebook lenovo ideapad slim 5 16';
    for (const t of ['Notebook Lenovo IdeaPad Slim 5 16ARP10 sivý', 'Lenovo IdeaPad Slim 5 16IMH10 - Notebook Lenovo IdeaPad Slim 5 16IMH10',
      'Lenovo IdeaPad Slim 5 16AKP10, 83HY009TCK, Luna Grey', 'Lenovo IdeaPad Slim 5 16AKP10 modrá / Notebook / 16" WUXGA / AMD Ryzen AI 5 330 / 16GB / 512GB ...']) {
      assert.equal(lvl(q, t), 'possible', t);
    }
    assert.match(m(q, 'Notebook Lenovo IdeaPad Slim 5 16ARP10 sivý').reasons.join('; '), /"16" found only as the start of "16arp10"/);
    // The processor in the specification list after " - " ("Ultra 5 135H") is the configuration, not
    // another model (workstation test of 2026-11-27; before, this title was rejected).
    assert.equal(lvl(q, 'LENOVO NTB IdeaPad Slim 5 16IMH10 - Ultra 5 135H,16" WUXGA OLED,16GB,512SSD,Inte...'), 'possible');
    assert.equal(lvl('notebook lenovo ideapad slim 5 16 ultra 7', 'LENOVO NTB IdeaPad Slim 5 16IMH10 - Ultra 5 135H,16" WUXGA OLED,16GB,512SSD,Inte...'), 'different');
    assert.equal(lvl('iPhone 16 128GB', 'Mobilný telefón Apple iPhone 16e 128 GB čierny'), 'different');
    assert.equal(lvl('Oral-B iO Series 9', 'Oral-B iO Series 9N Black'), 'different');
    assert.equal(lvl('Oral-B iO9', 'Oral-B iO Series 9N'), 'different');
    assert.equal(lvl('Samsung Galaxy S24', 'Samsung Galaxy A55 s nabíjačkou, záruka 24 mesiacov'), 'different');
  });

  test('rule 6: graphics cards of the class with specifications after the name are possible; a whole computer is different', () => {
    const q = 'rtx 5070 ti';
    for (const t of ['Gigabyte GeForce RTX 5070 Ti GAMING OC 16G', 'Grafická karta Asus ProArt GeForce RTX 5070 TI 16GB OC (90YV0NR0-M0NA00) sivá',
      'Gigabyte GeForce RTX 5070 Ti WINDFORCE OC SFF 16G', 'MSI VGA NVIDIA GeForce RTX 5070 Ti 16G VENTUS 3X OC, RTX 5070 Ti, 16GB GDDR7, 3x...']) {
      assert.equal(lvl(q, t), 'possible', t);
    }
    // "VENTUS 3X": a count inside the name is a word to check, not a pack; "3x..." cut off by the shop says nothing
    const msi = m(q, 'MSI VGA NVIDIA GeForce RTX 5070 Ti 16G VENTUS 3X OC, RTX 5070 Ti, 16GB GDDR7, 3x...');
    assert.ok(msi.unknownExtras.includes('3x'));
    assert.deepEqual(msi.distinguishing, []);
    // A computer names other components' model numbers, which the query lacks.
    const pc = m('ryzen 7 9800x3d', 'LYNX ULTIMATE Ryzen 7 9800X3D 64GB 2TB SSD NVMe RTX 5080 16G W11 Home');
    assert.equal(pc.level, 'different');
    assert.ok(pc.distinguishing.includes('5080'));
    // hand-written: the same computer with the card the query asks for
    assert.ok(m(q, 'LYNX ULTIMATE Ryzen 7 9800X3D 32GB 1TB SSD NVMe RTX 5070 Ti 16G W11 Home').distinguishing.includes('9800x3d'));
    assert.equal(lvl(q, 'Operačný systém: Windows 11 Home 64-bit • Procesor: Intel Core i7 14700F až 5.4 ...'), 'different');
  });

  test('packs written as counts still count: at the start, at the end, before an amount, before a package word', () => {
    assert.equal(lvl('Oral-B Pro 3 3000', '2x Oral-B Pro 3 3000'), 'different');
    assert.equal(lvl('Oral-B Pro 3 3000', 'Oral-B Pro 3 3000 2x'), 'different');
    assert.equal(lvl('Bosch GSR 12V-15', 'Bosch GSR 12V-15 2x 2.0Ah'), 'different');
    assert.equal(lvl('Bosch GSR 12V-15', 'Bosch GSR 12V-15 Professional 2x akumulátor'), 'different');
  });
});

describe('a pasted product link (the first user, 2026-11-25)', () => {
  const name = (s: string) => linkInput(s)?.query;

  test('the name from the path: id, file ending, query string and fragment removed; brands spelled as the code spells them', () => {
    assert.deepEqual(linkInput('https://www.alza.sk/roborock-qrevo-edge-2-pro-d13260955.htm'), { query: 'Roborock Qrevo Edge 2 Pro', host: 'www.alza.sk' });
    assert.equal(name('www.alza.sk/roborock-qrevo-edge-2-pro-d13260955.htm'), 'Roborock Qrevo Edge 2 Pro', 'pasted without the scheme');
    assert.equal(name('alza.sk/roborock-qrevo-edge-2-pro-d13260955.htm?utm_source=x&utm_medium=y#reviews'), 'Roborock Qrevo Edge 2 Pro');
  });

  test('the id and path patterns of shop links in this project', () => {
    // links seen in the search cache, 2026-11-25
    assert.equal(name('https://www.andreashop.sk/oral-b-precision-clean-pro-p318652'), 'Oral-B Precision Clean Pro');
    assert.equal(name('https://www.drmax.sk/oral-b-elektricka-kefka-pro-3000-blue-x52018'), 'Oral-B Elektricka Kefka Pro 3000 Blue');
    assert.equal(name('https://www.morele.net/szczoteczka-oral-b-pro-3-3000-crossaction-niebieska-11255949/'), 'Szczoteczka Oral-B Pro 3 3000 Crossaction Niebieska');
    assert.equal(name('https://planeo.sk/katalog/1317999-oral-b-pro-3-3900-cross-action-zubna-kefka.html?a_aid=5e563a4b10074'), 'Oral-B Pro 3 3900 Cross Action Zubna Kefka');
    assert.equal(name('https://www.mediamarkt.at/de/product/_oral-b-pro-3-3000-elektrische-zahnburste-schwarz-100959625.html'), 'Oral-B Pro 3 3000 Elektrische Zahnburste Schwarz');
    assert.equal(name('https://datacomp.sk/oral-b-eb-20-8-precision-clean_d350684.html'), 'Oral-B Eb 20 8 Precision Clean');
    assert.equal(name('https://www.tetadrogerie.sk/produkty/Elek-a-bater-zubne-kefky-a-sprchy/D160500-Oral-B-elektricka-zubna-kefka-iO-Series-3-bleda-modra/'),
      'Oral-B Elektricka Zubna Kefka iO Series 3 Bleda Modra');
    assert.equal(name('https://www.mironet.cz/oralb-vitality-pro-cerny-elektricky-zubni-kartacek-oscilacni-3-rezimy-casovac+dp646617/'),
      'Oral-B Vitality Pro Cerny Elektricky Zubni Kartacek Oscilacni 3 Rezimy Casovac');
    assert.equal(name('https://www.euronics.sk/produkt/lg-oled65b42'), 'LG oled65b42', 'a brand and a code is a name');
    // short model numbers are not taken for ids
    assert.equal(name('https://www.nay.sk/philips-sonicare-3100-hx3671-14'), 'Philips Sonicare 3100 hx3671 14');
  });

  test('a link without the name: only ids, a language code or nothing', () => {
    assert.deepEqual(linkInput('https://www.amazon.de/dp/B0C1234567'), { query: null, host: 'www.amazon.de' });
    assert.equal(name('https://shop.test/de/1'), null);
    assert.equal(name('https://www.alza.sk/'), null);
    // ASBIS SK, 2026-11-27: the product is in the query string of "default.asp", which is not read
    assert.deepEqual(linkInput('https://online.asbis.sk/default.asp?cls=stoitem&stiid=1038591&whisperword=HP%20z2'), { query: null, host: 'online.asbis.sk' });
    for (const u of ['https://shop.test/index.php?id=4', 'https://shop.test/product/detail.aspx?id=4', 'https://shop.test/Default.aspx']) assert.equal(name(u), null, u);
    // a name word that is also a page word stays inside a name
    assert.equal(name('https://shop.test/google-home-mini'), 'Google Home Mini');
  });

  test('text is not a link, even with a dot in it', () => {
    for (const q of ['Bosch GSR 12V-15 2.0Ah', 'iPhone 16 128GB', 'node.js', '2.0Ah', 'Oral-B iO 9']) assert.equal(linkInput(q), null, q);
  });
});

describe('the core query sent to shops in another country', () => {
  test('category, colour and generic words go; brand, line, model, tier, package words and digits stay', () => {
    assert.equal(coreQuery('Oral-B iO Series 9 čierna zubná kefka'), 'Oral-B iO Series 9');
    assert.equal(coreQuery('iPhone 16 128GB modrá'), 'iPhone 16 128GB');
    assert.equal(coreQuery('Oral-B io9 doublepack'), 'Oral-B io9 doublepack');
    assert.equal(coreQuery('Bosch Professional GSR 12V-15 aku vŕtačka'), 'Bosch Professional GSR 12V-15');
    assert.equal(coreQuery('elektrická zubná kefka Oral-B Pro 3 3000 pre deti'), 'Oral-B Pro 3 3000 deti', 'a tier word ("deti", kids) stays');
  });

  test('specific enough to send: a brand and one more token, or a token with a digit', () => {
    assert.equal(coreQuery('vŕtačka bosch'), 'bosch');
    assert.equal(namesSomething('bosch'), false, 'a brand alone is not sent instead of the query');
    assert.equal(namesSomething('Oral-B iO Series 9'), true);
    assert.equal(namesSomething('128GB'), true);
  });

  test('a colour in the query is met by the same colour in any language, not by another colour', () => {
    const q = 'Oral-B iO Series 9 čierna zubná kefka';
    assert.equal(m(q, 'Oral-B iO Series 9 Black').level, 'exact');
    assert.equal(m(q, 'Zubní kartáček Oral-B iO Series 9 černý').level, 'exact');
    assert.equal(m(q, 'Oral-B iO Series 9 Black').colour, 'black', 'the title still sets the colour');
    const white = m(q, 'Oral-B iO Series 9 White');
    assert.equal(white.level, 'possible');
    assert.deepEqual(white.missing, ['cierna']);
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

describe('robot vacuum titles (live search of 2026-11-25, from a pasted link)', () => {
  const q = 'Roborock Qrevo Edge 2 Pro';
  test('the part type in front of or behind the name is neutral in Slovak and Czech', () => {
    assert.equal(m(q, 'Robotický vysávač Roborock Qrevo Edge 2 Pro biely').level, 'exact');
    assert.equal(m(q, 'Roborock Qrevo Edge 2 Pro, robotický vysávač s mopom, biely').level, 'exact');
    assert.equal(m(q, 'Robotický vysavač Roborock Qrevo Edge 2 Pro bílý').level, 'exact');
  });
  test('another model of the line stays a different product', () => {
    assert.equal(m(q, 'Robotický vysávač s mopom 2v1 Roborock Qrevo Curv 2 Pro | Planeo').level, 'different');
  });
});

describe('workstation configurations (test of 2026-11-27, HP Z2 Tower G1i)', () => {
  const q = 'HP Z2 Tower G1i';
  // ABCOM Košice, 2026-11-27: the name, then the configuration as a comma-separated list
  const abcom = [
    'HP PC Z2 Tower G1i 1200W, Intel Core U7 270K Plus, Intel Graphics,2×16GB DDR5,1TB,Kb+mouse,Win11Pro,3yo',
    'HP PC Z2 Tower G1i 700W, Intel Core U9 285K vPro, RTX Pro 4000Bl 24GB,2×16GB DDR5,1TB,WiFi 7+BT,no Kb+mouse,Win11Pro,3yo',
    'HP PC Z2 Tower G1i 1200W, Intel Core U7 270K Plus, RTX PRO 4000 BL 24GB,2×32GB DDR5, 1TB, Kb+mouse,Win11Pro,3yo',
    'HP PC Z2 Tower G1i 700W, Intel Core U7 265K vPro (20C/5.5GHz), Intel Graphics,1×32GB DDR5,1TB,Kb+mouse,Win11Pro,3yo',
  ];
  test('a title with a specification list after the name: the parts\' model numbers are not the product\'s', () => {
    for (const title of abcom) {
      const r = m(q, title, { brand: 'HP' });
      assert.equal(r.level, 'possible', title);
      assert.deepEqual(r.distinguishing, [], title);
      assert.ok(r.reasonCodes.some((c) => c.code === 'variantNotInQuery'), title);
    }
    // each configuration is its own product
    assert.equal(new Set(abcom.map((title) => m(q, title, { brand: 'HP' }).signature)).size, abcom.length);
    // a specification the query names is met in the list; another one is not
    assert.equal(m('HP Z2 Tower G1i 24GB', abcom[1], { brand: 'HP' }).level, 'possible');
    assert.equal(m('HP Z2 Tower G1i 285K', abcom[0], { brand: 'HP' }).level, 'different');
  });
  test('the query only inside the list (a part of a whole computer) stays another product', () => {
    assert.equal(m('RTX Pro 4000', abcom[1]).level, 'different');
    assert.equal(m('Intel Core Ultra 9 285K', abcom[1]).level, 'different');
  });
  test('the list is split at commas, never at a decimal comma; a short list or one without amounts is no list', () => {
    assert.deepEqual(specList('Notebook X1, CPU 4,7 GHz, 16GB, 1TB')?.specs, ['CPU 4,7 GHz', '16GB', '1TB']);
    assert.deepEqual(specList('HP PC Z2 Tower G1i 1200W, Intel Core U7 270K Plus, Intel Graphics,2×16GB DDR5,1TB,Kb+mouse')?.specs.slice(2, 4), ['2×16GB DDR5', '1TB']);
    assert.equal(specList('HP Z2 Tower G1i, A40SRET'), null);
    assert.equal(specList('Oral-B Pro 3 3000, čierna, CrossAction, cestovné puzdro'), null);
  });
  test('a product link whose address spells out the configuration is read, not the "add to favourites" link beside it (ABCOM, 2026-11-28)', () => {
    const pq = parseQuery('HP Z2 Tower G1i RTX PRO 4000');
    const title = 'HP PC Z2 Tower G1i 1200W, Intel Core U7 270K Plus, RTX PRO 4000 BL 24GB,2×32GB DDR5, 1TB, Kb+mouse,Win11Pro,3yo';
    const product = scoreCandidate(pq, title, 'https://eshop.abcomke.sk/hp-pc-z2-tower-g1i-1200w-intel-core-u7-270k-plus-rtx-pro-4000-bl-24gb-2-32gb-ddr5-1tb-kb-mouse-win11pro-3yo/');
    const favourite = scoreCandidate(pq, `Obľúbený Pridať do obľúbených Pridať ${title} do obľúbených produktov heart`, 'https://eshop.abcomke.sk/hladanie/?createfav=480803');
    assert.equal(product.level, 'possible');
    assert.ok(product.score > favourite.score);
    // a tier word only in the address, not in the title, still marks another product
    assert.equal(scoreCandidate(parseQuery('Oral-B Pro 3 3000'), 'Oral-B Pro 3 3000', 'https://shop.test/oral-b-pro-3-3000-kids').level, 'different');
  });
  test('the part code in the title is the configuration, without its market suffix', () => {
    assert.equal(m(q, 'HP Z2 Tower G1i, EE7H6ES').partCode, 'ee7h6es');
    assert.equal(m(q, 'Stolný počítač HP Z2 Tower G1i (A40SRET#BCM) čierny').partCode, 'a40sret');
    assert.equal(m('iPhone 16 128GB', 'Apple iPhone 16 128GB Black (MYE73SX/A)').partCode, 'mye73');
    assert.equal(m(q, 'HP PC Z2 Tower G1i 700W').partCode, null);
    // "#BCM" is part of the code in brackets, not a word of the title; "Stolný počítač" says the kind of computer
    assert.equal(m(q, 'Stolný počítač HP Z2 Tower G1i (A40SRET#BCM) čierny').level, 'exact');
    assert.equal(m(q, 'Herný počítač HP Z2 Tower G1i (EE6J3ET#BCM) čierny').level, 'exact');
  });
});

describe('a gaming PC sold under two names (search of 2026-11-28, HP OMEN 45L GT22-3582nc)', () => {
  const q = 'HP OMEN 45L GT22-3582nc';
  const nay = 'Herný počítač HP OMEN MAX by HP 45L GT22-3582nc + Game Pass predplatné na 2 mesiace čierny';
  test('a subscription length is not a model number, and a tier word next to the same model code is only a doubt', () => {
    const r = m(q, nay, { brand: 'HP' });
    assert.equal(r.level, 'possible');
    assert.ok(!r.distinguishing.includes('2'));
    assert.ok(r.unknownExtras.includes('max'));
  });
  test('another model code of the line stays another product, with or without the tier word', () => {
    assert.equal(m(q, 'Herný počítač HP OMEN MAX by HP 45L GT23-0580nc + Game Pass predplatné na 2 mesiace čierny', { brand: 'HP' }).level, 'different');
    // without a long model code in the query a tier word still decides
    assert.equal(m('HP OMEN 45L', 'HP OMEN MAX 45L').level, 'different');
    assert.equal(m('iPhone 16 128GB', 'Apple iPhone 16 Pro 128GB').level, 'different');
  });
  test('durations in other languages', () => {
    for (const t of ['HP OMEN 45L GT22-3582nc + Game Pass 3 months', 'HP OMEN 45L GT22-3582nc + Game Pass na 3 měsíce', 'HP OMEN 45L GT22-3582nc + Game Pass 6 Monate']) {
      assert.ok(!m(q, t).distinguishing.some((x) => /^\d+$/.test(x)), t);
    }
  });
});

describe('a model number with letters glued to it (ABCOM, 2026-11-28)', () => {
  test('"4000" meets "4000Bl" as possible, with the reason; one glued letter is another model', () => {
    const r = m('HP Z2 Tower G1i RTX PRO 4000', 'HP PC Z2 Tower G1i 700W, Intel Core U9 285K vPro, RTX Pro 4000Bl 24GB,2×16GB DDR5,1TB,WiFi 7+BT,no Kb+mouse,Win11Pro,3yo', { brand: 'HP' });
    assert.equal(r.level, 'possible');
    assert.ok(r.reasonCodes.some((c) => c.code === 'codeStart'));
    assert.equal(m('RTX 4070', 'MSI GeForce RTX 4070S Ventus').level, 'different');
    assert.equal(m('Oral-B Pro 3 3000', 'Oral-B Pro 3 3000x').level, 'different');
  });
});
