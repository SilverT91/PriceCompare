// Phase 0 of docs/plan-parameters.md: which shops publish product parameters in their JSON-LD?
// Takes computer and phone product pages the cache already knows (at most 2 per shop, 20 in all),
// reads them through ShopSession (robots.txt, 3 s per host, the generic User-Agent, at most 3
// requests per shop) and prints, per page, what the Product node carries: additionalProperty
// (count and names), description length and whether it states amounts in GB, model, mpn, GTIN.
// Usage: node tools/measure_params.ts [--max 20]
import { extractJsonLdBlocks, typeNames } from '../src/core/jsonld.ts';
import { ShopSession } from '../src/core/http.ts';
import { makeScheduler, openStore } from '../src/node/setup.ts';

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Node = { [k: string]: Json };

const max = Number(process.argv[process.argv.indexOf("--max") + 1]) || 20;
const show = process.argv.includes("--show");
const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1].split(",") : null;
const store = openStore();
const scheduler = makeScheduler(store);
const WANT = /\b(z2|omen|thinkstation|elitedesk|prodesk|ideapad|notebook|iphone|galaxy|pixel|redmi|xiaomi|motorola|ascent|pgx)\b/i;

const rows = store.db.prepare("select key, value from cache where ns = 'offers'").all() as { key: string; value: string }[];
const perShop = new Map<string, string[]>();
for (const r of rows) {
  const v = JSON.parse(r.value) as { offers?: { shopId: string; title: string }[] };
  const o = v.offers?.[0];
  if (!o || !WANT.test(o.title)) continue;
  const list = perShop.get(o.shopId) ?? [];
  if (show && list.length >= 1) continue;
  if (list.length < 2) list.push(r.key);
  perShop.set(o.shopId, list);
}
const urls = [...perShop.entries()].filter(([shop]) => !only || only.includes(shop)).flatMap(([shop, list]) => list.map((u) => ({ shop, url: u }))).slice(0, max);
console.log(`${urls.length} pages from ${perShop.size} shops`);

function products(blocks: Json[]): Node[] {
  const out: Node[] = [];
  const walk = (x: Json) => {
    if (Array.isArray(x)) return x.forEach(walk);
    if (!x || typeof x !== 'object') return;
    if (typeNames(x as Node).some((t) => t === 'Product' || t === 'ProductGroup')) out.push(x as Node);
    for (const v of Object.values(x)) walk(v);
  };
  blocks.forEach(walk);
  return out;
}

const sessions = new Map<string, ShopSession>();
for (const { shop, url } of urls) {
  const host = new URL(url).host;
  const session = sessions.get(shop) ?? new ShopSession(host, { scheduler, cache: store, budget: 3 });
  sessions.set(shop, session);
  const page = await session.get(url, 'product');
  if (!page.ok) {
    console.log(`${shop.padEnd(16)} ${page.status ?? '-'} ${page.blocked ? 'blocked' : page.robotsDisallowed ? 'robots' : page.budgetExhausted ? 'budget' : page.error ?? ''}  ${url}`);
    continue;
  }
  const p = products(extractJsonLdBlocks(page.text).blocks)[0];
  if (!p) {
    console.log(`${shop.padEnd(16)} no Product node  ${url}`);
    continue;
  }
  const props = ([] as Json[]).concat(p.additionalProperty ?? []).filter((x): x is Node => Boolean(x) && typeof x === 'object' && !Array.isArray(x));
  const names = props.map((x) => String(x.name ?? x.propertyID ?? '?')).slice(0, 10);
  const desc = typeof p.description === 'string' ? p.description : '';
  console.log(`${shop.padEnd(16)} props=${String(props.length).padStart(3)} desc=${String(desc.length).padStart(5)}${/\d\s*GB/i.test(desc) ? ' (GB)' : '     '} model=${p.model ? 'y' : '-'} mpn=${p.mpn ? 'y' : '-'} gtin=${['gtin', 'gtin13', 'gtin14', 'gtin12', 'gtin8'].some((k) => p[k]) ? 'y' : '-'}  ${names.join(' | ')}`);
  if (show) {
    console.log(`    description: ${desc.replace(/\s+/g, ' ').slice(0, 400)}`);
    for (const x of props) console.log(`    ${String(x.name ?? x.propertyID)} = ${JSON.stringify(x.value ?? x.valueReference ?? null)}${x.unitText ? ` ${x.unitText}` : ''}`);
  }
}
let used = 0;
for (const s of sessions.values()) used += s.used;
console.log(`requests: ${used}`);
store.close();
