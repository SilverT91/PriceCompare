// Query correction (src/core/correct.ts): a brand typed with one wrong letter is searched as the brand.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { guessCategories } from '../src/core/categories.ts';
import { correctQuery } from '../src/core/correct.ts';

const searched = (q: string) => correctQuery(q).query;

describe('brand typos are corrected', () => {
  test('the sentence a user typed (2026-11-25): two words joined are one edit from the brand', () => {
    assert.deepEqual(correctQuery('Iral b io9 doublepack'), { query: 'Oral-B io9 doublepack', typed: 'Iral b io9 doublepack', corrected: true });
    // the corrected query finds the toothbrush hint; the typed one finds none
    assert.ok(guessCategories('Oral-B io9 doublepack').reasons.includes('electric toothbrush / shaver'));
    assert.equal(guessCategories('Iral b io9 doublepack').categories, null);
  });

  test('one wrong, missing or extra letter; the brand written as the code writes it', () => {
    assert.equal(searched('Bosh GSR 12V-15'), 'Bosch GSR 12V-15');
    assert.equal(searched('Phillips Sonicare 3100'), 'Philips Sonicare 3100');
    assert.equal(searched('Lenova ThinkPad'), 'Lenovo ThinkPad');
    assert.equal(searched('Orall b io9'), 'Oral-B io9', 'two words joined before one word alone');
  });
});

describe('left as typed', () => {
  test('brands, a brand written as two words, and words with digits', () => {
    for (const q of ['Oral-B Pro 3 3000', 'Oral b io9 doublepack', 'Braun Series 9', 'iPhone 16 128GB', 'Sony WH-1000XM5', 'Dyson V15', 'Makita DDF485']) {
      assert.deepEqual(correctQuery(q), { query: q, typed: q, corrected: false }, q);
    }
  });

  test('vocabulary words are never corrected, even one edit from a brand', () => {
    // the colour word "teal" is one edit from "tefal"
    assert.deepEqual(correctQuery('iPhone 16 128GB teal'), { query: 'iPhone 16 128GB teal', typed: 'iPhone 16 128GB teal', corrected: false });
    for (const q of ['Oral-B Pro duo', 'zubná kefka biela', 'Braun Series 9 Pro']) assert.equal(correctQuery(q).corrected, false, q);
  });

  test('no four-letter brands as targets: common words one edit away are not brands', () => {
    for (const q of ['Barbie doll', 'song book', 'idea notebook', 'cell phone case']) assert.equal(correctQuery(q).corrected, false, q);
  });

  test('two letters wrong is not a typo this step corrects', () => {
    assert.equal(correctQuery('Samsnug Galaxy S24').corrected, false);
    assert.equal(correctQuery('Brown Series 9').corrected, false);
  });
});
