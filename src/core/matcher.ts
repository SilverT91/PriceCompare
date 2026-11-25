// Matching an offer title to the user's query. The point of this app: an offer for a different
// model, bundle, colour or condition must not be presented as the product the user typed.
//
// Rules:
// 1. Model and number tokens of the query must be in the title ("3000", "12v15", "128gb").
// 2. An extra distinguishing token in the title that the query lacks makes it a different product:
//    tier words (pro, plus, kids, fc ...), package words (duopack, set, 39-dielna, 2x, solo ...),
//    accessory words (hlavice, kryt ...) and extra model numbers (3900, 16e).
// 3. Used / refurbished / unpacked / damaged items are flagged; they get their own signature, so
//    they are never grouped with new ones.
// 4. Colour is recorded but does not change the model signature (colour variants sit side by side).
// 5. Words the matcher does not understand make the match "possible" (check it), never "exact".

import { tokenize, hasDigit, isAlpha, editDistance, fold } from './text.ts';
import {
  ACCESSORY_WORDS, BRAND_SPELLING, BRANDS, colourOf, conditionOfToken, GENERIC_SET_WORDS, inClass, LINE_WORD_CLASS, MODEL_WORDS, NEUTRAL, NEUTRAL_UNITS,
  PACKAGE_WORDS, twoPack, VARIANT_UNITS,
} from './vocab.ts';
import type { Condition, MatchResult } from './types.ts';

export interface MatchInput {
  title: string;
  brand?: string | null;
  sku?: string | null;
  mpn?: string | null;
  color?: string | null;
  itemCondition?: string | null;
  url?: string | null;
  shopName?: string | null;
}

const PACK_RE =
  /(\d+)\s*-?\s*(dielna|dielny|dielnou|dielnej|dilna|dilny|dilnou|teilig|tlg|czesciowy|czesci|pcs|pc|pieces|piece|ks|kus|kusy|kusov|stuck|stueck|stk|szt|pack|pak|er\s?pack)(?![a-z])/g;
const TIMES_RE =
  /(?:^|[^a-z0-9.])(\d+)\s*x(?![a-z0-9])|(?:^|[^a-z0-9])x\s*(\d+)(?![a-z0-9.])|(?:^|[^a-z0-9.])([2-9])\s*x\s*(?=\d+(?:[.,]\d+)?\s*(?:ah|mah|wh)\b)/g;

/**
 * The query without its package words ("Oral-B io9 doublepack" -> "Oral-B io9"), for asking a
 * shop's search once more when it found no products: shops often name the pack another way.
 * A word counts when all its tokens are package words ("doublepack", "duo", "sada"); "double",
 * "twin" or "doppel" in front of one goes with it. Nothing else is changed. Null when the query
 * has no package word, or nothing else.
 */
export function withoutPackageWords(query: string): string | null {
  const words = query.trim().split(/\s+/).filter(Boolean);
  const isPack = (w: string) => {
    const toks = tokenize(w);
    return toks.length > 0 && toks.every((t) => inClass(twoPack(t), PACKAGE_WORDS));
  };
  const kept = words.filter((w, i) => !isPack(w) && !(/^(double|twin|doppel)$/i.test(w) && i + 1 < words.length && isPack(words[i + 1])));
  if (kept.length === words.length || !kept.some((w) => tokenize(w).length)) return null;
  return kept.join(' ');
}

/** Remove page-title suffixes ("... | iStores - Apple Premium Partner") and an appended cashback promotion. */
function withoutSuffix(title: string, shopName?: string | null): string {
  let t = (title ?? '').replace(/\s+/g, ' ').trim();
  const pipe = t.split(/\s[|]\s/);
  if (pipe.length > 1) t = pipe[0];
  if (shopName) {
    const esc = shopName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    t = t.replace(new RegExp(`\\s[-–]\\s${esc}.*$`, 'i'), '');
  }
  // A promotion appended to the name ("+ Cashback 10€ pri nákupe min. za 70€", "+ CASHBACK AŽ 60€") is
  // not part of the product; its amounts must not count as model numbers.
  return t.replace(/\s*\+\s*cashback\b.*$/i, '').trim();
}

/** Remove page-title suffixes, an appended cashback promotion and bracketed part codes. */
export function cleanTitle(title: string, shopName?: string | null): string {
  // "(MYED3SX/A)", "(MYE73)": uppercase codes in brackets are part numbers.
  return withoutSuffix(title, shopName).replace(/\(\s*[A-Z0-9][A-Z0-9/\-.]{3,}\s*\)/g, ' ').trim();
}

/**
 * Two steps that turn a cleaned title into the name a shop gives the product: a specification
 * list in front of the name ("Typ: Zubná kefka • Použitie: … • Počet rýchlostí: 3 ORAL-B Series iO 2")
 * is removed, the name following the last "label: number" pair; and a title the shop wrote twice in
 * a row is taken once.
 */
export function nameOnly(text: string): string {
  let t = text;
  const bullets = t.split(/\s•\s/);
  if (bullets.length >= 2 && bullets[0].includes(':')) t = (bullets.at(-1) ?? t).replace(/^\p{L}[\p{L} .]{0,40}:\s*\d+\s+(?=\S)/u, '');
  const words = t.split(/\s+/).filter(Boolean);
  const n = words.length;
  if (n >= 4 && n % 2 === 0) {
    const half = n / 2;
    if (fold(words.slice(0, half).join(' ')) === fold(words.slice(half).join(' '))) return words.slice(0, half).join(' ');
  }
  return words.join(' ');
}

/**
 * The product name to show for a title: shop suffix and appended cashback promotion removed, a
 * leading specification list removed, a doubled title taken once. What follows " + " otherwise
 * stays (a travel case or a second handle is part of the product), and so do part codes in brackets.
 */
export function displayTitle(title: string, shopName?: string | null): string {
  return nameOnly(withoutSuffix(title, shopName)) || (title ?? '').trim();
}

// Pharmacy notation "packages × units": "1×1 ks" (one piece), "1×1 set", "1×2 ks" (two pieces).
const MULTI_RE = /(^|[^a-z0-9.])(\d+)\s*x\s*(\d+)\s*-?\s*(ks|kus|kusy|kusov|pcs|pc|szt|stk|set|sada|bal|balenie)(?![a-z])/g;
// "1×75 ml": one package of the amount that follows.
const ONE_OF_RE = /(^|[^a-z0-9.])1\s*x\s*(?=\d)/g;

// A pack of two, however it is written ("Duo Pack", "Doublepack", "double pack", "Doppelpack",
// "dvojbalenie"), is the one word "duo"; a piece count of 2 right next to it ("Duo, 2 ks") says the
// same thing again and is not a count of its own. A bare "2 ks" stays a piece count ("2pc").
const TWO_PACK_RE = /(?<![a-z0-9])(?:(?:duo|double|twin|doppel)\s*-?\s*pack|duopack|doublepack|twinpack|doppelpack|dvojbalenie|dvojbaleni)(?![a-z0-9])/g;
const TWO_COUNT = String.raw`2\s*-?\s*(?:ks|kus|kusy|pcs|pc|pieces|szt|stk|stuck|stueck)(?![a-z])`;
const DUO_COUNT_RE = new RegExp(String.raw`(?<![a-z0-9])duo[\s,;:()-]*${TWO_COUNT}|(?<![a-z0-9.])${TWO_COUNT}[\s,;:()-]*duo(?![a-z0-9])`, 'g');

/** Pack/count phrases become one token: "39-dielna" -> "39pc", "2 ks" -> "2pc", "2x" -> "2x", "1×2 ks" -> "2pc"; a pack of two -> "duo". */
function packTokens(folded: string): { text: string; packs: string[] } {
  const packs: string[] = [];
  let text = folded.replace(TWO_PACK_RE, 'duo').replace(DUO_COUNT_RE, 'duo');
  text = text.replace(MULTI_RE, (_m, pre: string, a: string, b: string) => {
    const n = Number(a) * Number(b);
    if (n !== 1) packs.push(`${n}pc`);
    return `${pre} `;
  });
  text = text.replace(ONE_OF_RE, (_m, pre: string) => `${pre} `);
  text = text.replace(PACK_RE, (_m, n: string) => {
    if (n !== '1') packs.push(`${n}pc`);
    return ' ';
  });
  text = text.replace(TIMES_RE, (m, a?: string, b?: string, c?: string) => {
    const n = a ?? b ?? c ?? '';
    if (n && n !== '1') packs.push(`${n}x`);
    return m.startsWith(' ') ? ' ' : m[0] && !/\d|x/.test(m[0]) ? `${m[0]} ` : ' ';
  });
  return { text, packs };
}

function foldSimple(s: string): string {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/×/g, 'x').toLowerCase();
}

/**
 * "Pro 3 3000" written as "Pro 3000": the line digit is left out but the model number that starts
 * with it follows the same word. Shops do this, and an older "Pro 3000" also exists, so it is a
 * doubt ("possible"), not a match and not a rejection.
 */
function lineDigitOmitted(t: string, q: ParsedQuery, titleTokens: string[]): boolean {
  if (!/^\d{1,2}$/.test(t)) return false;
  const i = q.tokens.indexOf(t);
  const prev = q.tokens[i - 1];
  const next = q.tokens[i + 1];
  if (!prev || !next || !/^\d{3,}$/.test(next) || !next.startsWith(t)) return false;
  const j = titleTokens.indexOf(next);
  return j > 0 && titleTokens[j - 1] === prev;
}

export interface ParsedQuery {
  raw: string;
  tokens: string[];
  packs: string[];
}

export function parseQuery(query: string): ParsedQuery {
  const { text, packs } = packTokens(foldSimple(query));
  return { raw: query, tokens: [...new Set(tokenize(text))], packs };
}

/** Is the token a part/order code rather than a model token? */
function isPartCode(tok: string, codes: Set<string>): boolean {
  if (!/\d/.test(tok)) return false; // a code has digits; words in an mpn ("Pro 3 3000 Cross Action") are not codes
  if (codes.has(tok)) return true;
  for (const c of codes) if (/\d/.test(c) && c.length >= 5 && tok.length >= 5 && (c.startsWith(tok) || tok.startsWith(c))) return true;
  if (/^\d{7,}$/.test(tok)) return true;
  if (tok.length >= 7 && /\d/.test(tok) && /[a-z]/.test(tok)) return true;
  return false;
}

/** Indices of the title tokens that make up query token q, or null. Handles "oral b" = "oralb", "12v 15" = "12v15". */
function coverIndices(q: string, titleTokens: string[]): number[] | null {
  const direct = titleTokens.indexOf(q);
  if (direct >= 0) return [direct];
  for (let i = 0; i < titleTokens.length; i++) {
    let acc = titleTokens[i];
    if (!q.startsWith(acc)) continue;
    for (let j = i + 1; j < Math.min(titleTokens.length, i + 3); j++) {
      acc += titleTokens[j];
      if (acc === q) return Array.from({ length: j - i + 1 }, (_, k) => i + k);
      if (!q.startsWith(acc)) break;
    }
  }
  return null;
}

/**
 * A query token of letters and a number written as one ("io9") met by a title that writes them
 * apart with up to two neutral or line words between ("iO Series 9"); written side by side ("iO 9")
 * coverIndices already joins them. The number must be the same token ("9", not "90" or "9n"), and
 * the letters must not be a neutral word themselves (the Slovak "s" in "s 24 mesačnou zárukou").
 */
function gluedCover(q: string, titleTokens: string[]): number[] | null {
  const m = /^([a-z]+)(\d+)$/.exec(q);
  if (!m || inClass(m[1], NEUTRAL)) return null;
  for (let i = 0; i < titleTokens.length; i++) {
    if (titleTokens[i] !== m[1]) continue;
    for (let j = i + 1; j < Math.min(titleTokens.length, i + 4); j++) {
      if (titleTokens[j] === m[2]) return Array.from({ length: j - i + 1 }, (_, k) => i + k);
      if (!inClass(titleTokens[j], NEUTRAL)) break;
    }
  }
  return null;
}

export function conditionFrom(itemCondition: string | null | undefined, url: string | null | undefined, words: Condition[]): Condition {
  const ic = (itemCondition ?? '').toLowerCase();
  if (ic.includes('refurbished')) return 'refurbished';
  if (ic.includes('used')) return 'used';
  if (ic.includes('damaged')) return 'damaged';
  if (words.includes('damaged')) return 'damaged';
  if (words.includes('refurbished')) return 'refurbished';
  if (words.includes('used')) return 'used';
  if (words.includes('unknown_used')) return 'unknown_used';
  if (url && /\/(bazar|outlet|rozbalene|refurbished|b-ware)[/-]/i.test(new URL(url, 'https://x.invalid').pathname)) return 'used';
  return 'new';
}

export function matchTitle(query: ParsedQuery | string, input: MatchInput): MatchResult {
  const q = typeof query === 'string' ? parseQuery(query) : query;
  const cleaned = cleanTitle(input.title, input.shopName);
  // Mironet-style titles: "Name / spec / spec / spec". The name is the first segment; in the specs
  // only package/model/accessory words and counts count ("2x 2Ah" = two batteries), not numbers
  // such as rpm or torque.
  const segments = cleaned.split(/\s\/\s/);
  const main = segments.length >= 3 ? segments[0] : cleaned;
  const specText = segments.length >= 3 ? segments.slice(1).join(' ') : '';
  const { text, packs } = packTokens(foldSimple(main));
  const spec = packTokens(foldSimple(specText));
  const specTokens = tokenize(spec.text);
  const titleTokens = tokenize(text);
  const brandList = tokenize(input.brand ?? '');
  const brandTokens = new Set(brandList);
  const codes = new Set([...tokenize(input.sku ?? ''), ...tokenize(input.mpn ?? '')].filter((t) => t.length >= 4));
  const reasons: string[] = [];

  // 1. Query tokens present?
  const missing: string[] = [];
  const missingAlpha: string[] = [];
  const softMissing: string[] = [];
  const matched: string[] = [];
  const consumed = new Set<number>();
  for (const t of q.tokens) {
    const idx = coverIndices(t, titleTokens) ?? gluedCover(t, titleTokens);
    if (idx) {
      matched.push(t);
      idx.forEach((i) => consumed.add(i));
      continue;
    }
    if (coverIndices(t, brandList)) {
      matched.push(t);
      continue;
    }
    // A query pair "iphone","16" may be one title token "iphone16".
    const joined = titleTokens.findIndex((tt) => tt.length > t.length && q.tokens.some((o) => o !== t && (tt === t + o || tt === o + t)));
    if (joined >= 0) {
      matched.push(t);
      consumed.add(joined);
      continue;
    }
    if (coverIndices(t, specTokens)) {
      matched.push(t);
      continue;
    }
    if (lineDigitOmitted(t, q, titleTokens)) {
      softMissing.push(t);
      continue;
    }
    if (hasDigit(t)) {
      missing.push(t);
      continue;
    }
    if (inClass(t, NEUTRAL)) continue; // a category word in the query ("zubna kefka") is optional
    // A colour in the query is met by the same colour in any language ("čierna" by "Black", "černý");
    // another colour stays a doubt, as a missing word. The title's colour word is not consumed, so it
    // is still recorded as the offer's colour.
    const want = colourOf(t);
    if (want && (titleTokens.some((tt) => colourOf(tt) === want) || (input.color && colourOf(tokenize(input.color)[0] ?? '') === want))) {
      matched.push(t);
      continue;
    }
    if (t.length >= 6) {
      const near = titleTokens.findIndex((tt) => isAlpha(tt) && Math.abs(tt.length - t.length) <= 1 && editDistance(tt, t) <= 1);
      if (near >= 0) {
        matched.push(t);
        consumed.add(near);
        reasons.push(`"${t}" ~ "${titleTokens[near]}"`);
        continue;
      }
    }
    missingAlpha.push(t);
  }
  for (const p of q.packs) {
    if (packs.includes(p)) matched.push(p);
    else missing.push(p);
  }

  // 2. Classify extra title tokens.
  const qset = new Set(q.tokens);
  const distinguishing: string[] = [];
  const specExtras: string[] = [];
  const unknownExtras: string[] = [];
  const condWords: Condition[] = [];
  const conditionWords: string[] = [];
  const titleCodes: string[] = [];
  let colour: string | null = null;
  // "Súprava zubných kefiek ... Duo Pack": with the two-pack word in the title, a generic set word says nothing more.
  const twoPackTitle = titleTokens.includes('duo') || specTokens.includes('duo');
  const setSaysNothing = (t: string) => twoPackTitle && GENERIC_SET_WORDS.has(t);
  for (let i = 0; i < titleTokens.length; i++) {
    const t = titleTokens[i];
    if (qset.has(t) || consumed.has(i) || setSaysNothing(t)) continue;
    const cond = conditionOfToken(t);
    if (cond) {
      condWords.push(cond);
      conditionWords.push(t);
      continue;
    }
    const col = colourOf(t);
    if (col) {
      colour = colour ?? col;
      continue;
    }
    if (brandTokens.has(t)) continue;
    if (t === 'pro' && i + 1 < titleTokens.length && (inClass(titleTokens[i + 1], NEUTRAL) || /^(det|dosp|muz|zen|psy|kock|kluk|holk)/.test(titleTokens[i + 1]))) {
      continue; // Czech "pro" = "for"
    }
    if (inClass(t, MODEL_WORDS) || inClass(t, PACKAGE_WORDS) || inClass(t, ACCESSORY_WORDS)) {
      distinguishing.push(t);
      continue;
    }
    if (isPartCode(t, codes)) {
      // Manufacturer order codes in titles ("060186810F") link offers across shops like a GTIN.
      if (t.length >= 8 && /[a-z]/.test(t) || /^0\d{9}$/.test(t)) titleCodes.push(t);
      continue;
    }
    if (NEUTRAL_UNITS.test(t) || /^ios\d+/.test(t) || /^a\d{2}$/.test(t)) continue;
    // "iO3" in "iO Series 3 iO3": the matched line word and number written once more, glued.
    const glued = /^([a-z]+)(\d+)$/.exec(t);
    if (glued && matched.includes(glued[1]) && matched.includes(glued[2])) continue;
    // "12 V" next to "12V-15": the voltage repeats part of the model token.
    if (hasDigit(t) && q.tokens.some((x) => x !== t && x.length > t.length && x.startsWith(t))) continue;
    if (VARIANT_UNITS.test(t)) {
      specExtras.push(t);
      continue;
    }
    if (inClass(t, NEUTRAL)) continue;
    if (/^\d+d$/.test(t)) {
      unknownExtras.push(t); // "3D White", "2D": a head type, not a model number
      continue;
    }
    if (hasDigit(t)) {
      distinguishing.push(t);
      continue;
    }
    if (t.length <= 1) continue;
    unknownExtras.push(t);
  }
  for (const p of [...packs, ...spec.packs]) if (!q.packs.includes(p) && !distinguishing.includes(p)) distinguishing.push(p);
  for (const t of specTokens) {
    if (qset.has(t) || setSaysNothing(t)) continue;
    const cond = conditionOfToken(t);
    if (cond) {
      condWords.push(cond);
      conditionWords.push(t);
    } else if ((inClass(t, MODEL_WORDS) || inClass(t, PACKAGE_WORDS) || inClass(t, ACCESSORY_WORDS)) && !distinguishing.includes(t)) {
      distinguishing.push(t);
    } else if (!colour && colourOf(t)) {
      colour = colourOf(t);
    }
  }
  // The title's colour word is usually more specific ("Teal") than the JSON-LD color ("Zielony").
  if (input.color && !colour) colour = colourOf(tokenize(input.color)[0] ?? '') ?? foldSimple(input.color);

  const condition = conditionFrom(input.itemCondition, input.url, condWords);
  if (condition !== 'new') reasons.push(`condition: ${condition}${conditionWords.length ? ` (${conditionWords.join(', ')})` : ''}`);

  // A missing tier word ("pro") or two missing words (brand and line: "Braun Series 3 3000" for
  // "Oral-B Pro 3 3000") mean another product; one missing plain word is only a doubt.
  if (missingAlpha.some((t) => inClass(t, MODEL_WORDS) || inClass(t, PACKAGE_WORDS)) || missingAlpha.length >= 2) {
    missing.push(...missingAlpha.splice(0));
  }
  let level: MatchResult['level'];
  if (missing.length || distinguishing.length) {
    level = 'different';
    if (missing.length) reasons.push(`title lacks ${missing.map((m) => `"${m}"`).join(', ')}`);
    if (distinguishing.length) reasons.push(`title has ${distinguishing.map((m) => `"${m}"`).join(', ')} that the query lacks`);
  } else if (softMissing.length || missingAlpha.length || unknownExtras.length || specExtras.length) {
    level = 'possible';
    for (const t of softMissing) {
      const next = q.tokens[q.tokens.indexOf(t) + 1];
      reasons.push(`title says "${q.tokens[q.tokens.indexOf(t) - 1]} ${next}" without "${t}": the same model or an older one`);
    }
    if (missingAlpha.length) reasons.push(`title lacks ${missingAlpha.map((m) => `"${m}"`).join(', ')}`);
    if (specExtras.length) reasons.push(`variant ${specExtras.join(', ')} not in the query`);
    if (unknownExtras.length) reasons.push(`check extra words: ${unknownExtras.join(', ')}`);
  } else {
    level = 'exact';
  }

  let score: number;
  if (level === 'exact') score = 1;
  else if (level === 'possible') score = 0.75 - 0.04 * unknownExtras.length - 0.08 * specExtras.length - 0.12 * missingAlpha.length - 0.15 * softMissing.length;
  else score = 0.35 - 0.05 * distinguishing.length - 0.08 * missing.length;
  score = Math.max(0.01, Math.min(1, score));

  const sigTokens = [...new Set([...matched, ...distinguishing, ...specExtras])].sort();
  const signature = sigTokens.join(' ') + (condition !== 'new' ? ` [${condition}]` : '');

  return {
    level, score, matched: [...new Set(matched)], missing: [...missing, ...missingAlpha, ...softMissing], distinguishing, specExtras, unknownExtras,
    condition, conditionWords, colour, signature, codes: titleCodes, reasons,
  };
}

// Words of review, comparison, manual and advice pages ("RECENZIA: elektrická kefka Oral-B PRO 3 3000",
// "Návod pro Zubní kartáček ..."): such pages name the product but sell nothing.
const ARTICLE_WORDS = new Set([
  'recenzia', 'recenzie', 'recenze', 'recenzi', 'review', 'reviews', 'navod', 'navody', 'porovnanie', 'porovnani', 'porovnali',
  'clanok', 'clanek', 'blog', 'poradna', 'skusenosti', 'zkusenosti',
  // advice questions: "Jaký elektrický kartáček Oral-B použít pro ...", "Aký ..."
  'jaky', 'jaka', 'jake', 'aky', 'aka', 'ake',
]);

/** Separators between the words of a URL path. */
const SLUG_SEPARATORS = /[/_+\-]+/g;

/** The URL path as words ("/oral-b-pro-3-3500.html" -> "oral b pro 3 3500"); empty for an invalid URL. */
export function urlSlug(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname).replace(SLUG_SEPARATORS, ' ').replace(/\.(html?|php)$/, '').trim();
  } catch {
    return '';
  }
}

// What shop links put around the name in a path segment, seen in this project's cache and tests:
// a file ending (".htm", ".html", ".php"), a trailing id ("-d13260955", "-p318652", "+dp646628",
// "-x52018", "_d350684", "-11255949"), a leading id ("1317999-", "D160500-"). A single letter with
// four or more digits, two letters with six or more, or six or more digits alone count as an id;
// shorter ones may be model numbers ("hx3671", "4090") and stay.
const FILE_ENDING = /\.(html?|php|aspx?|jsp)$/i;
const TRAILING_ID = /[-_+](?:[a-z]\d{4,}|[a-z]{2}\d{6,}|\d{6,})$/i;
const LEADING_ID = /^(?:[a-z]?\d{5,})[-_]/i;
/** Path words that name a page type, not a product. */
const PATH_WORDS = new Set(['product', 'products', 'produkt', 'produkty', 'produkte', 'p', 'dp', 'gp', 'item', 'items', 'detail', 'katalog',
  'kategoria', 'kategorie', 'category', 'shop', 'eshop', 'index', 'artikel', 'www']);

/** A path segment's words, ids and file ending removed; empty when nothing in it names a product. */
function segmentWords(segment: string): string[] {
  let s = segment.trim().replace(FILE_ENDING, '');
  for (let k = 0; k < 2; k++) s = s.replace(TRAILING_ID, '');
  s = s.replace(LEADING_ID, '');
  const words = s.split(SLUG_SEPARATORS).filter((w) => w && !PATH_WORDS.has(w.toLowerCase()));
  // A name needs a word: three letters or more, or a brand ("lg-oled65b42"). An id ("B0C1234567"),
  // a number ("1") or a language code ("de") alone is not a name.
  const named = words.some((w) => /^\p{L}{3,}$/u.test(w) || BRANDS.has(tokenize(w).join('')));
  return named ? words : [];
}

/** Path words written as a query: a brand as the code spells it ("oral-b" -> "Oral-B"), lower-case words with a capital. */
function writeWords(words: string[]): string {
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const pair = i + 1 < words.length ? tokenize(`${words[i]}${words[i + 1]}`).join('') : '';
    if (pair && BRAND_SPELLING[pair] && !BRANDS.has(tokenize(words[i]).join(''))) {
      out.push(BRAND_SPELLING[pair]);
      i++;
      continue;
    }
    const one = tokenize(words[i]).join('');
    if (BRAND_SPELLING[one]) out.push(BRAND_SPELLING[one]);
    else if (/^\p{Ll}+$/u.test(words[i])) out.push(words[i][0].toLocaleUpperCase() + words[i].slice(1));
    else out.push(words[i]); // as the link writes it: mixed case, codes and numbers ("iO", "qe65s85d", "2")
  }
  return out.join(' ');
}

export interface LinkInput {
  /** The product name derived from the path, or null when the link carries none. */
  query: string | null;
  host: string;
}

/**
 * A pasted product link instead of a name: an http(s) URL, or one without the scheme
 * ("www.alza.sk/roborock-..." or "alza.sk/roborock-..."). Text with spaces is never a link. The
 * name is taken from the last path segment that carries words; query string and fragment are
 * ignored. Nothing is fetched. Null when the input is not a link.
 */
export function linkInput(input: string): LinkInput | null {
  const text = input.trim();
  if (!text || /\s/.test(text)) return null;
  const withScheme = /^https?:\/\//i.test(text) ? text
    : /^(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\//i.test(text) || /^www\.[a-z0-9.-]+\.[a-z]{2,}$/i.test(text) ? `https://${text}` : null;
  if (!withScheme) return null;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  let path = url.pathname;
  try {
    path = decodeURIComponent(path);
  } catch { /* a malformed escape: the path as it is */ }
  const segments = path.split('/').filter(Boolean);
  for (let i = segments.length - 1; i >= 0; i--) {
    const words = segmentWords(segments[i]);
    if (words.length) return { query: writeWords(words), host: url.hostname.toLowerCase() };
  }
  return { query: null, host: url.hostname.toLowerCase() };
}

/** A token of a word the core query leaves out: a category, connector or generic word, or a colour (language-specific). */
function localWord(t: string): boolean {
  if (hasDigit(t) || BRANDS.has(t) || inClass(t, LINE_WORD_CLASS)) return false;
  return colourOf(t) !== null || inClass(t, NEUTRAL);
}

/**
 * The query without its words in one language: category, connector and generic words and colours
 * ("Oral-B iO Series 9 čierna zubná kefka" -> "Oral-B iO Series 9"). Brand, line, model, tier and
 * package words and every token with a digit stay. Nothing is translated.
 */
export function coreQuery(query: string): string {
  return query.trim().split(/\s+/).filter((w) => {
    const toks = tokenize(w);
    return !toks.length ? false : !toks.every(localWord);
  }).join(' ');
}

/** The text names something specific: a brand and at least one more token, or a token with a digit. */
export function namesSomething(text: string): boolean {
  const toks = parseQuery(text).tokens;
  return toks.some(hasDigit) || (toks.some((t) => BRANDS.has(t)) && toks.length >= 2);
}

/** A review, comparison, manual or advice page (by title or URL slug), unless the query itself asks for one. */
export function isArticlePage(query: ParsedQuery, title: string, url: string): boolean {
  return [...tokenize(title), ...tokenize(urlSlug(url))].some((t) => ARTICLE_WORDS.has(t) && !query.tokens.includes(t));
}

/** Quick relevance score for a search-result candidate (title + URL slug), used to pick pages to fetch. */
export function scoreCandidate(query: ParsedQuery, title: string, url: string): { level: MatchResult['level']; score: number } {
  const slug = urlSlug(url);
  if (isArticlePage(query, title, url)) return { level: 'different', score: 0.05 };
  const fromTitle = title ? matchTitle(query, { title, url }) : null;
  let fromSlug = matchTitle(query, { title: slug, url });
  // Slugs carry ids and sizes without decimal points ("6.1" -> "61"); numeric extras there are noise.
  const slugWordsDifferent = fromSlug.distinguishing.some((t) => !hasDigit(t));
  if (fromSlug.level === 'different' && !fromSlug.missing.length && !slugWordsDifferent) {
    fromSlug = { ...fromSlug, level: 'possible', score: 0.6 };
  }
  // Titles in result lists are often truncated; the slug often carries the model. Take the better
  // of the two, but a distinguishing word in either one marks it different.
  const best = !fromTitle ? fromSlug : fromTitle.score >= fromSlug.score ? fromTitle : fromSlug;
  const anyDifferent = (fromTitle?.distinguishing.length ?? 0) > 0 || slugWordsDifferent;
  const used = (fromTitle && fromTitle.condition !== 'new') || fromSlug.condition !== 'new';
  let score = best.score * (used ? 0.5 : 1);
  if (anyDifferent && best.level !== 'different') return { level: 'different', score: Math.min(score, 0.3) };
  return { level: best.level, score };
}
