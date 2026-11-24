// Text normalisation shared by the matcher and the candidate scorer.

const EXTRA_FOLD: Record<string, string> = {
  'ß': 'ss', 'ł': 'l', 'Ł': 'l', 'ø': 'o', 'Ø': 'o', 'đ': 'd', 'Đ': 'd', 'æ': 'ae', 'œ': 'oe',
  '×': 'x', '–': '-', '—': '-', '‐': '-', '‑': '-', '″': '"', '“': '"', '”': '"', '„': '"',
};

/** Lowercase and strip diacritics: "Čierna Zahnbürste" -> "cierna zahnburste". */
export function fold(text: string): string {
  let s = (text ?? '').replace(/[ßłŁøØđĐæœ×–—‐‑″“”„]/g, (c) => EXTRA_FOLD[c] ?? c);
  s = s.normalize('NFKD').replace(/[̀-ͯ]/g, '');
  return s.toLowerCase();
}

// Units that are glued to the preceding number so "128 GB" and "128GB" become the same token.
const UNIT_RE =
  /(\d+(?:[.,]\d+)?)\s*(gb|tb|mb|ml|kg|mm|cm|mah|ah|wh|kw|w|v|l|g|m|"|inch|in|palcov|palce|cali|zoll)(?![a-z0-9])/g;

/**
 * Tokenise a product title or query.
 * - "Oral-B" -> "oralb" (hyphen between letters joins), "12V-15" -> "12v15" (letters/digits mix joins),
 *   "3-3900" -> "3", "3900" (digit-hyphen-digit splits).
 * - "128 GB" -> "128gb", "2,0 Ah" -> "2ah", '6.1"' -> "6.1in".
 */
export function tokenize(text: string): string[] {
  let s = fold(text);
  s = s.replace(/\+/g, ' + ');
  // Hyphen handling first: join when either side has letters, split between two pure numbers.
  s = s.replace(/([a-z0-9]+)-(?=[a-z0-9])/g, (m: string, left: string, offset: number, whole: string) => {
    const rest = whole.slice(offset + m.length);
    const right = /^[a-z0-9]+/.exec(rest)?.[0] ?? '';
    if (/^\d+$/.test(left) && /^\d+$/.test(right)) return `${left} `;
    return left;
  });
  s = s.replace(UNIT_RE, (_m: string, num: string, unit: string) => {
    let n = num.replace(',', '.');
    if (/\.0+$/.test(n)) n = n.replace(/\.0+$/, '');
    let u = unit;
    if (u === '"' || u === 'inch' || u === 'palcov' || u === 'palce' || u === 'cali' || u === 'zoll') u = 'in';
    return ` ${n}${u} `;
  });
  const out: string[] = [];
  for (const m of s.matchAll(/[a-z0-9]+(?:\.[0-9]+[a-z]*)?/g)) {
    const t = m[0];
    if (t.length === 0) continue;
    out.push(t);
  }
  return out;
}

export const isNumeric = (t: string): boolean => /^\d+(?:\.\d+)?$/.test(t);
export const hasDigit = (t: string): boolean => /\d/.test(t);
export const isAlpha = (t: string): boolean => /^[a-z]+$/.test(t);

/** Damerau-free Levenshtein distance, small inputs only. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > 2) return 3;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}
