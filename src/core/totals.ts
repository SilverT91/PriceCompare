// Item price + delivery to Slovakia (or pickup in the local branch), converted to EUR.
// Unknown shipping stays unknown: it is never counted as zero. A shop that does not deliver to
// Slovakia keeps its offers visible but outside the ranking.

import { eur as eurText, t, type Lang } from './i18n.ts';
import type { Offer, RawOffer, Shop, Totals } from './types.ts';

/** ECB reference rates: 1 EUR = rates[CUR] units of CUR. */
export interface Rates {
  base: 'EUR';
  date: string;
  rates: Record<string, number>;
  source: string;
}

export function toEur(amount: number, currency: string, rates: Rates | null): { eur: number | null; rate: number | null } {
  const cur = currency.toUpperCase();
  if (cur === 'EUR') return { eur: round2(amount), rate: 1 };
  const r = rates?.rates[cur];
  if (!r) return { eur: null, rate: null };
  return { eur: round2(amount / r), rate: r };
}

export const round2 = (n: number): number => Math.round(n * 100) / 100;

type ShopFacts = Pick<Shop, 'name'> & Partial<Pick<Shop, 'shipping_to_sk' | 'ships_to_sk' | 'pickup_kosice'>>;

/** opts.lang: the language of the notes (default English); the numbers do not depend on it. */
export function computeTotals(offer: RawOffer, shop: ShopFacts, rates: Rates | null, country = 'SK', opts: { local?: boolean; lang?: Lang } = {}): Totals {
  const lang = opts.lang ?? 'en';
  const item = toEur(offer.price, offer.currency, rates);
  const deliversToSk = shop.ships_to_sk ?? 'unknown';
  let shippingEur: number | null = null;
  let source: Totals['shippingSource'] = 'unknown';
  let note = '';

  if (deliversToSk === false) {
    source = 'no_delivery';
    note = t(lang, 'noDelivery');
  } else {
    const forCountry = offer.shipping.filter((s) => s.countries.includes(country) && s.rate !== null);
    if (forCountry.length) {
      let best: number | null = null;
      for (const s of forCountry) {
        let rate = s.rate as number;
        if (s.freeFrom !== null && offer.price >= s.freeFrom) rate = 0;
        const eur = toEur(rate, s.currency ?? offer.currency, rates).eur;
        if (eur !== null && (best === null || eur < best)) best = eur;
      }
      if (best !== null) {
        shippingEur = best;
        source = 'jsonld';
        note = forCountry.length > 1 ? t(lang, 'cheapestOf', { n: forCountry.length, country }) : t(lang, 'productDataDelivery', { country });
      }
    }
    if (source === 'unknown') {
      const other = [...new Set(offer.shipping.flatMap((s) => s.countries))].filter((c) => c !== country);
      const sh = shop.shipping_to_sk;
      const freeByThreshold = sh && sh.free_from !== null && sh.free_from !== undefined && item.eur !== null
        && toEur(sh.free_from, sh.currency || 'EUR', rates).eur !== null
        && (item.eur as number) >= (toEur(sh.free_from, sh.currency || 'EUR', rates).eur as number);
      if (sh && freeByThreshold) {
        shippingEur = 0;
        source = 'shop_data';
        note = t(lang, 'freeFrom', { amount: sh.free_from as number, currency: sh.currency || 'EUR', checked: sh.checked });
      } else if (sh && sh.price !== null && sh.price !== undefined) {
        shippingEur = toEur(sh.price, sh.currency || 'EUR', rates).eur;
        source = shippingEur === null ? 'unknown' : 'shop_data';
        note = t(lang, 'shopMethod', { method: sh.method, checked: sh.checked });
      } else if (sh && sh.free_from !== null && sh.free_from !== undefined) {
        note = t(lang, 'freeOnlyFrom', { amount: sh.free_from, currency: sh.currency || 'EUR' });
      } else if (other.length) {
        note = t(lang, 'shippingOnlyFor', { other: other.join(', '), country });
      } else {
        note = t(lang, 'shippingUnknown');
      }
    }
  }

  let pickupEur: number | null = null;
  let pickupNote = '';
  if (opts.local) {
    const p = shop.pickup_kosice;
    if (p && p.available === true && p.price !== null && p.price !== undefined) {
      pickupEur = toEur(p.price, p.currency || 'EUR', rates).eur;
      pickupNote = pickupEur === 0 ? t(lang, 'pickupFree') : t(lang, 'pickupPrice', { amount: p.price, currency: p.currency || 'EUR' });
    } else if (p && p.available === false) {
      pickupNote = t(lang, 'noPickup');
    } else {
      pickupNote = t(lang, 'pickupUnknown');
    }
  }

  const totalEur = item.eur !== null && shippingEur !== null ? round2(item.eur + shippingEur) : null;
  const pickupTotalEur = item.eur !== null && pickupEur !== null ? round2(item.eur + pickupEur) : null;
  let bestTotalEur: number | null = null;
  let bestTotalKind: Totals['bestTotalKind'] = null;
  if (pickupTotalEur !== null && (totalEur === null || pickupTotalEur <= totalEur)) {
    bestTotalEur = pickupTotalEur;
    bestTotalKind = 'pickup';
  } else if (totalEur !== null) {
    bestTotalEur = totalEur;
    bestTotalKind = 'delivery';
  }
  return {
    itemEur: item.eur, rate: item.rate, rateDate: offer.currency.toUpperCase() === 'EUR' ? null : rates?.date ?? null,
    shippingEur, shippingSource: source, shippingNote: note, totalEur,
    pickupEur, pickupTotalEur, pickupNote, deliversToSk, bestTotalEur, bestTotalKind,
  };
}

/** Can this offer reach the user at all (delivery not refused, or pickup known)? */
export const reachable = (t: Pick<Totals, 'deliversToSk' | 'pickupTotalEur'>): boolean => t.deliversToSk !== false || t.pickupTotalEur !== null;

/**
 * Ranking: offers that reach the user first; among them known totals (pickup or delivery,
 * ascending), then unknown totals by item price; offers from shops that do not deliver to
 * Slovakia last. Ties: in stock first.
 */
export function sortOffers<T extends Pick<Offer, 'totals' | 'availability'>>(offers: T[]): T[] {
  const inStock = (o: T) => (o.availability && /InStock|InStoreOnly|OnlineOnly|LimitedAvailability/i.test(o.availability) ? 0 : 1);
  const tier = (o: T) => (!reachable(o.totals) ? 2 : o.totals.bestTotalEur !== null ? 0 : 1);
  return [...offers].sort((a, b) => {
    const d = tier(a) - tier(b);
    if (d) return d;
    const av = a.totals.bestTotalEur ?? a.totals.itemEur ?? Infinity;
    const bv = b.totals.bestTotalEur ?? b.totals.itemEur ?? Infinity;
    if (av !== bv) return av - bv;
    return inStock(a) - inStock(b);
  });
}

export interface Headline {
  bestItemEur: number | null;
  bestItemShop: string | null;
  bestItemTotalKnown: boolean;
  bestTotalEur: number | null;
  bestTotalShop: string | null;
  bestTotalKind: 'pickup' | 'delivery' | null;
}

/** Headline prices of a product or variant: cheapest item price and cheapest known total, separately. */
export function headline(offers: Pick<Offer, 'totals' | 'shopName'>[]): Headline {
  const ok = offers.filter((o) => reachable(o.totals) && o.totals.itemEur !== null);
  let item: (typeof ok)[number] | undefined;
  for (const o of ok) {
    if (!item || (o.totals.itemEur as number) < (item.totals.itemEur as number)
      || ((o.totals.itemEur as number) === (item.totals.itemEur as number) && o.totals.bestTotalEur !== null && item.totals.bestTotalEur === null)) item = o;
  }
  let total: (typeof ok)[number] | undefined;
  for (const o of ok) if (o.totals.bestTotalEur !== null && (!total || o.totals.bestTotalEur < (total.totals.bestTotalEur as number))) total = o;
  return {
    bestItemEur: item?.totals.itemEur ?? null,
    bestItemShop: item?.shopName ?? null,
    bestItemTotalKnown: item ? item.totals.bestTotalEur !== null : false,
    bestTotalEur: total?.totals.bestTotalEur ?? null,
    bestTotalShop: total?.shopName ?? null,
    bestTotalKind: total?.totals.bestTotalKind ?? null,
  };
}

/** "from 797.85 € + shipping? · cheapest known total 849.00 € (NAY, pickup)" */
export function headlineText(h: Headline, lang: Lang = 'en'): string {
  const eur = (n: number) => eurText(lang, n);
  if (h.bestItemEur === null) return t(lang, 'noPriceReachesSk');
  const parts = [t(lang, 'fromPrice', { price: eur(h.bestItemEur), shippingUnknown: !h.bestItemTotalKnown })];
  if (h.bestTotalEur !== null && !(h.bestItemTotalKnown && h.bestTotalEur === h.bestItemEur)) {
    parts.push(t(lang, 'cheapestKnownTotal', { price: eur(h.bestTotalEur), shop: h.bestTotalShop, pickup: h.bestTotalKind === 'pickup' }));
  } else if (h.bestTotalEur === null) {
    parts.push(t(lang, 'noKnownTotal'));
  }
  return parts.join(' · ');
}
