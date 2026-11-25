// Shared data types of the core. This folder (src/core) uses only standard web APIs (fetch, URL,
// AbortSignal, TextDecoder) and pure-JS libraries, so it can run on Node and on Cloudflare Workers.

export type TriState = true | false | 'unknown';

/** A physical branch. Not filled in version 1; kept so per-branch data can be added later. */
export interface Branch {
  city: string;
  address?: string;
  source?: string;
}

/** Shipping to Slovakia as curated in data/shops.yaml (`shipping_to_sk`). */
export interface ShopShipping {
  /** null = unknown (with free_from set: free from that value, unknown below it). */
  price: number | null;
  currency: string;
  free_from: number | null;
  method?: string;
  source?: string;
  checked?: string;
}

/** Collecting an online order in the shop's branch in the user's city (`pickup_kosice`). */
export interface ShopPickup {
  available: TriState;
  price: number | null;
  currency: string;
  note?: string;
  source?: string;
  checked?: string;
}

export interface Shop {
  id: string;
  name: string;
  country: string;
  domain: string;
  kind: 'local_chain' | 'webshop';
  categories: string[];
  currency: string;
  has_kosice_branch: TriState;
  has_kosice_branch_source?: string;
  ships_to_sk: TriState;
  search_url_template: string | null;
  search_template_basis?: string;
  accept_language?: string;
  link_exclude_regex?: string;
  in_scope: boolean;
  /** Prices only appear after JavaScript runs: never fetched, manual link only. */
  needs_js?: boolean;
  /**
   * false = product pages carry no schema.org data (Amazon): never fetched, manual link only.
   * true = they do, so fetched pages without it were not product pages (no_match, not needs_js).
   */
  structured_data?: boolean;
  shipping_to_sk?: ShopShipping | null;
  ships_to_sk_source?: string;
  pickup_kosice?: ShopPickup | null;
  /** Why the shop has no search URL; shown with status no_route. */
  no_route_reason?: string;
  /** The site answers a plain client with errors on every page: not asked at all. */
  unreachable?: boolean;
  branches?: Branch[];
  notes?: string;
}

export type ShopStatus =
  | 'ok'
  | 'no_match'
  | 'blocked'
  | 'robots_disallowed'
  | 'needs_js'
  | 'needs_search_key'
  | 'no_route'
  | 'error'
  /** Left out because its categories do not fit the query; no request, not a failure. */
  | 'not_relevant';

export type Condition = 'new' | 'used' | 'refurbished' | 'damaged' | 'unknown_used';

export interface ShippingOption {
  /** ISO country codes the rate applies to; empty = not stated. */
  countries: string[];
  rate: number | null;
  currency: string | null;
  freeFrom: number | null;
}

/** One priced offer as extracted from a product page (before matching and totals). */
export interface RawOffer {
  shopId: string;
  url: string;
  title: string;
  brand: string | null;
  gtin: string | null;
  sku: string | null;
  mpn: string | null;
  color: string | null;
  price: number;
  currency: string;
  availability: string | null;
  itemCondition: string | null;
  seller: string | null;
  shipping: ShippingOption[];
  /** 'Product' | 'ProductGroup variant' | 'AggregateOffer (lowest)' ... */
  source: string;
}

export type MatchLevel = 'exact' | 'possible' | 'different';

export interface MatchResult {
  level: MatchLevel;
  /** 0..1, higher = closer to the query. */
  score: number;
  /** Query tokens found in the title, the brand, the spec segments, or in a near spelling. */
  matched: string[];
  missing: string[];
  distinguishing: string[];
  specExtras: string[];
  unknownExtras: string[];
  condition: Condition;
  conditionWords: string[];
  colour: string | null;
  signature: string;
  /** Manufacturer order codes found in the title (e.g. "060186810f"); they link offers like a GTIN. */
  codes: string[];
  /** Why the level is not "exact", in English (reasonText('en', ...) of reasonCodes, same order). */
  reasons: string[];
  /** The same reasons as codes with their words, so they can be written in another language (i18n.ts, reasonText). */
  reasonCodes: MatchReason[];
}

/** One reason of a match level, as data. The words are query or title tokens, never translated. */
export type MatchReason =
  /** A short query number found only as the start of a configuration code ("16" in "16arp10"). */
  | { code: 'codeStart'; params: { token: string; title: string } }
  /** A query word met by a title word one letter away. */
  | { code: 'nearSpelling'; params: { token: string; title: string } }
  /** The offer is not new; `words` are the title words that said so. */
  | { code: 'condition'; params: { condition: Condition; words: string[] } }
  /** An unknown title word stands where the query has a word ("anywhere" for "master"). */
  | { code: 'insteadOf'; params: { instead: string; token: string } }
  | { code: 'titleLacks'; params: { words: string[] } }
  | { code: 'titleHas'; params: { words: string[] } }
  /** The title names the line and number without the query's middle number ("pro 3000" without "3"). */
  | { code: 'sameOrOlder'; params: { before: string; after: string; token: string } }
  /** Specification variants (memory, capacity, size) the query does not name. */
  | { code: 'variantNotInQuery'; params: { words: string[] } }
  | { code: 'extraWords'; params: { words: string[] } };

export type MatchReasonCode = MatchReason['code'];

export interface Totals {
  itemEur: number | null;
  shippingEur: number | null;
  shippingSource: 'jsonld' | 'shop_data' | 'unknown' | 'no_delivery';
  shippingNote: string;
  /** Item + delivery to SK; null when delivery is unknown or not offered. */
  totalEur: number | null;
  /** Collecting in the local branch (only for shops with a branch in the user's city). */
  pickupEur: number | null;
  pickupTotalEur: number | null;
  pickupNote: string;
  /** false = the shop does not deliver to Slovakia: shown, but outside the ranking. */
  deliversToSk: TriState;
  /** The lowest known way to get it: min(pickup total, delivery total), or null. */
  bestTotalEur: number | null;
  bestTotalKind: 'pickup' | 'delivery' | null;
  rate: number | null;
  rateDate: string | null;
}

export interface Offer extends RawOffer {
  shopName: string;
  section: 'local' | 'online';
  shipsToSk: TriState;
  branchKnown: TriState;
  match: MatchResult;
  totals: Totals;
}

export interface Candidate {
  url: string;
  title: string;
  from: 'itemlist' | 'html_link' | 'search_provider';
  score?: number;
  level?: MatchLevel;
}

export interface ShopResult {
  shopId: string;
  shopName: string;
  domain: string;
  section: 'local' | 'online';
  status: ShopStatus;
  detail: string;
  /** 'both': the shop's own search found nothing matching, then the web search was tried too. */
  route: 'shop_search' | 'search_provider' | 'both' | 'none';
  manualUrl: string | null;
  offers: Offer[];
  candidates: Candidate[];
  requestsUsed: number;
  fromCache: boolean;
  ms: number;
}

export interface ProductVariant {
  key: string;
  /** Colour (or "colour not stated"), the extra title words and the GTIN, in the search's language. */
  label: string;
  /** The title words that tell this variant apart (matcher's unknown extras), at most 3; part of the label. */
  words: string[];
  gtin: string | null;
  colour: string | null;
  offers: Offer[];
  bestItemEur: number | null;
  bestItemTotalKnown: boolean;
  bestTotalEur: number | null;
}

export interface ProductGroup {
  id: string;
  title: string;
  level: MatchLevel;
  score: number;
  condition: Condition;
  gtins: string[];
  signature: string;
  shopCount: number;
  offerCount: number;
  /** Cheapest known total (pickup or delivery) among offers that can reach the user. */
  bestTotalEur: number | null;
  bestTotalShop: string | null;
  bestTotalKind: 'pickup' | 'delivery' | null;
  /** Cheapest item price among offers that can reach the user, whatever their shipping. */
  bestItemEur: number | null;
  bestItemShop: string | null;
  /** Whether that cheapest item's total is known (false = "+ shipping?"). */
  bestItemTotalKnown: boolean;
  /** Notes in the search's language, built from noteFacts (group.ts, groupNotes). */
  notes: string[];
  /** What the notes state, so a page can write them in another language. */
  noteFacts: { noDelivery: number; gtins: number; mixed: boolean; noGtin: boolean };
  variants: ProductVariant[];
}

/** One shop that lists a nearby model: the page and the title as the shop wrote it. */
export interface NearbyShop {
  shopId: string;
  shopName: string;
  section: 'local' | 'online';
  url: string;
  title: string;
}

/**
 * A model next to the one the user typed (same brand and line, another number, tier or package),
 * found among the candidates and offers the matcher rated "different". Built by nearbyModels().
 */
export interface NearbyModel {
  /** The model name, usable as a new search query; also the display name. */
  query: string;
  /** One entry per shop that lists it. */
  shops: NearbyShop[];
  /** How it differs from the query, e.g. `has "3500", lacks "3000"`. */
  differs: string;
  /** Query tokens its title lacks and tokens it has that the query lacks (from the closest listing). */
  missing: string[];
  distinguishing: string[];
  /** Steps from the query (nearbyDistance(): a number swapped 1, a tier or package word 2, else 1); smaller = closer. */
  distance: number;
  /** An item price (EUR) read on one of its pages, or null. A hint, not a comparison: it may not be the same product. */
  seenPrice: SeenPrice | null;
}

export interface SeenPrice {
  eur: number;
  shopName: string;
  /** The page the price was read from. */
  url: string;
  /**
   * 'search': the lowest price on a page the search read anyway (it turned out to be this model);
   * 'list': one page read after the search only to give this model of the list a price.
   */
  from: 'search' | 'list';
}

export interface NearbyList {
  /** At most NEARBY_LIMIT models, closest first. */
  models: NearbyModel[];
  /** How many nearby models there were before the cut. */
  total: number;
}

/** Small key-value cache with TTL; the Node side implements it on SQLite. */
export interface Cache {
  get<T>(namespace: string, key: string): Promise<T | undefined>;
  set<T>(namespace: string, key: string, value: T, ttlSeconds: number): Promise<void>;
}

export const CACHE_TTL = {
  offers: 6 * 3600,
  candidates: 6 * 3600,
  providerResults: 6 * 3600,
  robots: 24 * 3600,
  rates: 24 * 3600,
  blocked: 3600,
  /** "This shop's product pages carry schema.org Product data", remembered from a page that had it. */
  structuredData: 30 * 86400,
} as const;
