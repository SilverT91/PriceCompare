// schema.org JSON-LD extraction: Product, ProductGroup (with hasVariant), Offer, AggregateOffer,
// ItemList. Works on the HTML string with a regex, so it needs no DOM.

import { GTIN_KEYS, normaliseGtin } from './gtin.ts';
import { isPhone, mergeParams, paramsFromProperties, paramsFromText, type NamedValue, type Params } from './params.ts';
import type { Candidate, RawOffer, ShippingOption } from './types.ts';

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Node = { [k: string]: Json };

const SCRIPT_RE = /<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script\s*>/gi;

/** All parseable JSON-LD blocks of a page. Broken blocks are skipped (counted in `errors`). */
export function extractJsonLdBlocks(html: string): { blocks: Json[]; errors: number } {
  const blocks: Json[] = [];
  let errors = 0;
  for (const m of html.matchAll(SCRIPT_RE)) {
    let text = m[1].trim();
    text = text.replace(/^<!--/, '').replace(/-->$/, '').replace(/^\s*\/\/\s*<!\[CDATA\[/, '').replace(/\/\/\s*\]\]>\s*$/, '');
    if (!text) continue;
    try {
      blocks.push(JSON.parse(text));
      continue;
    } catch {
      /* fall through */
    }
    try {
      // Raw control characters (newlines inside strings) are a common shop bug; outside strings they
      // are whitespace anyway, so replacing them all with spaces is safe.
      blocks.push(JSON.parse(text.replace(/[\u0000-\u001f]/g, ' ')));
    } catch {
      errors++;
    }
  }
  return { blocks, errors };
}

export function typeNames(node: Node): string[] {
  const t = node['@type'];
  const list = Array.isArray(t) ? t : t === undefined || t === null ? [] : [t];
  return list.map((x) => String(x).split(/[/#]/).pop() ?? '');
}

const isObj = (v: unknown): v is Node => typeof v === 'object' && v !== null && !Array.isArray(v);
const asList = (v: Json | undefined): Json[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

function str(v: Json | undefined): string | null {
  if (v === undefined || v === null) return null;
  if (Array.isArray(v)) {
    for (const x of v) {
      const s = str(x);
      if (s) return s;
    }
    return null;
  }
  if (isObj(v)) return str(v.name ?? v['@value'] ?? v.value ?? null);
  const s = String(v).trim();
  return s || null;
}

/** "1 029,90 €" -> 1029.9, "1.029,90" -> 1029.9, "1029.90" -> 1029.9, 849 -> 849. */
export function parsePrice(value: Json | undefined): number | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  let s = String(value).replace(/[\s ]/g, '').replace(/[^\d,.\-]/g, '');
  if (!s) return null;
  if (s.includes(',') && s.includes('.')) {
    s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (s.includes(',')) {
    const parts = s.split(',');
    s = parts.length === 2 && parts[1].length === 3 && parts[0].length <= 3 ? parts.join('') : s.replace(',', '.');
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const CONTAINER_KEYS = ['@graph', 'mainEntity', 'object', 'about'];

/**
 * Top-level nodes of the page: block roots, @graph members, WebPage.mainEntity, BuyAction.object.
 * Deliberately does not descend into isRelatedTo, isAccessoryOrSparePartFor, ItemList etc., so
 * accessories and "customers also bought" products do not become offers of this page.
 */
function topLevelNodes(blocks: Json[]): Node[] {
  const out: Node[] = [];
  const visit = (v: Json, depth: number) => {
    if (depth > 4) return;
    if (Array.isArray(v)) {
      for (const x of v) visit(x, depth + 1);
      return;
    }
    if (!isObj(v)) return;
    out.push(v);
    for (const k of CONTAINER_KEYS) if (k in v) visit(v[k], depth + 1);
  };
  for (const b of blocks) visit(b, 0);
  return out;
}

function indexById(blocks: Json[]): Map<string, Node> {
  const map = new Map<string, Node>();
  const walk = (v: Json, depth: number) => {
    if (depth > 12) return;
    if (Array.isArray(v)) return v.forEach((x) => walk(x, depth + 1));
    if (!isObj(v)) return;
    const id = v['@id'];
    if (typeof id === 'string' && Object.keys(v).length > 1 && !map.has(id)) map.set(id, v);
    for (const [k, x] of Object.entries(v)) if (k !== '@context') walk(x, depth + 1);
  };
  blocks.forEach((b) => walk(b, 0));
  return map;
}

const PRODUCT_TYPES = new Set(['Product', 'IndividualProduct', 'ProductModel', 'SomeProducts', 'Book']);

function countryCodes(dest: Json | undefined): string[] {
  const out: string[] = [];
  for (const d of asList(dest)) {
    if (!isObj(d)) {
      const s = str(d);
      if (s) out.push(s.toUpperCase());
      continue;
    }
    for (const c of asList(d.addressCountry)) {
      const s = isObj(c) ? str(c.identifier ?? c.name ?? null) : str(c);
      if (s) out.push(s.toUpperCase());
    }
  }
  return out;
}

function shippingOf(sd: Json | undefined, byId: Map<string, Node>): ShippingOption[] {
  const out: ShippingOption[] = [];
  for (let item of asList(sd)) {
    if (isObj(item) && typeof item['@id'] === 'string' && Object.keys(item).length === 1) item = byId.get(item['@id']) ?? item;
    if (!isObj(item)) continue;
    const rate = item.shippingRate;
    let value: number | null = null;
    let currency: string | null = null;
    if (isObj(rate)) {
      value = parsePrice(rate.value ?? null);
      // A range (minValue..maxValue) is only usable when both ends are equal.
      if (value === null && rate.minValue !== undefined && rate.minValue === rate.maxValue) value = parsePrice(rate.minValue);
      currency = str(rate.currency ?? null);
    } else if (rate !== undefined) {
      value = parsePrice(rate);
    }
    let freeFrom: number | null = null;
    const thr = item.freeShippingThreshold;
    if (isObj(thr)) freeFrom = parsePrice(thr.value ?? thr.minValue ?? null);
    else if (thr !== undefined) freeFrom = parsePrice(thr);
    out.push({ countries: countryCodes(item.shippingDestination), rate: value, currency, freeFrom });
  }
  return out;
}

interface OfferBits {
  price: number;
  listPrice: number | null;
  currency: string;
  availability: string | null;
  itemCondition: string | null;
  seller: string | null;
  url: string | null;
  shipping: ShippingOption[];
  source: string;
  gtin: string | null;
}

const lastSegment = (s: string | null): string | null => (s ? s.split(/[/#]/).pop() || s : null);

function offerBits(o: Node, byId: Map<string, Node>, fallbackCurrency: string | null): OfferBits[] {
  const types = typeNames(o);
  if (types.includes('AggregateOffer')) {
    // Marketplace summary. Use nested offers when present, otherwise the lowest price.
    const nested = asList(o.offers).filter(isObj);
    if (nested.length) return nested.flatMap((n) => offerBits(n, byId, str(o.priceCurrency ?? null) ?? fallbackCurrency));
    const low = parsePrice(o.lowPrice ?? o.price ?? null);
    const cur = str(o.priceCurrency ?? null) ?? fallbackCurrency;
    if (low === null || !cur) return [];
    return [{
      price: low, listPrice: null, currency: cur.toUpperCase(), availability: lastSegment(str(o.availability ?? null)),
      itemCondition: lastSegment(str(o.itemCondition ?? null)), seller: null, url: str(o.url ?? null),
      shipping: shippingOf(o.shippingDetails, byId), source: 'AggregateOffer (lowest price)', gtin: null,
    }];
  }
  let price = parsePrice(o.price ?? null);
  let currency = str(o.priceCurrency ?? null);
  if (price === null) {
    // priceSpecification: take the first that is not a strikethrough / list price.
    for (const spec of asList(o.priceSpecification).filter(isObj)) {
      const pt = str(spec.priceType ?? null) ?? '';
      if (/Strikethrough|ListPrice|SRP|MSRP/i.test(pt)) continue;
      price = parsePrice(spec.price ?? null);
      currency = currency ?? str(spec.priceCurrency ?? null);
      if (price !== null) break;
    }
  }
  if (price === null) price = parsePrice(o.lowPrice ?? null);
  // NAY/Datart publish "price" (regular) and "salePrice" (current, lower). The shop shows the sale price.
  let listPrice: number | null = null;
  const sale = parsePrice(o.salePrice ?? null);
  if (sale !== null && price !== null && sale < price) {
    listPrice = price;
    price = sale;
  }
  currency = currency ?? fallbackCurrency;
  if (price === null || !currency) return [];
  let gtin: string | null = null;
  for (const k of GTIN_KEYS) {
    if (o[k] !== undefined) {
      gtin = normaliseGtin(str(o[k]));
      if (gtin) break;
    }
  }
  return [{
    price, listPrice, currency: currency.toUpperCase(), availability: lastSegment(str(o.availability ?? null)),
    itemCondition: lastSegment(str(o.itemCondition ?? null)),
    seller: isObj(o.seller) ? str(o.seller.name ?? null) : str(o.seller ?? null),
    url: str(o.url ?? null), shipping: shippingOf(o.shippingDetails, byId), source: 'Offer', gtin,
  }];
}

function gtinOf(node: Node): string | null {
  for (const k of GTIN_KEYS) {
    if (node[k] !== undefined) {
      const g = normaliseGtin(str(node[k]));
      if (g) return g;
    }
  }
  return null;
}

function resolve(v: Json, byId: Map<string, Node>): Json {
  if (isObj(v) && typeof v['@id'] === 'string' && Object.keys(v).length === 1) return byId.get(v['@id']) ?? v;
  return v;
}

function brandOf(node: Node): string | null {
  return str(node.brand ?? null) ?? (isObj(node.manufacturer) ? str(node.manufacturer.name ?? null) : null);
}

/**
 * The URL an offer links to: the structured data's url, unless it cannot be the product page, in
 * which case the page the offer was read from. Nazuby.eu gives every offer "url": "https://www.nazuby.eu"
 * (the site root), which would send the user to the homepage.
 */
export function offerUrl(declared: string | null | undefined, pageUrl: string): string {
  let page: URL;
  try {
    page = new URL(pageUrl);
  } catch {
    return declared ?? pageUrl;
  }
  if (!declared) return page.href;
  let u: URL;
  try {
    u = new URL(declared, page);
  } catch {
    return page.href;
  }
  if (!/^https?:$/.test(u.protocol)) return page.href;
  const root = u.pathname === '/' || u.pathname === '' || /^\/(index\.(html?|php|aspx?)|[a-z]{2}(-[a-z]{2})?\/?)$/i.test(u.pathname);
  const pageIsRoot = page.pathname === '/' || page.pathname === '';
  return root && !pageIsRoot && !u.search ? page.href : u.href;
}

/**
 * The parameters a product page states about the product (params.ts): its named values
 * (`additionalProperty`: NAY) and its description (TPD's "Label: value" pairs, Mironet's list).
 * Only the parameters are kept, not the text. Undefined when the page states none.
 */
function pageParams(node: Node, name: string, byId: Map<string, Node>): Params | undefined {
  const props: NamedValue[] = [];
  for (const raw of asList(node.additionalProperty)) {
    const x = resolve(raw, byId);
    if (!isObj(x)) continue;
    const label = str(x.name ?? null) ?? str(x.propertyID ?? null);
    const value = typeof x.value === 'number' ? String(x.value) : str(x.value ?? null);
    const unit = str(x.unitText ?? null);
    if (label && value) props.push({ name: label, value: unit ? `${value} ${unit}` : value });
  }
  const description = str(node.description ?? null);
  const params = mergeParams(paramsFromProperties(props), description ? paramsFromText(description, 'description', isPhone(name)) : undefined);
  return Object.keys(params).length ? params : undefined;
}

function productOffers(node: Node, ctx: { shopId: string; pageUrl: string; byId: Map<string, Node> },
  inherited: { name?: string | null; brand?: string | null; source: string; currency?: string | null }): RawOffer[] {
  const name = str(node.name ?? null) ?? inherited.name ?? null;
  if (!name) return [];
  const brand = brandOf(node) ?? inherited.brand ?? null;
  const gtin = gtinOf(node);
  const params = pageParams(node, name, ctx.byId);
  const out: RawOffer[] = [];
  for (const raw of asList(node.offers)) {
    const o = resolve(raw, ctx.byId);
    if (!isObj(o)) continue;
    for (const b of offerBits(o, ctx.byId, inherited.currency ?? null)) {
      // Datart publishes sold-out items with price 0: that is "no price", not a free product.
      if (!(b.price > 0)) continue;
      const url = offerUrl(b.url ?? str(node.url ?? null), ctx.pageUrl);
      out.push({
        shopId: ctx.shopId, url, title: name, brand, gtin: gtin ?? b.gtin,
        sku: str(node.sku ?? null), mpn: str(node.mpn ?? null), color: str(node.color ?? null),
        price: b.price, currency: b.currency, availability: b.availability,
        itemCondition: b.itemCondition ?? lastSegment(str(node.itemCondition ?? null)), seller: b.seller,
        shipping: b.shipping.length ? b.shipping : shippingOf(node.shippingDetails, ctx.byId),
        source: inherited.source + (b.source === 'Offer' ? '' : ` / ${b.source}`) + (b.listPrice !== null ? ` (sale price; regular ${b.listPrice})` : ''),
        ...(params ? { params } : {}),
      });
    }
  }
  return out;
}

export interface PageExtraction {
  offers: RawOffer[];
  productNodes: number;
  blocks: number;
  parseErrors: number;
}

/** Offers on a product page. */
export function extractOffers(html: string, pageUrl: string, shopId: string): PageExtraction {
  const { blocks, errors } = extractJsonLdBlocks(html);
  return extractOffersFromBlocks(blocks, pageUrl, shopId, errors);
}

export function extractOffersFromBlocks(blocks: Json[], pageUrl: string, shopId: string, parseErrors = 0): PageExtraction {
  const byId = indexById(blocks);
  const ctx = { shopId, pageUrl, byId };
  const offers: RawOffer[] = [];
  let productNodes = 0;
  const seen = new Set<Node>();
  for (const node of topLevelNodes(blocks)) {
    const types = typeNames(node);
    if (types.includes('ProductGroup')) {
      productNodes++;
      seen.add(node);
      const groupName = str(node.name ?? null);
      const groupBrand = brandOf(node);
      const variants = asList(node.hasVariant).map((v) => resolve(v, byId)).filter(isObj);
      let variantOffers = 0;
      for (const v of variants) {
        if (seen.has(v)) continue;
        seen.add(v);
        const got = productOffers(v, ctx, { name: groupName, brand: groupBrand, source: 'ProductGroup variant' });
        variantOffers += got.length;
        offers.push(...got);
      }
      // MediaMarkt puts the offers of the shown variant on the group node itself.
      if (node.offers !== undefined) {
        const own = productOffers(node, ctx, { source: variants.length ? 'ProductGroup (shown variant)' : 'ProductGroup' });
        // Avoid duplicating a variant that has the same URL and price.
        for (const o of own) {
          if (!offers.some((x) => x.url === o.url && x.price === o.price && x.seller === o.seller && x.title === o.title)) offers.push(o);
        }
      } else if (!variantOffers) {
        /* group without priced variants: nothing to add */
      }
      continue;
    }
    if (types.some((t) => PRODUCT_TYPES.has(t)) && !seen.has(node)) {
      productNodes++;
      seen.add(node);
      offers.push(...productOffers(node, ctx, { source: 'Product' }));
    }
  }
  return { offers, productNodes, blocks: blocks.length, parseErrors };
}

/** Candidate product URLs from a search page: ItemList entries and Product nodes with a URL. */
export function extractListCandidates(html: string, pageUrl: string): Candidate[] {
  const { blocks } = extractJsonLdBlocks(html);
  return extractListCandidatesFromBlocks(blocks, pageUrl);
}

export function extractListCandidatesFromBlocks(blocks: Json[], pageUrl: string): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  const add = (url: string | null, title: string | null) => {
    if (!url) return;
    let abs: string;
    try {
      abs = new URL(url, pageUrl).href;
    } catch {
      return;
    }
    if (seen.has(abs)) return;
    seen.add(abs);
    out.push({ url: abs, title: title ?? '', from: 'itemlist' });
  };
  const walk = (v: Json, depth: number) => {
    if (depth > 10) return;
    if (Array.isArray(v)) return v.forEach((x) => walk(x, depth + 1));
    if (!isObj(v)) return;
    const types = typeNames(v);
    if (types.includes('BreadcrumbList')) return;
    if (types.includes('ItemList')) {
      for (const el of asList(v.itemListElement)) {
        if (!isObj(el)) continue;
        const item = isObj(el.item) ? el.item : el;
        add(str(item.url ?? null) ?? str(item['@id'] ?? null) ?? str(el.url ?? null), str(item.name ?? null) ?? str(el.name ?? null));
      }
      return;
    }
    if (types.some((t) => PRODUCT_TYPES.has(t) || t === 'ProductGroup')) {
      add(str(v.url ?? null), str(v.name ?? null));
    }
    for (const [k, x] of Object.entries(v)) if (k !== '@context') walk(x, depth + 1);
  };
  blocks.forEach((b) => walk(b, 0));
  return out;
}
