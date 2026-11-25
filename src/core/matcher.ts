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
  ACCESSORY_WORDS, colourOf, conditionOfToken, inClass, MODEL_WORDS, NEUTRAL, NEUTRAL_UNITS, PACKAGE_WORDS, VARIANT_UNITS,
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

/** Pack/count phrases become one token: "39-dielna" -> "39pc", "2 ks" -> "2pc", "2x" -> "2x", "1×2 ks" -> "2pc". */
function packTokens(folded: string): { text: string; packs: string[] } {
  const packs: string[] = [];
  let text = folded.replace(MULTI_RE, (_m, pre: string, a: string, b: string) => {
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
    const idx = coverIndices(t, titleTokens);
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
  for (let i = 0; i < titleTokens.length; i++) {
    const t = titleTokens[i];
    if (qset.has(t) || consumed.has(i)) continue;
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
    if (qset.has(t)) continue;
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

/** The URL path as words ("/oral-b-pro-3-3500.html" -> "oral b pro 3 3500"); empty for an invalid URL. */
export function urlSlug(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname).replace(/[/_+\-]+/g, ' ').replace(/\.(html?|php)$/, '').trim();
  } catch {
    return '';
  }
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
