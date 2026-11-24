import assert from 'node:assert/strict';
import { test } from 'node:test';
import { displayGtin, normaliseGtin } from '../src/core/gtin.ts';

test('UPC-A, EAN-13 and zero-padded GTIN-14 of one product normalise to the same value', () => {
  const a = normaliseGtin('195949822650'); // NAY, key "gtin", 12 digits
  const b = normaliseGtin('0195949822650'); // MediaMarkt style, gtin13 with leading zero
  const c = normaliseGtin('00195949822650'); // GTIN-14
  assert.equal(a, '00195949822650');
  assert.equal(b, a);
  assert.equal(c, a);
  assert.equal(displayGtin(a as string), '0195949822650');
});

test('numbers as JSON numbers and with spaces or prefixes are accepted', () => {
  assert.equal(normaliseGtin(8006540759790), '08006540759790');
  assert.equal(normaliseGtin(' 8006 5407 5979 0 '), '08006540759790');
  assert.equal(normaliseGtin('EAN: 8006540759790'), '08006540759790');
});

test('wrong check digit, wrong length and junk are rejected', () => {
  assert.equal(normaliseGtin('8006540759791'), null);
  assert.equal(normaliseGtin('12345'), null);
  assert.equal(normaliseGtin('MYED3SX/A'), null);
  assert.equal(normaliseGtin(''), null);
  assert.equal(normaliseGtin(null), null);
  assert.equal(normaliseGtin('00000000000000'), null);
});

test('ISBN-13 and ISBN-10 of one book give the same GTIN', () => {
  assert.equal(normaliseGtin('9788025707418'), '09788025707418');
  assert.equal(normaliseGtin('80-257-0741-1'), '09788025707418');
});

test('GTIN-8 is padded', () => {
  assert.equal(normaliseGtin('96385074'), '00000096385074');
});
