// Reads a shop's information page (delivery, pickup, homepage search form) under the app's request
// rules: robots.txt, 3 s per host, generic User-Agent, no retries, bot walls reported, not bypassed.
// Used by hand to fill in shops.yaml facts (shipping_to_sk, pickup_kosice, search templates).
// Nothing is stored except robots.txt rules and the per-host clock.
//
//   node tools/fetch_info.ts <domain> <url> [--links] [--anchors "regex"] [--grep "regex"] [--forms]

import { parseArgs } from 'node:util';
import { load } from 'cheerio/slim';
import { ShopSession } from '../src/core/http.ts';
import { extractJsonLdBlocks } from '../src/core/jsonld.ts';
import { makeScheduler, openStore } from '../src/node/setup.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { links: { type: 'boolean', default: false }, anchors: { type: 'string' }, forms: { type: 'boolean', default: false }, grep: { type: 'string' }, budget: { type: 'string', default: '3' } },
});
const [domain, url] = positionals;
const store = openStore();
const session = new ShopSession(domain, { scheduler: makeScheduler(store), cache: store, budget: Number(values.budget) });
const page = await session.get(url, 'info');
console.log(`GET ${url} -> status ${page.status} final ${page.finalUrl}${page.blocked ? ` BLOCKED(${page.blocked})` : ''}${page.robotsDisallowed ? ` ROBOTS-DISALLOWED(${page.robotsDisallowed})` : ''}${page.error ? ` ERROR(${page.error})` : ''}${page.offsiteRedirect ? ` OFFSITE(${page.offsiteRedirect})` : ''}`);
console.log(`requests: ${session.log.map((l) => `${l.kind} ${l.status}`).join(', ')}`);
if (page.ok) {
  const $ = load(page.text);
  if (values.forms) {
    $('form').each((_i, f) => {
      const inputs = $(f).find('input[name]').map((_j, i) => `${$(i).attr('name')}(${$(i).attr('type') ?? 'text'})`).get().join(' ');
      console.log(`FORM action=${$(f).attr('action')} method=${$(f).attr('method') ?? 'get'} inputs=${inputs}`);
    });
    for (const b of extractJsonLdBlocks(page.text).blocks) {
      const s = JSON.stringify(b);
      const m = /"SearchAction"[^}]*"target"\s*:\s*("[^"]+"|\{[^}]+\})/.exec(s);
      if (m) console.log(`SearchAction target: ${m[1]}`);
    }
  }
  if (values.links || values.anchors) {
    const re = values.anchors
      ? new RegExp(values.anchors, 'i')
      : /doprav|doru[cč]|vyzdvihn|odber|osobn|predajn|prodejn|versand|liefer|abhol|dostaw|wysy[lł]k|odbi[oó]r|shipping|delivery|pickup|click.?collect|platb/i;
    const seen = new Set<string>();
    $('a[href]').each((_i, a) => {
      const href = $(a).attr('href') ?? '';
      const text = $(a).text().replace(/\s+/g, ' ').trim();
      if ((re.test(href) || re.test(text)) && !seen.has(href)) {
        seen.add(href);
        console.log(`LINK ${text.slice(0, 60)} -> ${new URL(href, page.finalUrl).href}`);
      }
    });
  }
  if (values.grep) {
    $('script, style, noscript').remove();
    const text = $('body').text().replace(/[ \t]+/g, ' ').split(/\n+/).map((l) => l.trim()).filter(Boolean);
    const re = new RegExp(values.grep, 'i');
    let shown = 0;
    for (let i = 0; i < text.length && shown < 60; i++) {
      if (re.test(text[i])) {
        console.log(`| ${text.slice(Math.max(0, i - 1), i + 2).join(' / ').slice(0, 300)}`);
        shown++;
      }
    }
    if (!shown) console.log(`(no line matches /${values.grep}/; ${text.length} text lines)`);
  }
}
store.close();
