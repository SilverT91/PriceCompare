// GTIN normalisation. Shops publish the same product as UPC-A (12 digits), EAN-13, or zero-padded
// GTIN-14, under keys gtin, gtin8, gtin12, gtin13, gtin14, ean or isbn. Comparing needs one form:
// the 14-digit zero-padded GTIN with a valid check digit.

export const GTIN_KEYS = ['gtin', 'gtin14', 'gtin13', 'gtin12', 'gtin8', 'ean', 'ean13', 'isbn', 'upc'] as const;

function checkDigitOk(digits14: string): boolean {
  let sum = 0;
  for (let i = 0; i < 13; i++) {
    const d = digits14.charCodeAt(i) - 48;
    sum += d * (i % 2 === 0 ? 3 : 1);
  }
  const check = (10 - (sum % 10)) % 10;
  return check === digits14.charCodeAt(13) - 48;
}

function isbn10to13(isbn10: string): string | null {
  if (!/^\d{9}[\dX]$/i.test(isbn10)) return null;
  const core = '978' + isbn10.slice(0, 9);
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += (core.charCodeAt(i) - 48) * (i % 2 === 0 ? 1 : 3);
  return core + String((10 - (sum % 10)) % 10);
}

/**
 * Returns the canonical 14-digit GTIN, or null when the value is not a valid GTIN.
 * "195949822650" (UPC-A), "0195949822650" (EAN-13) and "00195949822650" (GTIN-14) all give the same result.
 */
export function normaliseGtin(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  let s = String(value).trim();
  if (!s) return null;
  // Some shops prefix: "EAN: 123..." or "urn:gtin:..."
  s = s.replace(/^(?:urn:)?(?:gtin|ean|isbn|upc)[:\s-]*/i, '');
  const compact = s.replace(/[\s-]/g, '');
  if (/^\d{9}[\dX]$/i.test(compact)) {
    const conv = isbn10to13(compact);
    return conv ? normaliseGtin(conv) : null;
  }
  if (!/^\d+$/.test(compact)) return null;
  if (![8, 12, 13, 14].includes(compact.length)) return null;
  const padded = compact.padStart(14, '0');
  if (/^0+$/.test(padded)) return null;
  if (!checkDigitOk(padded)) return null;
  return padded;
}

/** Short display form: the GTIN without leading zeros beyond EAN-13 length. */
export function displayGtin(gtin14: string): string {
  return gtin14.startsWith('0') ? gtin14.slice(1) : gtin14;
}
