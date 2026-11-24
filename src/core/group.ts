// Groups offers into distinct products ("Which one do you mean?").
// Offers are linked when they share a normalised GTIN or the same model signature (which already
// includes condition, so used/refurbished offers never join new ones). Inside a product, offers are
// split into variants by GTIN or colour so colour variants appear side by side.

import { displayGtin } from './gtin.ts';
import { headline, reachable, sortOffers } from './totals.ts';
import type { MatchLevel, Offer, ProductGroup, ProductVariant } from './types.ts';

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

export function groupOffers(offers: Offer[]): ProductGroup[] {
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
    for (const c of o.match.codes ?? []) {
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
  for (const members of comps.values()) {
    const best = [...members].sort((a, b) => LEVEL_RANK[a.match.level] - LEVEL_RANK[b.match.level] || b.match.score - a.match.score || a.title.length - b.title.length)[0];
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
        label: [v.colour ?? 'colour not stated', words.length ? words.join(' ') : null, v.gtin ? `GTIN ${displayGtin(v.gtin)}` : null].filter(Boolean).join(', '),
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
    const notes: string[] = [];
    const noDelivery = members.filter((m) => !reachable(m.totals)).length;
    if (noDelivery) notes.push(`${noDelivery} offer${noDelivery > 1 ? 's' : ''} from shops that do not deliver to Slovakia (not ranked)`);
    if (gtins.length) notes.push(`${gtins.length} GTIN${gtins.length > 1 ? 's' : ''}`);
    const mixed = new Set(members.map((m) => m.match.level));
    if (mixed.size > 1) notes.push('some offers only possibly match: check them');
    if (members.some((m) => !m.gtin)) notes.push(gtins.length ? 'some offers grouped by name only (no GTIN)' : 'grouped by name only (no GTIN)');
    groups.push({
      id: hash(signature + '|' + gtins.join(',')),
      title: best.title,
      level: best.match.level,
      score: best.match.score,
      condition: best.match.condition,
      gtins,
      signature,
      shopCount: new Set(members.map((m) => m.shopId)).size,
      offerCount: members.length,
      ...h,
      notes,
      variants: variantList.sort((a, b) => (a.bestItemEur ?? Infinity) - (b.bestItemEur ?? Infinity)),
    });
  }
  return groups.sort((a, b) =>
    LEVEL_RANK[a.level] - LEVEL_RANK[b.level] ||
    (a.condition === 'new' ? 0 : 1) - (b.condition === 'new' ? 0 : 1) ||
    b.score - a.score ||
    b.shopCount - a.shopCount ||
    (a.bestItemEur ?? Infinity) - (b.bestItemEur ?? Infinity));
}
