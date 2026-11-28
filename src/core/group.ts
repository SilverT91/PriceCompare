// Groups offers into distinct products ("Which one do you mean?").
// Offers are linked when they share a normalised GTIN or the same model signature (which already
// includes condition, so used/refurbished offers never join new ones). Inside a product, offers are
// split into variants by GTIN or colour so colour variants appear side by side.

import { displayGtin } from './gtin.ts';
import { colourName, t, type Lang } from './i18n.ts';
import { displayTitle } from './matcher.ts';
import { headline, reachable, sortOffers } from './totals.ts';
import type { MatchLevel, Offer, ProductGroup, ProductVariant } from './types.ts';
import { NEUTRAL_UNITS, VARIANT_UNITS } from './vocab.ts';

const LEVEL_RANK: Record<MatchLevel, number> = { exact: 0, possible: 1, different: 2 };

class UnionFind {
  parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(i: number): number {
    while (this.parent[i] !== i) {
      this.parent[i] = this.parent[this.parent[i]];
      i = this.parent[i];
    }
    return i;
  }
  union(a: number, b: number) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[rb] = ra;
  }
}

function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/**
 * The query's own long model codes found in a matching offer ("gt223582nc" for "HP OMEN 45L
 * GT22-3582nc"): eight or more characters of letters and digits, not a unit. Such a code names one
 * configuration, so offers that share it are one product, whether the shop names the configuration
 * by its part number (Datacomp: "..., D8QT8EA") or by its specifications (ABCOM: "..., Ultra
 * 9-285K, 64GB DDR5, ..."). A shorter code ("16IMH10", "G1i") names a line with many configurations.
 */
function modelCodes(o: Offer): string[] {
  if (o.match.level === 'different') return [];
  return o.match.matched.filter((t) => t.length >= 8 && /[a-z]/.test(t) && /\d/.test(t) && !VARIANT_UNITS.test(t) && !NEUTRAL_UNITS.test(t));
}

/**
 * One product split into its configurations: when two offers of the same colour name different part
 * codes ("HP Z2 Tower G1i, EE7H6ES" and "..., A40MKET"), the line is sold in configurations and each
 * part code is a product of its own. Different colours with different codes are colour variants of
 * one product (an iPhone's part code changes with the colour) and stay together. An offer without a
 * part code joins the configuration it shares a GTIN with, or else the offers without one.
 */
function byConfiguration(members: Offer[]): Offer[][] {
  const codesByColour = new Map<string, Set<string>>();
  for (const m of members) {
    if (!m.match.partCode) continue;
    const c = m.match.colour ?? '';
    codesByColour.set(c, (codesByColour.get(c) ?? new Set()).add(m.match.partCode));
  }
  if (![...codesByColour.values()].some((s) => s.size > 1)) return [members];
  const parts = new Map<string, Offer[]>();
  const codeOfGtin = new Map<string, string>();
  for (const m of members) if (m.match.partCode && m.gtin) codeOfGtin.set(m.gtin, m.match.partCode);
  for (const m of members) {
    const key = m.match.partCode ?? (m.gtin ? codeOfGtin.get(m.gtin) : undefined) ?? '';
    parts.set(key, [...(parts.get(key) ?? []), m]);
  }
  return [...parts.values()];
}

/** lang: the language of the notes and variant labels (default English); the grouping does not depend on it. */
/** The product notes in `lang`, from the facts they state (the page builds the same lines from noteFacts). */
export function groupNotes(f: ProductGroup['noteFacts'], lang: Lang = 'en'): string[] {
  const notes: string[] = [];
  if (f.noDelivery) notes.push(t(lang, 'noDeliveryOffers', { n: f.noDelivery }));
  if (f.gtins) notes.push(t(lang, 'gtinCount', { n: f.gtins }));
  if (f.mixed) notes.push(t(lang, 'somePossible'));
  if (f.noGtin) notes.push(f.gtins ? t(lang, 'someByName') : t(lang, 'allByName'));
  return notes;
}

export function groupOffers(offers: Offer[], lang: Lang = 'en'): ProductGroup[] {
  const uf = new UnionFind(offers.length);
  const byGtin = new Map<string, number>();
  const bySig = new Map<string, number>();
  const byCode = new Map<string, number>();
  offers.forEach((o, i) => {
    // A GTIN only links offers of the same condition.
    if (o.gtin) {
      const k = `${o.gtin}|${o.match.condition}`;
      const j = byGtin.get(k);
      if (j === undefined) byGtin.set(k, i);
      else uf.union(j, i);
    }
    const s = o.match.signature;
    const j = bySig.get(s);
    if (j === undefined) bySig.set(s, i);
    else uf.union(j, i);
    for (const c of [...(o.match.codes ?? []), ...modelCodes(o)]) {
      const k = `${c}|${o.match.condition}`;
      const x = byCode.get(k);
      if (x === undefined) byCode.set(k, i);
      else uf.union(x, i);
    }
  });
  const comps = new Map<number, Offer[]>();
  offers.forEach((o, i) => {
    const r = uf.find(i);
    comps.set(r, [...(comps.get(r) ?? []), o]);
  });

  const groups: ProductGroup[] = [];
  for (const members of [...comps.values()].flatMap(byConfiguration)) {
    const best = [...members].sort((a, b) => LEVEL_RANK[a.match.level] - LEVEL_RANK[b.match.level] || b.match.score - a.match.score || a.title.length - b.title.length)[0];
    // The name shown for the product comes from an offer the user can get: a branch in the city
    // first, then a shop that delivers to Slovakia; a shop that does not deliver only as a last resort.
    const reach = (o: Offer) => (o.section === 'local' ? 0 : o.totals.deliversToSk === true ? 1 : reachable(o.totals) ? 2 : 3);
    const named = [...members].sort((a, b) => (a.match.level === 'different' ? 1 : 0) - (b.match.level === 'different' ? 1 : 0) || reach(a) - reach(b)
      || LEVEL_RANK[a.match.level] - LEVEL_RANK[b.match.level] || b.match.score - a.match.score || a.title.length - b.title.length)[0];
    const gtins = [...new Set(members.map((m) => m.gtin).filter((g): g is string => Boolean(g)))];
    const sigCounts = new Map<string, number>();
    for (const m of members) sigCounts.set(m.match.signature, (sigCounts.get(m.match.signature) ?? 0) + 1);
    const signature = [...sigCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];

    // Variants: by GTIN; offers without a GTIN join the variant of the same colour when unambiguous.
    const variants = new Map<string, Pick<ProductVariant, 'key' | 'label' | 'gtin' | 'colour' | 'offers'>>();
    const colourOf = (o: Offer) => o.match.colour;
    for (const m of members.filter((x) => x.gtin)) {
      const key = `gtin:${m.gtin}`;
      const v = variants.get(key) ?? { key, label: '', gtin: m.gtin, colour: colourOf(m), offers: [] };
      v.colour = v.colour ?? colourOf(m);
      v.offers.push(m);
      variants.set(key, v);
    }
    for (const m of members.filter((x) => !x.gtin)) {
      const c = colourOf(m);
      const sameColour = [...variants.values()].filter((v) => v.gtin && v.colour && v.colour === c);
      if (c && sameColour.length === 1) {
        sameColour[0].offers.push(m);
        continue;
      }
      const key = `colour:${c ?? 'unspecified'}|${[...m.match.unknownExtras].sort().join(' ')}`;
      const v = variants.get(key) ?? { key, label: '', gtin: null, colour: c, offers: [] };
      v.offers.push(m);
      variants.set(key, v);
    }
    const variantList = [...variants.values()].map((v) => {
      // Words the matcher did not place (head type, edition: "CrossAction", "PureClean") tell
      // same-colour variants apart, so they go into the label.
      const words = [...new Set(v.offers.flatMap((o) => o.match.unknownExtras))].slice(0, 3);
      const vm = v.offers.filter((o) => o.match.level !== 'different');
      const h = headline(vm.length ? vm : v.offers);
      return {
        ...v,
        label: [v.colour ? colourName(lang, v.colour) : t(lang, 'colourNotStated'), words.length ? words.join(' ') : null, v.gtin ? `GTIN ${displayGtin(v.gtin)}` : null].filter(Boolean).join(', '),
        words,
        offers: sortOffers(v.offers),
        bestItemEur: h.bestItemEur,
        bestItemTotalKnown: h.bestItemTotalKnown,
        bestTotalEur: h.bestTotalEur,
      } satisfies ProductVariant;
    });
    // Offers joined only through a GTIN or order code but whose own title says "different" (Mironet's
    // "2x2.0Ah" kit) must not set the product's headline price.
    const matching = members.filter((m) => m.match.level !== 'different');
    const h = headline(matching.length ? matching : members);
    const noteFacts: ProductGroup['noteFacts'] = {
      noDelivery: members.filter((m) => !reachable(m.totals)).length,
      gtins: gtins.length,
      mixed: new Set(members.map((m) => m.match.level)).size > 1,
      noGtin: members.some((m) => !m.gtin),
    };
    const notes = groupNotes(noteFacts, lang);
    groups.push({
      id: hash(signature + '|' + gtins.join(',') + '|' + [...new Set(members.map((m) => m.match.partCode).filter(Boolean))].sort().join(',')),
      // The product's name without the shop's suffix, promotion or doubled text; the offer rows keep the shop's own title.
      title: displayTitle(named.title, named.shopName),
      level: best.match.level,
      score: best.match.score,
      condition: best.match.condition,
      gtins,
      signature,
      shopCount: new Set(members.map((m) => m.shopId)).size,
      offerCount: members.length,
      ...h,
      notes,
      noteFacts,
      variants: variantList.sort((a, b) => (a.bestItemEur ?? Infinity) - (b.bestItemEur ?? Infinity)),
    });
  }
  return groups.sort((a, b) =>
    LEVEL_RANK[a.level] - LEVEL_RANK[b.level] ||
    (a.condition === 'new' ? 0 : 1) - (b.condition === 'new' ? 0 : 1) ||
    // a product with a price that reaches the user before one that no shop delivers
    (a.bestItemEur === null ? 1 : 0) - (b.bestItemEur === null ? 1 : 0) ||
    b.score - a.score ||
    b.shopCount - a.shopCount ||
    (a.bestItemEur ?? Infinity) - (b.bestItemEur ?? Infinity));
}
