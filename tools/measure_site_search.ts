// Measures the web-search route: for the shops whose own search page robots.txt disallows (or that
// have none), how often a domain-restricted search finds a correct product page, and what one full
// product search costs in queries. Uses the real app pipeline, so every request rule applies and
// every provider response and product page is cached in SQLite (re-running costs nothing for 6 h).
//
//   node tools/measure_site_search.ts --providers serper --mode combined "Oral-B Pro 3 3000" "iPhone 16 128GB"

import { parseArgs } from 'node:util';
import { ShopSession } from '../src/core/http.ts';
import { runSearch } from '../src/core/pipeline.ts';
import { buildSearchUrl, DEFAULT_LOCATION } from '../src/core/shops.ts';
import type { ShopResult } from '../src/core/types.ts';
import { loadEnv, loadShops, makeScheduler, openStore, providersFromEnv } from '../src/node/setup.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { providers: { type: 'string', default: 'serper' }, mode: { type: 'string', default: 'combined' } },
});
loadEnv();
const store = openStore();
const scheduler = makeScheduler(store);
const providers = providersFromEnv(values.providers);
if (!providers.length) throw new Error('no provider key for ' + values.providers);
const all = loadShops().filter((s) => s.in_scope && !s.needs_js && s.structured_data !== false);

// Which shops take the web-search route: no template, or robots.txt disallows the search URL.
const routeShops = [];
for (const s of all) {
  if (!s.search_url_template) {
    routeShops.push(s);
    continue;
  }
  const session = new ShopSession(s.domain, { scheduler, cache: store });
  const perm = await session.allowed(buildSearchUrl(s.search_url_template, positionals[0] ?? 'x'));
  if (!perm.blocked && !perm.allowed && !perm.budgetExhausted) routeShops.push(s);
}
console.log(`web-search route shops (${routeShops.length}): ${routeShops.map((s) => s.id).join(', ')}`);

const summary: Record<string, unknown>[] = [];
for (const query of positionals) {
  const results: ShopResult[] = [];
  let calls = 0;
  let credits = 0;
  for await (const ev of runSearch(query, {
    shops: routeShops, cache: store, scheduler, location: DEFAULT_LOCATION, providers,
    siteSearchMode: values.mode === 'per-shop' ? 'per_shop' : 'combined', domainsPerQuery: 6,
    onProviderCall: (c) => store.recordProviderCall(c),
  })) {
    if (ev.type === 'shop') results.push(ev.result);
    if (ev.type === 'done') {
      calls = ev.summary.providerCalls.length;
      credits = ev.summary.providerCalls.reduce((a, c) => a + c.credits, 0);
    }
  }
  const rows = results.map((r) => {
    const best = [...r.offers].sort((a, b) => b.match.score - a.match.score)[0];
    const exact = r.offers.some((o) => o.match.level === 'exact' && o.match.condition === 'new');
    const possible = r.offers.some((o) => o.match.level === 'possible');
    const hits = r.candidates.length;
    return {
      shop: r.shopId, status: r.status, hits, verdict: exact ? 'correct' : possible ? 'possible' : r.status === 'ok' ? 'possible' : 'none',
      best: best ? `${best.match.level}: ${best.title.slice(0, 60)}` : (r.candidates[0]?.title ?? '').slice(0, 60), detail: r.detail.slice(0, 90),
    };
  });
  console.log(`\n### ${query}  [${providers.map((p) => p.id).join('>')}, ${values.mode}]  new API queries this run: ${calls} (${credits} credits)`);
  console.table(rows);
  summary.push({ query, provider: values.providers, mode: values.mode, newQueries: calls, credits, correct: rows.filter((r) => r.verdict === 'correct').length, possible: rows.filter((r) => r.verdict === 'possible').length, shops: rows.length });
}
console.log('\nSUMMARY');
console.table(summary);
console.log('provider usage recorded so far (all runs):', store.providerUsage());
store.close();
