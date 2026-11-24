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
  /** false = product pages carry no schema.org data (Amazon): never fetched, manual link only. */
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
  reasons: string[];
}

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
  route: 'shop_search' | 'search_provider' | 'none';
  manualUrl: string | null;
  offers: Offer[];
  candidates: Candidate[];
  requestsUsed: number;
  fromCache: boolean;
  ms: number;
}

export interface ProductVariant {
  key: string;
  label: string;
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
  notes: string[];
  variants: ProductVariant[];
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
} as const;
