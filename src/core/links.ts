// Candidate product links from a shop's search result page (used when the page has no JSON-LD ItemList).

import { load } from 'cheerio/slim';
import { registeredDomain } from './http.ts';
import { tokenize } from './text.ts';
import type { Candidate } from './types.ts';

const NON_PRODUCT_RE =
  /(?:^|\/)(?:login|prihlasenie|prihlaseni|registracia|kosik|cart|basket|warenkorb|wishlist|obchodne-podmienky|kontakt|cookies?|privacy|ochrana|reklamacie|doprava|search|vyhladavanie|hledani|vyhledavani|wyszukiwarka|filter|napoveda|blog|clanky|predajne|prodejny|account|konto)(?:\/|$|\?|\.)/i;

/** URL path to words: hyphens and slashes are separators in slugs. */
export function slugWords(path: string): string {
  let p = path;
  try {
    p = decodeURIComponent(path);
  } catch {
    /* keep raw */
  }
  return p.replace(/\.(html?|php|aspx?)$/i, '').replace(/[/_+\-]+/g, ' ');
}

export function extractLinkCandidates(html: string, pageUrl: string, query: string, excludeRegex?: string): Candidate[] {
  const $ = load(html);
  const base = registeredDomain(new URL(pageUrl).host);
  const exclude = excludeRegex ? new RegExp(excludeRegex) : null;
  const q = new Set(tokenize(query));
  const need = Math.max(1, Math.ceil(0.5 * q.size));
  const byUrl = new Map<string, { labels: Set<string>; order: number }>();
  let order = 0;
  $('a[href]').each((_i, el) => {
    const a = $(el);
    const href = (a.attr('href') ?? '').trim();
    if (!href || /^(#|javascript:|mailto:|tel:)/i.test(href)) return;
    if (a.parents('nav, header, footer').length) return;
    let u: URL;
    try {
      u = new URL(href, pageUrl);
    } catch {
      return;
    }
    if (!/^https?:$/.test(u.protocol)) return;
    if (registeredDomain(u.host) !== base) return;
    u.hash = '';
    if (NON_PRODUCT_RE.test(u.pathname) || (exclude && exclude.test(u.href))) return;
    if (u.pathname === '/' || u.pathname.length < 4) return;
    const label = [a.text(), a.attr('title'), a.attr('aria-label'), a.find('img').attr('alt')]
      .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    const entry = byUrl.get(u.href) ?? { labels: new Set<string>(), order: order++ };
    if (label) entry.labels.add(label.slice(0, 200));
    byUrl.set(u.href, entry);
  });
  const out: (Candidate & { order: number })[] = [];
  const hitsIn = (s: string) => {
    const t = new Set(tokenize(s));
    let n = 0;
    for (const x of q) if (t.has(x)) n++;
    return n;
  };
  for (const [url, e] of byUrl) {
    // Several anchors point to one product (image, name, spec line, reviews): take the one that
    // names the product best, i.e. most query words, then the shorter one.
    const label = [...e.labels].sort((x, y) => hitsIn(y) - hitsIn(x) || x.length - y.length)[0] ?? '';
    const words = new Set([...tokenize(label), ...tokenize(slugWords(new URL(url).pathname))]);
    let hits = 0;
    for (const t of q) if (words.has(t)) hits++;
    if (hits >= need) out.push({ url, title: label || slugWords(new URL(url).pathname).trim(), from: 'html_link', order: e.order });
  }
  out.sort((x, y) => x.order - y.order);
  return out.slice(0, 40).map(({ order: _o, ...c }) => c);
}
