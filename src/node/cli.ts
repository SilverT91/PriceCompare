// Command line search: the distinct products found, the comparison for the chosen one, the shops to
// open by hand, and the per-shop statuses.
//
//   npm run search -- "Oral-B Pro 3 3000"
//   npm run search -- "iPhone 16 128GB" --pick 2
//   options: --cat auto|all|electronics|tools|health|home|books   (default auto: guessed from the query)
//            --location kosice  --shops nay_sk,hornbach_sk  --providers brave,serper | serper,brave | none
//            --site-search combined|per-shop  --domains-per-query 6  --no-cache  --json
//            --as-typed   (no brand correction: "Iral b ..." is searched as typed, not as "Oral-B ...";
//                          no effect on a pasted product link, whose name is always taken from the link)
//   A product link instead of a name works too: npm run search -- "https://www.alza.sk/roborock-qrevo-edge-2-pro-d13260955.htm"

import { parseArgs } from 'node:util';
import { CATEGORY_GROUPS } from '../core/categories.ts';
import { displayGtin } from '../core/gtin.ts';
import { runSearch, type SearchEvent } from '../core/pipeline.ts';
import { notCheckedList, statusSummary } from '../core/report.ts';
import { locationById } from '../core/shops.ts';
import { headlineText, reachable, sortOffers } from '../core/totals.ts';
import type { NearbyList, Offer, ProductGroup, ShopResult, ShopStatus } from '../core/types.ts';
import { loadEnv, loadShops, makeScheduler, openStore, providersFromEnv } from './setup.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    cat: { type: 'string', default: 'auto' },
    location: { type: 'string', default: 'kosice' },
    pick: { type: 'string' },
    shops: { type: 'string' },
    providers: { type: 'string' },
    'site-search': { type: 'string', default: 'combined' },
    'domains-per-query': { type: 'string', default: '6' },
    'no-cache': { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
    'as-typed': { type: 'boolean', default: false },
    width: { type: 'string', default: '160' },
  },
});

const query = positionals.join(' ').trim();
if (!query) {
  console.error(`usage: npm run search -- "product name" [--cat auto|all|${CATEGORY_GROUPS.map((g) => g.id).join('|')}] [--pick N] [--shops id,id] [--providers brave,serper|none] [--as-typed]`);
  process.exit(2);
}

loadEnv();
const store = openStore({ noCache: values['no-cache'] });
let shops = loadShops();
if (values.shops) {
  const ids = new Set(values.shops.split(','));
  shops = shops.filter((s) => ids.has(s.id));
}
const providers = providersFromEnv(values.providers);
const location = locationById(values.location);
const W = Number(values.width) || 160;

const cut = (s: string, n: number) => (s.length > n ? s.slice(0, Math.max(0, n - 1)) + '…' : s);
function table(headers: string[], rows: string[][], max: number[]): string {
  const widths = headers.map((h, i) => Math.min(max[i] ?? 40, Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length))));
  const line = (cells: string[]) => cells.map((c, i) => cut(c ?? '', widths[i]).padEnd(widths[i])).join('  ').trimEnd();
  return [line(headers), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.map(line)].join('\n');
}
const eur = (n: number | null) => (n === null ? '?' : `${n.toFixed(2)} €`);

const shopResults: ShopResult[] = [];
let groups: ProductGroup[] = [];
let nearby: NearbyList = { models: [], total: 0 };
let heureka = '';
let summary: Extract<SearchEvent, { type: 'done' }>['summary'] | null = null;
const startedAt = new Date().toISOString();

for await (const ev of runSearch(query, {
  shops, cache: store, scheduler: makeScheduler(store), location, providers, category: values.cat,
  siteSearchMode: values['site-search'] === 'per-shop' ? 'per_shop' : 'combined',
  domainsPerQuery: Number(values['domains-per-query']) || 6,
  onProviderCall: (c) => store.recordProviderCall(c),
  asTyped: values['as-typed'],
})) {
  if (ev.type === 'start') {
    heureka = ev.heurekaUrl;
    const asked = ev.shops.length;
    if (ev.fromLink) {
      console.log(`Searched for "${ev.query}" (from the link you pasted)${ev.linkShop ? `; the link is to ${ev.linkShop}, which is asked like every other shop` : ''}`);
    } else if (ev.corrected) {
      console.log(`Searched for "${ev.query}" (you typed "${ev.typed}"); to search exactly as typed: npm run search -- "${ev.typed}" --as-typed`);
    }
    console.log(`Searching for "${ev.query}" near ${location.name}; categories: ${ev.categories.label} (${ev.categories.reasons.join('; ')})`);
    console.log(`  web search: ${providers.length ? providers.map((p) => p.id).join(' > ') : 'none (no key set)'}; ${asked} shops in scope${ev.categories.categories ? '; widen with --cat all' : ''}`);
  }
  if (ev.type === 'rejected') {
    // A pasted link without the product's name: nothing was searched.
    console.error(ev.message);
    store.close();
    process.exit(2);
  }
  if (ev.type === 'rates' && ev.error) console.log(`  exchange rates unavailable: ${ev.error}`);
  if (ev.type === 'shop') {
    shopResults.push(ev.result);
    if (!values.json && ev.result.status !== 'not_relevant') console.log(`  ${ev.result.shopName}: ${ev.result.status} (${ev.result.requestsUsed} req, ${(ev.result.ms / 1000).toFixed(1)} s)`);
  }
  if (ev.type === 'products') {
    groups = ev.groups;
    nearby = ev.nearby;
  }
  if (ev.type === 'done') summary = ev.summary;
}
if (summary) {
  store.recordSearch({ query: summary.query, location: location.id, startedAt, ms: summary.ms, statusCounts: summary.statusCounts, offers: summary.offers, groups: summary.groups });
}

if (values.json) {
  console.log(JSON.stringify({ query, summary, shops: shopResults, groups, nearby }, null, 1));
  store.close();
  process.exit(0);
}

// ---- products -------------------------------------------------------------------------------
const levelLabel = { exact: 'match', possible: 'possible, check', different: 'other product' } as const;
console.log('\n== Which one do you mean? (distinct products found) ==');
if (!groups.length) console.log('  no priced products found');
else {
  console.log(table(
    ['#', 'fit', 'condition', 'shops', 'offers', 'price', 'product', 'why'],
    groups.slice(0, 25).map((g, i) => {
      const best = g.variants.flatMap((v) => v.offers).sort((a, b) => b.match.score - a.match.score)[0];
      return [String(i + 1), levelLabel[g.level], g.condition, String(g.shopCount), String(g.offerCount), headlineText(g), g.title, best?.match.reasons.join('; ') ?? ''];
    }),
    [3, 15, 12, 5, 6, 70, 55, 50],
  ));
  if (groups.length > 25) console.log(`  ... ${groups.length - 25} more`);
}

// ---- similar models the shops list --------------------------------------------------------------
if (nearby.models.length) {
  const noMatch = !groups.some((g) => g.level !== 'different');
  const noExact = !groups.some((g) => g.level === 'exact');
  console.log(`\n== Similar models the shops list (${nearby.models.length}${nearby.total > nearby.models.length ? ` of ${nearby.total}` : ''}) ==`);
  if (noMatch) console.log('  No shop lists exactly what you typed.');
  else if (noExact) console.log('  No shop lists exactly what you typed; the products above are possible matches.');
  console.log('  Listed by the shops. A price is read from one shop page and may not be the same product: check it. Search for a model to compare it.');
  nearby.models.forEach((m, i) => {
    console.log(`  ${String(i + 1).padStart(2)}. ${m.query}   (${m.differs})`);
    console.log(`      listed by ${m.shops.map((s) => s.shopName + (s.section === 'local' ? ` (${location.name} branch)` : '')).join(', ')}`);
    if (m.seenPrice) console.log(`      ⚠ ${eur(m.seenPrice.eur)} at ${m.seenPrice.shopName} (check it): ${m.seenPrice.url}`);
  });
  console.log(`  e.g. npm run search -- "${nearby.models[0].query}"`);
}

let chosen: ProductGroup | undefined;
if (values.pick) chosen = groups[Number(values.pick) - 1];
else chosen = groups.find((g) => g.level !== 'different');
if (!chosen) {
  console.log(`\nNo product matches the query well enough to compare; pick one with --pick N${nearby.models.length ? ', or search for one of the similar models above' : ''}.`);
} else {
  const idx = groups.indexOf(chosen) + 1;
  console.log(`\n== Comparison for #${idx}: ${chosen.title} (${levelLabel[chosen.level]}${chosen.condition !== 'new' ? `, ${chosen.condition}` : ''}) ==`);
  console.log(headlineText(chosen));
  if (chosen.gtins.length) console.log(`GTIN: ${chosen.gtins.map(displayGtin).join(', ')}   ${chosen.notes.join('; ')}`);
  else console.log(chosen.notes.join('; '));
  console.log(`Variants: ${chosen.variants.map((v) => `${v.label.replace(/,? ?GTIN \d+$/, '')} ${v.bestItemEur === null ? '(no SK delivery)' : `${eur(v.bestItemEur)}${v.bestItemTotalKnown ? '' : '+ship?'}`}`).join(' | ')}`);
  const offers: (Offer & { variant: string })[] = chosen.variants.flatMap((v) => v.offers.map((o) => ({ ...o, variant: v.label.replace(/,? ?GTIN \d+$/, '') || '-' })));
  for (const section of ['local', 'online'] as const) {
    const list = sortOffers(offers.filter((o) => o.section === section));
    console.log(`\n-- ${section === 'local' ? `Shops with a branch in ${location.name}` : 'Web shops'} (${list.length}) --`);
    if (!list.length) {
      console.log('  none');
      continue;
    }
    const local = section === 'local';
    console.log(table(
      ['shop', 'colour', 'item', 'original', local ? 'pickup' : 'delivery to SK', local ? 'pickup total' : 'total', ...(local ? ['delivery total'] : []), 'stock', 'match', 'url'],
      list.map((o) => {
        const t = o.totals;
        const deliveryCell = t.deliversToSk === false ? 'does not deliver to SK' : t.shippingEur === null ? `? (${t.shippingNote})` : `${eur(t.shippingEur)} (${t.shippingNote})`;
        return [
          o.shopName + (o.seller && !o.shopName.toLowerCase().includes(o.seller.toLowerCase().split(/[ .]/)[0]) ? ` (seller ${o.seller})` : ''),
          o.variant,
          eur(t.itemEur),
          o.currency === 'EUR' ? '' : `${o.price} ${o.currency}`,
          local ? (t.pickupEur === null ? `? (${t.pickupNote})` : t.pickupEur === 0 ? 'free' : eur(t.pickupEur)) : deliveryCell,
          local ? (t.pickupTotalEur === null ? 'unknown' : eur(t.pickupTotalEur)) : !reachable(t) ? 'not ranked' : t.totalEur === null ? 'unknown' : eur(t.totalEur),
          ...(local ? [t.totalEur === null ? 'unknown' : eur(t.totalEur)] : []),
          (o.availability ?? '?').replace(/^(InStock|OutOfStock|PreOrder|SoldOut|BackOrder|InStoreOnly).*$/, '$1') + (o.shipsToSk === 'unknown' && !local ? ', SK delivery?' : ''),
          o.match.level === 'exact' ? 'exact' : `${o.match.level}: ${o.match.reasons.join('; ')}`,
          o.url,
        ];
      }),
      local ? [24, 22, 10, 12, 16, 12, 14, 12, 30, 80] : [24, 22, 10, 12, 44, 12, 22, 30, 80],
    ));
  }
}

// ---- shops to open by hand + statuses -------------------------------------------------------
const todo = notCheckedList(shopResults);
console.log(`\n== Not checked automatically: open these yourself (${todo.length}) ==`);
console.log(`  Heureka.sk (never fetched by this app): ${heureka}`);
for (const t of todo) console.log(`  ${t.shopName.padEnd(24)} ${t.status.padEnd(17)} ${t.url}`);

console.log(`\n== Shops: ${statusSummary(shopResults)} ==`);
const order: Record<ShopStatus, number> = { ok: 0, no_match: 1, needs_search_key: 2, robots_disallowed: 3, blocked: 4, needs_js: 5, no_route: 6, error: 7, not_relevant: 8 };
const asked = shopResults.filter((r) => r.status !== 'not_relevant');
console.log(table(
  ['shop', 'section', 'status', 'route', 'req', 'detail'],
  [...asked].sort((a, b) => (a.section === b.section ? 0 : a.section === 'local' ? -1 : 1) || order[a.status] - order[b.status])
    .map((r) => [r.shopName, r.section === 'local' ? `${location.name} branch` : 'web', r.status, r.route, String(r.requestsUsed), r.detail]),
  [24, 15, 17, 15, 3, Math.max(50, W - 90)],
));
const skipped = shopResults.filter((r) => r.status === 'not_relevant');
if (skipped.length) console.log(`Not asked (categories do not fit): ${skipped.map((r) => r.shopName).join(', ')}`);
if (summary) {
  const calls = summary.providerCalls.length;
  const second = summary.fallbackQueries ? `; ${summary.fallbackQueries} of them for ${summary.fallbackShops} shop(s) whose own search found nothing matching` : '';
  const prices = summary.nearbyPrices ? ` (${summary.nearbyPrices} price${summary.nearbyPrices === 1 ? '' : 's'} of similar models read among them)` : '';
  console.log(`\nCost: ${summary.shopsAsked} shops asked, ${summary.shopRequests} shop requests${prices}, ${summary.siteQueries} web search quer${summary.siteQueries === 1 ? 'y' : 'ies'} (${calls} new API call${calls === 1 ? '' : 's'}, the rest from the cache${second})`);
}
store.close();
