// Shop model: validation of the parsed data/shops.yaml, search URLs, manual links, locations.

import type { ShopTextFields } from './i18n.ts';
import type { Shop, TriState } from './types.ts';

export interface Location {
  id: string;
  name: string;
  country: string;
  /** Field of the shop record that says whether the shop has a branch in this city. */
  branchField: 'has_kosice_branch';
}

export const LOCATIONS: Location[] = [{ id: 'kosice', name: 'Košice', country: 'SK', branchField: 'has_kosice_branch' }];
export const DEFAULT_LOCATION = LOCATIONS[0];

export function locationById(id: string | undefined | null): Location {
  return LOCATIONS.find((l) => l.id === id) ?? DEFAULT_LOCATION;
}

export function sectionFor(shop: Shop, loc: Location): 'local' | 'online' {
  return shop[loc.branchField] === true ? 'local' : 'online';
}

/** {query}: form encoding (spaces as +); {query_path}: percent encoding for path-style templates. */
export function buildSearchUrl(template: string, query: string): string {
  return template
    .replace('{query_path}', encodeURIComponent(query))
    .replace('{query}', encodeURIComponent(query).replace(/%20/g, '+'));
}

/** Heureka.sk search link for the user to open. The app never fetches Heureka (terms and robots.txt). */
export function heurekaUrl(query: string): string {
  return `https://www.heureka.sk/?h%5Bfraze%5D=${encodeURIComponent(query).replace(/%20/g, '+')}`;
}

const tri = (v: unknown): TriState => (v === true ? true : v === false ? false : 'unknown');

/**
 * Translations of the shown free-text notes of shops.yaml in one language (data/shops.<lang>.yaml):
 * `shops: { <shop id>: { no_route_reason: ..., shipping_to_sk: { method: ... } } }`. Only those
 * fields are taken; a shop id that is not in `shops`, or a field the shop has no English text for,
 * is reported as a problem and left out (it would never be shown).
 */
export function validateShopTexts(doc: unknown, shops: Shop[]): { texts: Record<string, ShopTextFields>; problems: string[] } {
  const problems: string[] = [];
  const texts: Record<string, ShopTextFields> = {};
  const list = (doc as { shops?: unknown })?.shops;
  if (!list || typeof list !== 'object' || Array.isArray(list)) return { texts, problems: ['no "shops" map'] };
  const byId = new Map(shops.map((s) => [s.id, s]));
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  for (const [id, raw] of Object.entries(list as Record<string, unknown>)) {
    const shop = byId.get(id);
    if (!shop) {
      problems.push(`${id}: no shop with this id in shops.yaml`);
      continue;
    }
    const r = (raw ?? {}) as Record<string, unknown>;
    for (const k of Object.keys(r)) if (k !== 'no_route_reason' && k !== 'shipping_to_sk') problems.push(`${id}: field ${k} is not translated (only no_route_reason and shipping_to_sk.method)`);
    const out: ShopTextFields = {};
    const reason = str(r.no_route_reason);
    if (reason && shop.no_route_reason) out.no_route_reason = reason;
    else if (reason) problems.push(`${id}: no_route_reason has no English text in shops.yaml`);
    const method = str((r.shipping_to_sk as Record<string, unknown> | undefined)?.method);
    if (method && shop.shipping_to_sk?.method) out.shipping_to_sk = { method };
    else if (method) problems.push(`${id}: shipping_to_sk.method has no English text in shops.yaml`);
    if (Object.keys(out).length) texts[id] = out;
  }
  return { texts, problems };
}

export function validateShops(doc: unknown): { shops: Shop[]; problems: string[] } {
  const problems: string[] = [];
  const list = (doc as { shops?: unknown })?.shops;
  if (!Array.isArray(list)) return { shops: [], problems: ['shops.yaml has no "shops" list'] };
  const shops: Shop[] = [];
  const ids = new Set<string>();
  for (const [i, raw] of list.entries()) {
    const r = raw as Record<string, unknown>;
    const where = `shops[${i}]${typeof r?.id === 'string' ? ` (${r.id})` : ''}`;
    if (!r || typeof r.id !== 'string' || typeof r.domain !== 'string' || typeof r.name !== 'string') {
      problems.push(`${where}: id, name and domain are required`);
      continue;
    }
    if (ids.has(r.id)) problems.push(`${where}: duplicate id`);
    ids.add(r.id);
    const tpl = typeof r.search_url_template === 'string' ? r.search_url_template : null;
    if (tpl && !/\{query(_path)?\}/.test(tpl)) problems.push(`${where}: search_url_template has no {query} placeholder`);
    const ship = r.shipping_to_sk as Record<string, unknown> | null | undefined;
    const pick = r.pickup_kosice as Record<string, unknown> | null | undefined;
    const str = (v: unknown) => (typeof v === 'string' ? v : v instanceof Date ? v.toISOString().slice(0, 10) : undefined);
    shops.push({
      id: r.id,
      name: r.name,
      country: String(r.country ?? 'SK').toUpperCase(),
      domain: r.domain.toLowerCase(),
      kind: r.kind === 'local_chain' ? 'local_chain' : 'webshop',
      categories: Array.isArray(r.categories) ? r.categories.map(String) : [],
      currency: String(r.currency ?? 'EUR').toUpperCase(),
      has_kosice_branch: tri(r.has_kosice_branch),
      has_kosice_branch_source: typeof r.has_kosice_branch_source === 'string' ? r.has_kosice_branch_source : undefined,
      ships_to_sk: tri(r.ships_to_sk),
      search_url_template: tpl,
      search_template_basis: typeof r.search_template_basis === 'string' ? r.search_template_basis : undefined,
      accept_language: typeof r.accept_language === 'string' ? r.accept_language : undefined,
      link_exclude_regex: typeof r.link_exclude_regex === 'string' ? r.link_exclude_regex : undefined,
      in_scope: r.in_scope !== false,
      needs_js: r.needs_js === true,
      structured_data: r.structured_data === false ? false : r.structured_data === true ? true : undefined,
      shipping_to_sk: ship && typeof ship === 'object'
        ? {
          price: typeof ship.price === 'number' ? ship.price : null,
          currency: typeof ship.currency === 'string' ? ship.currency : 'EUR',
          free_from: typeof ship.free_from === 'number' ? ship.free_from : null,
          method: str(ship.method),
          source: str(ship.source),
          checked: str(ship.checked),
        }
        : null,
      ships_to_sk_source: str(r.ships_to_sk_source),
      pickup_kosice: pick && typeof pick === 'object'
        ? {
          available: tri(pick.available),
          price: typeof pick.price === 'number' ? pick.price : null,
          currency: typeof pick.currency === 'string' ? pick.currency : 'EUR',
          note: str(pick.note),
          source: str(pick.source),
          checked: str(pick.checked),
        }
        : null,
      no_route_reason: str(r.no_route_reason),
      unreachable: r.unreachable === true,
      branches: Array.isArray(r.branches) ? (r.branches as Shop['branches']) : [],
      notes: typeof r.notes === 'string' ? r.notes : undefined,
    });
  }
  return { shops, problems };
}
