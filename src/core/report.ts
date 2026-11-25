// Small presentation helpers shared by the command line (and mirrored in public/app.js).

import { t, type Lang, type MessageKey } from './i18n.ts';
import type { ShopResult, ShopStatus } from './types.ts';

const PHRASES: [ShopStatus, MessageKey][] = [
  ['ok', 'sumOk'],
  ['no_match', 'sumNoMatch'],
  ['blocked', 'sumBlocked'],
  ['needs_js', 'sumNeedsJs'],
  ['needs_search_key', 'sumNeedsKey'],
  ['robots_disallowed', 'sumRobots'],
  ['no_route', 'sumNoRoute'],
  ['error', 'sumError'],
  ['not_relevant', 'sumNotRelevant'],
];

/** "6 found, 10 no match, 9 blocked, 2 need a browser, ..., 7 not asked (not relevant)" */
export function statusSummary(results: Pick<ShopResult, 'status'>[], lang: Lang = 'en'): string {
  const counts = new Map<ShopStatus, number>();
  for (const r of results) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
  const say = (key: MessageKey, n: number) => (t as (l: Lang, k: MessageKey, p: { n: number }) => string)(lang, key, { n });
  return PHRASES.filter(([s]) => counts.get(s)).map(([s, k]) => say(k, counts.get(s) as number)).join(', ');
}

const UNCHECKED: ShopStatus[] = ['blocked', 'needs_js', 'needs_search_key', 'robots_disallowed', 'no_route', 'error'];

/** Shops that are relevant to the query but could not be checked: the user should open these. */
export function notCheckedList(results: ShopResult[]): { shopName: string; status: ShopStatus; url: string; section: ShopResult['section'] }[] {
  return results
    .filter((r) => UNCHECKED.includes(r.status))
    .map((r) => ({ shopName: r.shopName, status: r.status, url: r.manualUrl ?? `https://${r.domain}/`, section: r.section }))
    .sort((a, b) => (a.section === b.section ? a.shopName.localeCompare(b.shopName) : a.section === 'local' ? -1 : 1));
}
