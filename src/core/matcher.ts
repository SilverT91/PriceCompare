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
import { reasonText } from './i18n.ts';
import type { Condition, MatchReason, MatchResult } from './types.ts';

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

// "(MYED3SX/A)", "(MYE73)", "(EE6J3ET#BCM)": uppercase codes in brackets are part numbers.
const BRACKET_CODE_RE = /\(\s*([A-Z0-9][A-Z0-9/\-.#]{3,})\s*\)/g;

/** Remove page-title suffixes, an appended cashback promotion and bracketed part codes. */
export function cleanTitle(title: string, shopName?: string | null): string {
  return withoutSuffix(title, shopName).replace(BRACKET_CODE_RE, ' ').trim();
}

/**
 * A part code as the manufacturer's product number, without the market suffix: "EE6J3ET#BCM" ->
 * "ee6j3et" (HP's localisation after "#"), "MYED3SX/A" -> "myed3" (Apple's region letters before "/").
 * The same product sold for two markets keeps one code; two configurations keep two.
 */
function codeRoot(code: string): string {
  const c = code.toLowerCase();
  if (c.includes('#')) return c.slice(0, c.indexOf('#'));
  if (c.includes('/')) {
    const head = c.slice(0, c.indexOf('/'));
    const bare = head.replace(/[a-z]{1,2}$/, '');
    return bare.length >= 4 && /\d/.test(bare) ? bare : head;
  }
  return c;
}

/**
 * A title written as a name followed by a list of specifications: "HP PC Z2 Tower G1i 1200W, Intel
 * Core U7 270K Plus, Intel Graphics,2×16GB DDR5,1TB,Kb+mouse,Win11Pro,3yo". The parts are split at
 * commas; a decimal comma ("4,7 GHz") stays. A list has the name and at least three more parts, two
 * of them with an amount and a unit (capacity, power, frequency). Null when the text is no such list.
 */
export function specList(text: string): { name: string; specs: string[] } | null {
  const parts: string[] = [];
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== ',') continue;
    // "4,7": a decimal comma, when the number before it stands alone ("DDR5,1TB" is two parts).
    if (/\d/.test(text[i + 1] ?? '') && /(?:^|[^\p{L}\d.])\d+$/u.test(text.slice(from, i))) continue;
    parts.push(text.slice(from, i));
    from = i + 1;
  }
  parts.push(text.slice(from));
  const kept = parts.map((p) => p.trim()).filter(Boolean);
  if (kept.length < 4) return null;
  // "LENOVO NTB IdeaPad Slim 5 16IMH10 - Ultra 5 135H,16" WUXGA OLED,16GB,512SSD": the list starts after " - ".
  const [first, ...rest] = kept;
  const dash = first.split(/\s[-–]\s/);
  const name = dash.length === 2 ? dash[0].trim() : first;
  const specs = dash.length === 2 ? [dash[1].trim(), ...rest] : rest;
  const withUnit = specs.filter((s) => /\d\s*(?:gb|tb|mb|w|ghz|mhz|hz|mah|wh|ssd|hdd)(?![a-z])|\d(?:"|''|\s?inch)/i.test(s)).length;
  return withUnit >= 2 && /\p{L}/u.test(name) ? { name, specs } : null;
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

// Specifications written with a unit become one token each, so they are read as specifications and
// never as model numbers (vocab.ts: NEUTRAL_UNITS, VARIANT_UNITS):
// - the version of an interface goes ("PCI-E 4.0 x4", "USB 3.2", "HDMI 2.1", "Bluetooth 5.3"): the interface describes the product;
// - a count of ports or fans is not a pack ("1x HDMI + 3x DP");
// - "6000 MHz", "6000MT/s" -> "6000mhz"; "4,7 GHz" -> "4.7ghz"; "144 Hz" -> "144hz";
// - "7450 MBps", "7450 MB/s" -> "7450mbps"; "256-bit" -> "256bit"; "512SSD" (a capacity) -> "512gb ssd".
const INTERFACE = String.raw`pci\s?-?e(?:xpress)?|usb(?:\s?-?c)?|bluetooth|wi\s?-?fi|hdmi|displayport|thunderbolt|sata|dp`;
const VERSION_RE = new RegExp(String.raw`(?<![a-z0-9])(${INTERFACE})\s*(?:gen\s*)?\d+(?:\.\d+)?(?:\s*x\s?\d+)?(?![\d.]|\s*(?:gb|tb|mb|w|v)(?![a-z]))`, 'g');
const PORT_COUNT_RE = new RegExp(String.raw`(?<![a-z0-9.])\d+\s*x\s*(?=(?:${INTERFACE}|mini\s?dp|type\s?-?c|vga|dvi|rj\s?-?45|lan|m\.2|nvme|fans?|ventilator\w*)(?![a-z]))`, 'g');
const FREQ_RE = /(?<![a-z0-9.])(\d+(?:[.,]\d+)?)\s*(mt\/s|mts|mhz|ghz)(?![a-z])/g;
const HZ_RE = /(?<![a-z0-9.])(\d+)\s*hz(?![a-z])/g;
const RATE_RE = /(?<![a-z0-9.])(\d+(?:[.,]\d+)?)\s*(mb\/s|mbps|gb\/s|gbps)(?![a-z])/g;
const BITS_RE = /(?<![a-z0-9.])(\d+)\s*-?\s*bit(?:s|ov|u|y)?(?![a-z])/g;
const DRIVE_RE = /(?<![a-z0-9.])(\d{3,4})\s*(ssd|hdd)(?![a-z])/g;

function specificationText(folded: string): string {
  const num = (n: string) => n.replace(',', '.');
  return folded
    .replace(VERSION_RE, (_m, iface: string) => `${iface} `)
    .replace(PORT_COUNT_RE, ' ')
    .replace(FREQ_RE, (_m, n: string, unit: string) => ` ${num(n)}${unit === 'ghz' ? 'ghz' : 'mhz'} `)
    .replace(HZ_RE, (_m, n: string) => ` ${n}hz `)
    .replace(RATE_RE, (_m, n: string, unit: string) => ` ${num(n)}${unit.startsWith('g') ? 'gbps' : 'mbps'} `)
    .replace(BITS_RE, (_m, n: string) => ` ${n}bit `)
    .replace(DRIVE_RE, (_m, n: string, kind: string) => ` ${n}gb ${kind} `);
}

/**
 * "VENTUS 3X OC": a count between two name words is part of the name (a fan count), not a pack. A
 * count cut off by the shop's truncation ("16GB GDDR7, 3x...") says nothing about what is counted.
 */
function countInName(before: string, after: string): 'name' | 'cut' | null {
  if (/^\s*\.\.\./.test(after)) return 'cut';
  const next = /^\s+([a-z][a-z0-9]*)/.exec(after)?.[1];
  if (!/[a-z]{2,}\s+$/.test(before) || !next) return null;
  const known = inClass(next, PACKAGE_WORDS) || inClass(next, ACCESSORY_WORDS) || inClass(next, NEUTRAL) || colourOf(next) !== null;
  return known ? null : 'name';
}

/** Pack/count phrases become one token: "39-dielna" -> "39pc", "2 ks" -> "2pc", "2x" -> "2x", "1×2 ks" -> "2pc"; a pack of two -> "duo". */
function packTokens(folded: string): { text: string; packs: string[] } {
  const packs: string[] = [];
  let text = specificationText(folded).replace(TWO_PACK_RE, 'duo').replace(DUO_COUNT_RE, 'duo');
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
  text = text.replace(TIMES_RE, (m, a: string | undefined, b: string | undefined, c: string | undefined, offset: number, whole: string) => {
    const n = a ?? b ?? c ?? '';
    const sep = m.startsWith(' ') ? ' ' : m[0] && !/\d|x/.test(m[0]) ? `${m[0]} ` : ' ';
    if (a) {
      const at = offset + m.search(/\d/);
      const where = countInName(whole.slice(0, at), whole.slice(offset + m.length));
      if (where === 'name') return m; // stays a word of the name: "3x"
      if (where === 'cut') return sep;
    }
    if (n && n !== '1') packs.push(`${n}x`);
    return sep;
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
  // Seven characters of letters and digits are a code when they start with a letter ("md1q4sx");
  // starting with digits they are a model number ("9800x3d", a processor). Eight or more: a code.
  if (tok.length >= 8 && /[a-z]/.test(tok)) return true;
  if (tok.length === 7 && /^[a-z]/.test(tok) && /[a-z]/.test(tok)) return true;
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
  const brandList = tokenize(input.brand ?? '');
  // A name followed by a comma-separated specification list (specList): when the name holds the
  // query, the list describes the configuration (processor, graphics card, memory) and its model
  // numbers are not the product's. Not when the query is found only in the list ("RTX 5080" in a
  // whole computer's title): that stays another product.
  const list = segments.length >= 3 ? null : listedConfiguration(q, specList(cleaned), brandList);
  const main = segments.length >= 3 ? segments[0] : list ? list.name : cleaned;
  const specText = segments.length >= 3 ? segments.slice(1).join(' ') : '';
  const { text, packs } = packTokens(foldSimple(main));
  const spec = packTokens(foldSimple(specText));
  const specTokens = tokenize(spec.text);
  const listTokens = list ? list.specs.flatMap((s) => tokenize(packTokens(foldSimple(s)).text)) : [];
  const titleTokens = tokenize(text);
  const brandTokens = new Set(brandList);
  const codes = new Set([...tokenize(input.sku ?? ''), ...tokenize(input.mpn ?? '')].filter((t) => t.length >= 4));
  const reasons: string[] = [];
  const reasonCodes: MatchReason[] = [];
  // Every reason as data (for a translation) and in English, as `reasons` has always said it.
  const say = (r: MatchReason) => {
    reasonCodes.push(r);
    reasons.push(reasonText('en', r));
  };

  // 1. Query tokens present?
  const missing: string[] = [];
  const missingAlpha: string[] = [];
  const softMissing: string[] = [];
  /** Short query numbers found only as the start of a longer code ("16" in "16imh10"): a doubt. */
  const codeStarts: string[] = [];
  const matched: string[] = [];
  const consumed = new Set<number>();
  /** Where in the title a query token was found (for rule 4 below). */
  const at = new Map<string, number>();
  const found = (t: string, i: number) => {
    matched.push(t);
    consumed.add(i);
    if (!at.has(t)) at.set(t, i);
  };
  for (const t of q.tokens) {
    const idx = coverIndices(t, titleTokens) ?? gluedCover(t, titleTokens);
    if (idx) {
      matched.push(t);
      idx.forEach((i) => consumed.add(i));
      at.set(t, idx[0]);
      continue;
    }
    if (coverIndices(t, brandList)) {
      matched.push(t);
      continue;
    }
    // A query pair "iphone","16" may be one title token "iphone16".
    const joined = titleTokens.findIndex((tt) => tt.length > t.length && q.tokens.some((o) => o !== t && (tt === t + o || tt === o + t)));
    if (joined >= 0) {
      found(t, joined);
      continue;
    }
    if (coverIndices(t, specTokens) || coverIndices(t, listTokens)) {
      matched.push(t);
      continue;
    }
    if (lineDigitOmitted(t, q, titleTokens)) {
      softMissing.push(t);
      continue;
    }
    if (/^\d+$/.test(t)) {
      // A bare number meets the same number with a frequency or screen-size unit, when that is the only
      // reading (the title has no bare token with it): "6000" and "6000 MHz", "6000MT/s"; "16" and 16".
      // Not other units: "3000" is not "3000 mAh".
      const withUnit = titleTokens.findIndex((tt, i) => !consumed.has(i) && (tt === `${t}mhz` || tt === `${t}hz` || tt === `${t}in`));
      if (withUnit >= 0) {
        found(t, withUnit);
        continue;
      }
      // A number of one or two digits that starts a configuration code ("16" in "16IMH10", "16ARP10": a
      // number, two or more letters, digits) is only possible; "16e", "9N" and "3000" are no such code.
      const code = t.length <= 2 ? titleTokens.findIndex((tt, i) => !consumed.has(i) && new RegExp(`^${t}[a-z]{2,}\\d+[a-z]*$`).test(tt)) : -1;
      if (code >= 0) {
        found(t, code);
        codeStarts.push(t);
        say({ code: 'codeStart', params: { token: t, title: titleTokens[code] } });
        continue;
      }
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
        found(t, near);
        say({ code: 'nearSpelling', params: { token: t, title: titleTokens[near] } });
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
  // Part codes in brackets were taken out of the title for matching; they still name the configuration.
  const partCodes: string[] = [...withoutSuffix(input.title, input.shopName).matchAll(BRACKET_CODE_RE)]
    .map((m) => codeRoot(m[1])).filter((c) => /[a-z]/.test(c) && /\d/.test(c));
  /** Model numbers and amounts in a specification list after the name (listedConfiguration). */
  const listSpecs: string[] = [];
  let colour: string | null = null;
  // "Súprava zubných kefiek ... Duo Pack": with the two-pack word in the title, a generic set word says nothing more.
  const twoPackTitle = titleTokens.includes('duo') || specTokens.includes('duo');
  const setSaysNothing = (t: string) => twoPackTitle && GENERIC_SET_WORDS.has(t);
  for (let i = 0; i < titleTokens.length; i++) {
    const t = titleTokens[i];
    if (qset.has(t) || consumed.has(i) || setSaysNothing(t)) continue;
    // The same token as one that met the query, written again (a title the shop wrote twice): "16imh10".
    if (titleTokens.some((x, j) => j !== i && consumed.has(j) && x === t)) continue;
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
    // Specifications first: "6000mhz" is a memory speed, not an order code of seven characters.
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
    if (isPartCode(t, codes)) {
      // Manufacturer order codes in titles ("060186810F") link offers across shops like a GTIN.
      if (t.length >= 8 && /[a-z]/.test(t) || /^0\d{9}$/.test(t)) titleCodes.push(t);
      if (/[a-z]/.test(t) && /\d/.test(t)) partCodes.push(t);
      continue;
    }
    if (inClass(t, NEUTRAL)) continue;
    if (/^\d+d$/.test(t) || /^\d+x$/.test(t)) {
      unknownExtras.push(t); // "3D White", "2D": a head type; "VENTUS 3X": a fan count in the name; not model numbers
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
  // A specification list after the name: a part's tier word ("RTX Pro 4000", "U7 270K Plus") is the
  // part's, not the product's; its model numbers and amounts tell configurations apart (the user is
  // asked to check), and a condition, package or accessory word still counts as in the name. Words
  // for something left out ("bez OS", "no Kb+mouse") describe the configuration.
  for (const t of listTokens) {
    if (qset.has(t) || matched.includes(t)) continue;
    const cond = conditionOfToken(t);
    if (cond) {
      condWords.push(cond);
      conditionWords.push(t);
    } else if ((inClass(t, PACKAGE_WORDS) || inClass(t, ACCESSORY_WORDS)) && !LEFT_OUT.has(t) && !distinguishing.includes(t)) {
      distinguishing.push(t);
    } else if (colourOf(t)) {
      colour = colour ?? colourOf(t);
    } else if (hasDigit(t) && !NEUTRAL_UNITS.test(t) && !/^\d$|^\d+x$/.test(t) && !listSpecs.includes(t)) {
      listSpecs.push(t);
    }
  }
  // The title's colour word is usually more specific ("Teal") than the JSON-LD color ("Zielony").
  if (input.color && !colour) colour = colourOf(tokenize(input.color)[0] ?? '') ?? foldSimple(input.color);

  const condition = conditionFrom(input.itemCondition, input.url, condWords);
  if (condition !== 'new') say({ code: 'condition', params: { condition, words: [...conditionWords] } });

  // A missing query word with an unknown title word in its place is another product: "MX Anywhere 3S"
  // for "MX Master 3S". The place is between the title positions of the query words around it (or
  // right next to the one neighbour found). With nothing in its place it stays a doubt (below).
  for (const t of [...missingAlpha]) {
    const qi = q.tokens.indexOf(t);
    const prev = q.tokens.slice(0, qi).reverse().find((x) => at.has(x));
    const next = q.tokens.slice(qi + 1).find((x) => at.has(x));
    const from = prev !== undefined ? (at.get(prev) as number) + 1 : next !== undefined ? (at.get(next) as number) - 1 : -1;
    const to = next !== undefined ? (at.get(next) as number) - 1 : prev !== undefined ? (at.get(prev) as number) + 1 : -2;
    const instead = titleTokens.slice(Math.max(0, from), to + 1).find((tt, k) => !consumed.has(from + k) && isAlpha(tt) && tt.length >= 3 && unknownExtras.includes(tt));
    if (from >= 0 && to >= from && instead) {
      missingAlpha.splice(missingAlpha.indexOf(t), 1);
      missing.push(t);
      say({ code: 'insteadOf', params: { instead, token: t } });
    }
  }
  // A missing tier word ("pro") or two missing words (brand and line: "Braun Series 3 3000" for
  // "Oral-B Pro 3 3000") mean another product; one missing plain word is only a doubt.
  if (missingAlpha.some((t) => inClass(t, MODEL_WORDS) || inClass(t, PACKAGE_WORDS)) || missingAlpha.length >= 2) {
    missing.push(...missingAlpha.splice(0));
  }
  let level: MatchResult['level'];
  if (missing.length || distinguishing.length) {
    level = 'different';
    if (missing.length) say({ code: 'titleLacks', params: { words: [...missing] } });
    if (distinguishing.length) say({ code: 'titleHas', params: { words: [...distinguishing] } });
  } else if (softMissing.length || codeStarts.length || missingAlpha.length || unknownExtras.length || specExtras.length || listSpecs.length) {
    level = 'possible';
    for (const t of softMissing) {
      const next = q.tokens[q.tokens.indexOf(t) + 1];
      say({ code: 'sameOrOlder', params: { before: String(q.tokens[q.tokens.indexOf(t) - 1]), after: String(next), token: t } });
    }
    if (missingAlpha.length) say({ code: 'titleLacks', params: { words: [...missingAlpha] } });
    if (specExtras.length || listSpecs.length) say({ code: 'variantNotInQuery', params: { words: [...new Set([...specExtras, ...listSpecs])] } });
    if (unknownExtras.length) say({ code: 'extraWords', params: { words: [...unknownExtras] } });
  } else {
    level = 'exact';
  }

  let score: number;
  if (level === 'exact') score = 1;
  // A specification list counts as one doubt, however long it is.
  else if (level === 'possible') score = 0.75 - 0.04 * unknownExtras.length - 0.08 * specExtras.length - 0.12 * missingAlpha.length - 0.15 * softMissing.length
    - 0.1 * codeStarts.length - (listSpecs.length ? 0.08 : 0);
  else score = 0.35 - 0.05 * distinguishing.length - 0.08 * missing.length;
  score = Math.max(0.01, Math.min(1, score));

  const sigTokens = [...new Set([...matched, ...distinguishing, ...specExtras, ...listSpecs])].sort();
  const signature = sigTokens.join(' ') + (condition !== 'new' ? ` [${condition}]` : '');

  return {
    level, score, matched: [...new Set(matched)], missing: [...missing, ...missingAlpha, ...softMissing], distinguishing, specExtras, unknownExtras,
    condition, conditionWords, colour, signature, codes: titleCodes, partCode: partCodes[0] ?? null, reasons, reasonCodes,
  };
}

/** Words in a specification list that say something is left out ("bez OS", "no Kb+mouse"). */
const LEFT_OUT = new Set(['bez', 'ohne', 'no', 'without', 'solo', 'bare', 'body']);

/**
 * The title's specification list, when its name part holds the query: every query word that is not
 * a category word or a colour is in the name or in the list, and the name holds a query word with a
 * digit ("Z2", "G1i") or, for a query without one, all of the query. Null otherwise.
 */
function listedConfiguration(q: ParsedQuery, list: { name: string; specs: string[] } | null, brandList: string[]): { name: string; specs: string[] } | null {
  if (!list) return null;
  const nameTokens = tokenize(packTokens(foldSimple(list.name)).text);
  const listTokens = list.specs.flatMap((s) => tokenize(packTokens(foldSimple(s)).text));
  // A short number that starts a configuration code ("16" in "16IMH10") is in the name as a doubt (matchTitle, codeStart).
  const inName = (t: string) => Boolean(coverIndices(t, nameTokens) ?? gluedCover(t, nameTokens) ?? coverIndices(t, brandList))
    || (/^\d{1,2}$/.test(t) && nameTokens.some((n) => new RegExp(`^${t}[a-z]{2,}\\d+[a-z]*$`).test(n)));
  const optional = (t: string) => inClass(t, NEUTRAL) || colourOf(t) !== null;
  if (!q.tokens.every((t) => inName(t) || optional(t) || coverIndices(t, listTokens))) return null;
  const nameHolds = q.tokens.some(hasDigit) ? q.tokens.some((t) => hasDigit(t) && inName(t)) : q.tokens.every((t) => inName(t) || optional(t));
  return nameHolds ? list : null;
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

/**
 * Names of a shop's program or page file ("default.asp", "index.php", "product.aspx"), with or
 * without the ending: a link whose path is only such a file keeps the product in its query string,
 * which is not read.
 */
const GENERIC_FILES = new Set(['default', 'index', 'main', 'home', 'start', 'page', 'view', 'show', 'detail', 'details', 'product',
  'products', 'item', 'items', 'goods', 'catalog', 'katalog', 'shop', 'eshop', 'search']);

/** A path segment's words, ids and file ending removed; empty when nothing in it names a product. */
function segmentWords(segment: string): string[] {
  if (GENERIC_FILES.has(segment.trim().replace(FILE_ENDING, '').toLowerCase())) return [];
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
