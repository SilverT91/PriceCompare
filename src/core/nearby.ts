// Nearby models: when the shops do not list what the user typed, they often list its neighbours
// (another number, tier or package of the same brand and line: "Oral-B Pro 3 3500" for "Oral-B Pro 3
// 3000"). A search already sees them: they are the candidates and offers the matcher rated
// "different". This module turns them into a short list of model names the user can search for next.
// Pure: no network, no extra requests, only what the search collected.
//
// A candidate or offer is a nearby model when:
// - it is not a review / manual / comparison page, and not an accessory (an ACCESSORY_WORDS token
//   in its product part);
// - it shares the product family: every family token of the query (alphabetic, not a tier or
//   package word, not a category word; brand names count) is matched, and when the query has other
//   tokens (numbers, tier words), at least one of them is matched too;
// - its product part (the title before " + " extras) is a different model, not the query's model
//   in a bundle; its condition is new; it carries no amount unit (75 ml, 1 kg) unless the query does
//   (a toothpaste is not a toothbrush model);
// - its page is not the source of a matching offer;
// - a model name can be derived from it, and that name, searched for, matches the product part
//   again as exact or possible (self-check).

import { pageKey } from './links.ts';
import { cleanTitle, isArticlePage, matchTitle, nameOnly, parseQuery, scoreCandidate, urlSlug, type MatchInput, type ParsedQuery } from './matcher.ts';
import { hasDigit, isAlpha, tokenize } from './text.ts';
import { ACCESSORY_WORDS, BRANDS, CATEGORY_WORDS, colourOf, conditionOfToken, inClass, MODEL_WORDS, NEUTRAL, PACKAGE_WORDS } from './vocab.ts';
import type { MatchResult, NearbyList, NearbyModel, NearbyShop, ShopResult } from './types.ts';

export const NEARBY_LIMIT = 8;

const AMOUNT_UNIT = /^\d+(?:\.\d+)?(ml|l|g|kg)$/;

/** Query tokens that name the product family: brand and line words, not numbers, tiers, packages or category words. */
export function familyTokens(pq: ParsedQuery): string[] {
  return pq.tokens.filter((t) => isAlpha(t) && !inClass(t, MODEL_WORDS) && !inClass(t, PACKAGE_WORDS) && (BRANDS.has(t) || !inClass(t, NEUTRAL)));
}

/**
 * The part of a title that names the product: shop suffix and promotion removed (cleanTitle), only
 * the name of a "Name / spec / spec" title, nothing after " + " (bundled extras such as a travel
 * case), then a leading spec list removed and a title the shop wrote twice in a row taken once (nameOnly).
 */
export function productPart(title: string, shopName?: string | null): string {
  let t = cleanTitle(title, shopName);
  const segments = t.split(/\s\/\s/);
  if (segments.length >= 3) t = segments[0];
  return nameOnly(t.split(/\s\+\s/)[0]);
}

/**
 * A model name from a product part, in title order and with the shop's spelling: from the first
 * word that holds a matched query token to the last word the matcher places (a matched query token,
 * a distinguishing token or a variant unit). Inside that span category, colour and condition words
 * are dropped and words the matcher does not know are kept ("iO" in "Oral-B iO Series 3"); words
 * after the span ("Cross Action", "Sensitive Clean", colours) are dropped. When the matched brand
 * came from the brand field and not from the title, the brand goes in front.
 */
export function deriveName(text: string, m: MatchResult, brand?: string | null, family: string[] = []): string | null {
  const words = text.split(/\s+/).filter(Boolean);
  const toks = words.map((w) => tokenize(w));
  const matched = new Set(m.matched);
  const placed = new Set([...m.matched, ...m.distinguishing, ...m.specExtras]);
  const found = new Set<string>();
  // 2 = holds a matched query token, 1 = holds another placed token, 0 = neither
  const role = words.map(() => 0);
  const familyWord = words.map(() => false);
  const inSet = (t: string, set: Set<string>): string[] | null => {
    if (set.has(t)) return [t];
    if (set.has(`${t}pc`)) return [`${t}pc`];
    for (const a of set) if (t.length > a.length && t.startsWith(a) && set.has(t.slice(a.length))) return [a, t.slice(a.length)];
    return null;
  };
  for (let i = 0; i < words.length; i++) {
    for (const t of toks[i]) {
      const hit = inSet(t, matched);
      if (hit) {
        role[i] = 2;
        hit.forEach((h) => found.add(h));
        if (hit.some((h) => family.includes(h))) familyWord[i] = true;
      } else if (inSet(t, placed)) role[i] = Math.max(role[i], 1);
    }
    // a token written over several words: "Oral B" = "oralb", "128 GB" = "128gb"
    for (let j = i + 1; j < Math.min(words.length, i + 3); j++) {
      const joined = toks.slice(i, j + 1).flat().join('');
      const r = matched.has(joined) ? 2 : placed.has(joined) ? 1 : 0;
      if (!r) continue;
      if (r === 2) found.add(joined);
      for (let k = i; k <= j; k++) {
        role[k] = Math.max(role[k], r);
        if (r === 2 && family.includes(joined)) familyWord[k] = true;
      }
    }
  }
  // The name starts at the brand or line word when the title has one ("… rýchlostí: 3 ORAL-B ..."),
  // otherwise at the first matched query word.
  const first = role.indexOf(2);
  if (first < 0) return null;
  let last = words.length - 1;
  while (last > first && !role[last]) last--;
  const fam = familyWord.indexOf(true);
  const start = fam >= 0 && fam < last ? fam : first;
  const end = last;
  const kept: string[] = [];
  for (let i = start; i <= end; i++) {
    const w = words[i].replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}+]+$/gu, '');
    if (!w) continue;
    if (!role[i]) {
      if (!toks[i].length) continue;
      if (toks[i].every((t) => inClass(t, CATEGORY_WORDS) || colourOf(t) || conditionOfToken(t))) continue;
    }
    kept.push(w);
  }
  const brandTok = tokenize(brand ?? '').join('');
  if (brandTok && matched.has(brandTok) && !found.has(brandTok)) kept.unshift((brand ?? '').trim());
  return kept.length ? kept.join(' ') : null;
}

/** One listing of a nearby model: a candidate or an offer of one shop. */
interface Source {
  shop: NearbyShop;
  text: string;
  input: MatchInput;
  fromSlug: boolean;
  match: MatchResult;
  name: string;
  priceEur: number | null;
}

interface Listing {
  shop: NearbyShop;
  /** What the name is derived from: the title's product part, or the URL slug. */
  text: string;
  fromSlug: boolean;
  fullTitle: string;
  brand: string | null;
  itemCondition: string | null;
  priceEur: number | null;
}

const selfMatches = (name: string, input: MatchInput) => matchTitle(parseQuery(name), input).level !== 'different';

function consider(pq: ParsedQuery, family: string[], rest: string[], l: Listing): Source | null {
  if (!l.text) return null;
  const input: MatchInput = { title: l.text, brand: l.brand, url: l.shop.url, shopName: l.shop.shopName };
  const m = matchTitle(pq, input);
  if (m.level !== 'different') return null; // the query's own model (in a bundle, or with extras)
  if (m.distinguishing.some((t) => inClass(t, ACCESSORY_WORDS))) return null;
  if (!family.every((t) => m.matched.includes(t))) return null;
  if (!m.matched.length || (rest.length && !rest.some((t) => m.matched.includes(t)))) return null;
  if (m.specExtras.some((t) => AMOUNT_UNIT.test(t)) && !pq.tokens.some((t) => AMOUNT_UNIT.test(t))) return null;
  const full = matchTitle(pq, { title: l.fullTitle || l.text, brand: l.brand, url: l.shop.url, shopName: l.shop.shopName, itemCondition: l.itemCondition });
  if (full.condition !== 'new' || m.condition !== 'new') return null;
  const name = deriveName(l.text, m, l.brand, family);
  if (!name) return null;
  // The name must name something the query does not ("Oral-B Pro" from a category page is only a
  // broader search), and it must find its own listing again.
  if (!parseQuery(name).tokens.some((t) => !pq.tokens.includes(t) && !inClass(t, CATEGORY_WORDS) && (hasDigit(t) || !BRANDS.has(t)))) return null;
  if (!selfMatches(name, input)) return null;
  return { shop: l.shop, text: l.text, input, fromSlug: l.fromSlug, match: m, name, priceEur: l.priceEur };
}

/**
 * The tokens of a name for comparing names: a brand written as two words is one token ("Oral B" =
 * "oralb", as "Oral-B"), and tokens that only repeat two others ("iO3" after "iO" and "3") are left out.
 */
function nameTokens(name: string): string[] {
  const raw = tokenize(name);
  const toks: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const pair = raw[i] + (raw[i + 1] ?? '');
    if (i + 1 < raw.length && BRANDS.has(pair)) {
      toks.push(pair);
      i++;
    } else toks.push(raw[i]);
  }
  return toks.filter((t) => !toks.some((a) => t.length > a.length && t.startsWith(a) && toks.includes(t.slice(a.length))));
}

/** Cluster keys of a name: its tokens run together in order, and as a sorted set. */
function clusterKeys(name: string): string[] {
  const kept = nameTokens(name);
  return [`run:${kept.join('')}`, `set:${[...new Set(kept)].sort().join(' ')}`];
}

/**
 * The fuller name names the model of this listing too: searched for, it finds the listing as exact
 * or possible, and the only thing it lacks there is a line digit the shop left out (the matcher's
 * "Pro 3000" for "Pro 3 3000"). A missing word ("Spiderman" for a "Pro Kids 3+ Lion King") is another
 * product, even where the matcher only calls it a doubt.
 */
function namesListing(fuller: string, input: MatchInput): boolean {
  const m = matchTitle(parseQuery(fuller), input);
  return m.level !== 'different' && m.missing.every(hasDigit);
}

const isTierOrPackage = (t: string) => inClass(t, MODEL_WORDS) || inClass(t, PACKAGE_WORDS) || /^\d+(pc|x)$/.test(t);

/**
 * Steps from the query: one missing number paired with one extra number ("3000" -> "3500") is one
 * step for the pair; a missing or extra tier or package word (pro, kids, junior, duo, 2pc) is two;
 * anything else one each.
 */
export function nearbyDistance(missing: string[], distinguishing: string[]): number {
  const m = [...new Set(missing)];
  const d = [...new Set(distinguishing)];
  const words = [...m, ...d].filter(isTierOrPackage).length;
  const missNum = m.filter((t) => hasDigit(t) && !isTierOrPackage(t)).length;
  const extraNum = d.filter((t) => hasDigit(t) && !isTierOrPackage(t)).length;
  const pairs = Math.min(missNum, extraNum);
  const other = m.length + d.length - words - 2 * pairs;
  return 2 * words + pairs + other;
}

/** The query's spelling of its brand ("Oral-B"), and the brand token, when the query names a brand. */
function queryBrand(pq: ParsedQuery): { token: string; text: string } | null {
  const words = pq.raw.trim().split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    for (let j = i; j < Math.min(words.length, i + 2); j++) {
      const token = tokenize(words.slice(i, j + 1).join(' ')).join('');
      if (BRANDS.has(token)) return { token, text: words.slice(i, j + 1).join(' ') };
    }
  }
  return null;
}

/**
 * A name in the query's writing: "ORAL-B PRO 3 3900" / "oral b pro 3 3900" -> "Oral-B Pro 3 3900" for
 * the query "Oral-B Pro 3 3000". The brand as the query spells it; a word the query also has, in the
 * query's capitals ("PRO" -> "Pro"); a word of five or more letters, all capitals, with only its first
 * letter upper case ("SERIES" -> "Series"). Shorter words and words with digits or signs stay as the
 * shop writes them ("iO", "GSR", "OLED", "D103", "12V-15", "SC+TC"): a short word in capitals is more
 * often an abbreviation than a shop's way of writing.
 */
function inQueryWriting(name: string, pq: ParsedQuery, brand: { token: string; text: string } | null): string {
  let words = name.split(' ');
  if (brand) {
    for (let k = 1; k <= Math.min(3, words.length); k++) {
      const joined = tokenize(words.slice(0, k).join(' ')).join('');
      if (joined === brand.token) {
        words = [brand.text, ...words.slice(k)];
        break;
      }
      if (!brand.token.startsWith(joined)) break;
    }
  }
  const queryWord = new Map(pq.raw.trim().split(/\s+/).map((w) => [w.toLocaleLowerCase(), w]));
  return words
    .map((w) => queryWord.get(w.toLocaleLowerCase()) ?? (/^\p{Lu}{5,}$/u.test(w) ? w[0] + w.slice(1).toLocaleLowerCase() : w))
    .join(' ');
}

const capsWords = (name: string) => name.split(' ').filter((w) => w.length >= 3 && /\p{L}/u.test(w) && w === w.toUpperCase()).length;

/** Listings of one model. `shorter`: names that came in with a cluster merged into this one as a shorter form. */
interface Cluster {
  keys: Set<string>;
  sources: Source[];
  shorter: Set<string>;
}

/**
 * The name of a cluster: one from a title rather than a slug, that finds most of the cluster's
 * listings again, not a shorter form merged in ("Oral-B PRO 3 3500" over "Oral-B Pro 3500", which
 * also finds them), written in the form most shops use ("Oral-B Pro 3" over "Oral B Pro 3" and
 * "Oral-B Pro3"), with the fewest words in capitals, then the shortest.
 */
function chooseName(c: Cluster): string {
  const names = [...new Set(c.sources.map((s) => s.name))];
  const form = (n: string) => tokenize(n).join(' ');
  const rank = (n: string) => {
    const own = c.sources.filter((s) => s.name === n);
    return {
      slug: own.every((s) => s.fromSlug) ? 1 : 0,
      hits: c.sources.filter((s) => selfMatches(n, s.input)).length,
      shorter: c.shorter.has(n) ? 1 : 0,
      form: new Set(c.sources.filter((s) => form(s.name) === form(n)).map((s) => s.shop.shopId)).size,
      caps: capsWords(n),
      len: n.length,
    };
  };
  return names
    .map((n) => ({ n, r: rank(n) }))
    .sort((a, b) => a.r.slug - b.r.slug || b.r.hits - a.r.hits || a.r.shorter - b.r.shorter || b.r.form - a.r.form || a.r.caps - b.r.caps
      || a.r.len - b.r.len || a.n.localeCompare(b.n))[0].n;
}

/**
 * The same model written two ways ("Oral-B Pro 3500" and "Oral-B PRO 3 3500") ends up in two
 * clusters, because the keys differ. Cluster B joins cluster A when every name of B has only tokens
 * of A's name (B is A with something left out) and A's name names every listing of B (namesListing).
 * Shorter names go first, and a cluster of fewer shops before one of more with the same tokens, so
 * the merged model is the fuller name and the more common form. When several clusters could take B,
 * the one listed by most shops does.
 */
function mergeShorterForms(clusters: Cluster[]): Cluster[] {
  const shopCount = (c: Cluster) => new Set(c.sources.map((s) => s.shop.shopId)).size;
  const merged = new Set<Cluster>();
  const order = clusters
    .map((c) => ({ c, size: nameTokens(chooseName(c)).length, shops: shopCount(c) }))
    .sort((a, b) => a.size - b.size || a.shops - b.shops)
    .map((x) => x.c);
  for (const b of order) {
    const bNames = [...new Set(b.sources.map((s) => s.name))].map(nameTokens);
    const targets = clusters
      .filter((a) => a !== b && !merged.has(a))
      .map((a) => ({ a, name: chooseName(a) }))
      .filter(({ name }) => {
        const toks = new Set(nameTokens(name));
        return bNames.every((n) => n.every((t) => toks.has(t))) && b.sources.every((s) => namesListing(name, s.input));
      })
      .sort((x, y) => shopCount(y.a) - shopCount(x.a) || y.a.sources.length - x.a.sources.length || nameTokens(x.name).length - nameTokens(y.name).length);
    const a = targets[0]?.a;
    if (!a) continue;
    a.sources.push(...b.sources);
    for (const s of b.sources) a.shorter.add(s.name);
    b.shorter.forEach((n) => a.shorter.add(n));
    b.keys.forEach((k) => a.keys.add(k));
    merged.add(b);
  }
  return clusters.filter((c) => !merged.has(c));
}

function differsText(missing: string[], distinguishing: string[]): string {
  const q = (xs: string[]) => xs.map((x) => `"${x}"`).join(', ');
  const parts: string[] = [];
  if (distinguishing.length) parts.push(`has ${q(distinguishing)}`);
  if (missing.length) parts.push(`lacks ${q(missing)}`);
  return parts.join(', ');
}

/**
 * Similar models the shops list, in two tiers. First the same line with another number (distance 1
 * under nearbyDistance()), by number of shops, then a local branch. Then all others, the models most
 * shops list first, then by distance, then a local branch, then name. At most NEARBY_LIMIT; `total` says how
 * many there were.
 */
export function nearbyModels(pq: ParsedQuery, results: ShopResult[], limit = NEARBY_LIMIT): NearbyList {
  const family = familyTokens(pq);
  const brand = queryBrand(pq);
  const rest = pq.tokens.filter((t) => !family.includes(t) && (hasDigit(t) || inClass(t, MODEL_WORDS) || inClass(t, PACKAGE_WORDS) || !inClass(t, NEUTRAL)));
  const allOffers = results.flatMap((r) => r.offers);
  const matchingPages = new Set(allOffers.filter((o) => o.match.level !== 'different').map((o) => pageKey(o.url)));
  const readPages = new Set(allOffers.map((o) => pageKey(o.url)));

  const sources: Source[] = [];
  for (const r of results) {
    const shopOf = (url: string, title: string): NearbyShop => ({ shopId: r.shopId, shopName: r.shopName, section: r.section, url, title });
    for (const o of r.offers) {
      if (o.match.level !== 'different' || matchingPages.has(pageKey(o.url))) continue;
      if (isArticlePage(pq, o.title, o.url)) continue;
      const s = consider(pq, family, rest, {
        shop: shopOf(o.url, o.title), text: productPart(o.title, r.shopName), fromSlug: false, fullTitle: o.title,
        brand: o.brand, itemCondition: o.itemCondition, priceEur: o.totals.itemEur,
      });
      if (s) sources.push(s);
    }
    for (const c of r.candidates) {
      // A page that was read is represented by its offers, which carry the shop's own product data.
      if (readPages.has(pageKey(c.url)) || matchingPages.has(pageKey(c.url))) continue;
      if (isArticlePage(pq, c.title, c.url)) continue;
      if (scoreCandidate(pq, c.title, c.url).level !== 'different') continue;
      const titleText = c.title ? productPart(c.title, r.shopName) : '';
      const base = { shop: shopOf(c.url, c.title), fullTitle: c.title, brand: null, itemCondition: null, priceEur: null };
      // The slug stands in only when the title names nothing of the query ("Oscilačné zubné kefky").
      const titleKnows = titleText && matchTitle(pq, { title: titleText, shopName: r.shopName }).matched.length > 0;
      const s = titleKnows
        ? consider(pq, family, rest, { ...base, text: titleText, fromSlug: false })
        : consider(pq, family, rest, { ...base, text: urlSlug(c.url), fullTitle: c.title || urlSlug(c.url), fromSlug: true });
      if (s) sources.push(s);
    }
  }

  // ---- cluster the same model across shops ----
  const clusters: Cluster[] = [];
  for (const s of sources) {
    const keys = clusterKeys(s.name);
    const hit = clusters.find((c) => keys.some((k) => c.keys.has(k)));
    if (hit) {
      hit.sources.push(s);
      keys.forEach((k) => hit.keys.add(k));
    } else clusters.push({ keys: new Set(keys), sources: [s], shorter: new Set() });
  }

  const models: (NearbyModel & { local: boolean })[] = mergeShorterForms(clusters).map((c) => {
    const chosen = chooseName(c);
    // In the query's writing, if the name still finds a listing that way.
    const rewritten = inQueryWriting(chosen, pq, brand);
    const query = rewritten !== chosen && c.sources.some((s) => selfMatches(rewritten, s.input)) ? rewritten : chosen;
    const dist = (s: Source) => nearbyDistance(s.match.missing, s.match.distinguishing);
    const closest = [...c.sources].sort((a, b) => dist(a) - dist(b))[0];
    const order = (t: string) => (pq.tokens.includes(t) ? pq.tokens.indexOf(t) : pq.tokens.length);
    const missing = [...new Set(closest.match.missing)].sort((a, b) => order(a) - order(b));
    const distinguishing = [...new Set(closest.match.distinguishing)];
    // One entry per shop; a page that was read (it has a price) comes before an unread one.
    const byShop = new Map<string, Source>();
    for (const s of [...c.sources].sort((a, b) => (a.priceEur === null ? 1 : 0) - (b.priceEur === null ? 1 : 0))) {
      if (!byShop.has(s.shop.shopId)) byShop.set(s.shop.shopId, s);
    }
    const shops = [...byShop.values()].map((s) => s.shop);
    const priced = c.sources.filter((s) => s.priceEur !== null).sort((a, b) => (a.priceEur as number) - (b.priceEur as number))[0];
    return {
      query, shops, differs: differsText(missing, distinguishing), missing, distinguishing, distance: nearbyDistance(missing, distinguishing),
      seenPrice: priced ? { eur: priced.priceEur as number, shopName: priced.shop.shopName, url: priced.shop.url, from: 'search' } : null,
      local: shops.some((s) => s.section === 'local'),
    };
  });
  // Tier 1: the same line with one number swapped (distance 1). Tier 2: the rest, what most shops list first.
  const tier = (m: { distance: number }) => (m.distance <= 1 ? 0 : 1);
  models.sort((a, b) => tier(a) - tier(b) || b.shops.length - a.shops.length || a.distance - b.distance
    || Number(b.local) - Number(a.local) || a.query.localeCompare(b.query));
  return { models: models.slice(0, limit).map(({ local: _local, ...m }) => m), total: models.length };
}
