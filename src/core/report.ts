// Small presentation helpers shared by the command line (and mirrored in public/app.js).

import type { ShopResult, ShopStatus } from './types.ts';

const PHRASES: [ShopStatus, (n: number) => string][] = [
  ['ok', (n) => `${n} found`],
  ['no_match', (n) => `${n} no match`],
  ['blocked', (n) => `${n} blocked`],
  ['needs_js', (n) => `${n} need${n === 1 ? 's' : ''} a browser`],
  ['needs_search_key', (n) => `${n} need${n === 1 ? 's' : ''} a search key`],
  ['robots_disallowed', (n) => `${n} disallowed by robots.txt`],
  ['no_route', (n) => `${n} no automatic route`],
  ['error', (n) => `${n} error${n === 1 ? '' : 's'}`],
  ['not_relevant', (n) => `${n} not asked (not relevant)`],
];

/** "6 found, 10 no match, 9 blocked, 2 need a browser, ..., 7 not asked (not relevant)" */
export function statusSummary(results: Pick<ShopResult, 'status'>[]): string {
  const counts = new Map<ShopStatus, number>();
  for (const r of results) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
  return PHRASES.filter(([s]) => counts.get(s)).map(([s, f]) => f(counts.get(s) as number)).join(', ');
}

const UNCHECKED: ShopStatus[] = ['blocked', 'needs_js', 'needs_search_key', 'robots_disallowed', 'no_route', 'error'];

/** Shops that are relevant to the query but could not be checked: the user should open these. */
export function notCheckedList(results: ShopResult[]): { shopName: string; status: ShopStatus; url: string; section: ShopResult['section'] }[] {
  return results
    .filter((r) => UNCHECKED.includes(r.status))
    .map((r) => ({ shopName: r.shopName, status: r.status, url: r.manualUrl ?? `https://${r.domain}/`, section: r.section }))
    .sort((a, b) => (a.section === b.section ? a.shopName.localeCompare(b.shopName) : a.section === 'local' ? -1 : 1));
}
