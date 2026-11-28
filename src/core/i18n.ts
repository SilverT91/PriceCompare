// Languages of the texts the core builds for people (shop details, delivery and pickup notes, product
// notes, summary lines, messages). English is the default and stays word for word as it was; Slovak
// is the second language. Status codes and other identifiers stay as they are in the events; only
// sentences go through this catalogue. Standard web APIs only (Intl), so it runs on Workers too.
//
// The Slovak wording of everything the core says is in the `sk` object below; the page's own labels
// are in public/i18n.js. Slovak versions of the free-text notes in data/shops.yaml are in
// data/shops.sk.yaml (localizeShop below).

import type { MatchReason, Shop } from './types.ts';

export type Lang = 'en' | 'sk';
export const LANGS: readonly Lang[] = ['en', 'sk'];

/** "sk" (any case) is Slovak; anything else is English. */
export function parseLang(v: unknown): Lang {
  return typeof v === 'string' && v.trim().toLowerCase() === 'sk' ? 'sk' : 'en';
}

/** Slovak plural: 1 -> one, 2 to 4 -> few, 0 and 5 and more -> many ("1 ponuka", "2 ponuky", "5 ponúk"). */
export function pluralSk(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(n);
  return a === 1 ? one : a >= 2 && a <= 4 && Number.isInteger(a) ? few : many;
}

/** The plural form for `n` in `lang`. English uses `one` for 1 and `other` for everything else. */
export function plural(lang: Lang, n: number, forms: { one: string; few: string; other: string }): string {
  if (lang === 'sk') return pluralSk(n, forms.one, forms.few, forms.other);
  return n === 1 ? forms.one : forms.other;
}

const NBSP = ' ';
const skInt = new Intl.NumberFormat('sk-SK', { maximumFractionDigits: 0 });
const skDec = new Intl.NumberFormat('sk-SK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const skAny = new Intl.NumberFormat('sk-SK', { maximumFractionDigits: 6 });

/** A number as written in `lang`: English as JavaScript prints it; Slovak "1 265" and "0,99" (2 decimals unless whole). */
export function num(lang: Lang, n: number): string {
  if (lang === 'en') return String(n);
  return Number.isInteger(n) ? skInt.format(n) : skDec.format(n);
}

/** An exchange rate or other number with all its decimals ("24,428"). */
export function rateNum(lang: Lang, n: number): string {
  return lang === 'en' ? String(n) : skAny.format(n);
}

/** An amount with its currency: English "99 EUR"; Slovak "99 €", "0,99 €", "1 265 PLN". */
export function money(lang: Lang, n: number, currency: string): string {
  if (lang === 'en') return `${n} ${currency}`;
  return `${num(lang, n)}${NBSP}${currency.toUpperCase() === 'EUR' ? '€' : currency}`;
}

/** A EUR amount with two decimals: English "297.90 €", Slovak "297,90 €". */
export function eur(lang: Lang, n: number): string {
  return lang === 'en' ? `${n.toFixed(2)} €` : `${skDec.format(n)}${NBSP}€`;
}

/** A date "2026-11-24" as written in `lang` (Slovak "24. 11. 2026"); anything else unchanged. */
export function date(lang: Lang, iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (lang === 'en' || !m) return iso;
  return `${Number(m[3])}.${NBSP}${Number(m[2])}.${NBSP}${m[1]}`;
}

/** Slovak quotation marks around a word or name. */
const q = (s: string) => `„${s}“`;

// ---- shop categories (data/shops.yaml vocabulary) and the user-selectable groups (categories.ts) ----

const CATEGORY_SK: Record<string, string> = {
  electronics: 'elektronika', appliances: 'spotrebiče', tools: 'náradie', diy_garden: 'dielňa a záhrada', drugstore: 'drogéria',
  pharmacy: 'lekáreň', beauty: 'kozmetika', furniture: 'nábytok', home: 'domácnosť', books: 'knihy', grocery: 'potraviny',
  general: 'všeobecný sortiment',
};
const GROUP_SK: Record<string, string> = {
  electronics: 'Elektronika a spotrebiče', tools: 'Náradie, dielňa a záhrada', health: 'Drogéria, lekáreň a kozmetika',
  home: 'Nábytok a domácnosť', books: 'Knihy',
};

/** One shop category id as a word ("elektronika"); English keeps the id. */
export function categoryName(lang: Lang, id: string): string {
  return lang === 'sk' ? CATEGORY_SK[id] ?? id : id;
}

/**
 * What a category choice covers, for a sentence: English keeps choice.label as it is; Slovak names
 * the categories, the chosen group (by id) or "všetky obchody".
 */
export function categoryLabel(lang: Lang, choice: { categories: string[] | null; mode: string; label: string }, groupId?: string): string {
  if (lang === 'en') return choice.label;
  if (!choice.categories) return 'všetky obchody';
  if (choice.mode === 'group' && groupId && GROUP_SK[groupId]) return GROUP_SK[groupId];
  return choice.categories.map((c) => categoryName(lang, c)).join(', ');
}

// ---- colours (canonical names from vocab.ts) -----------------------------------------------------

const COLOUR_SK: Record<string, string> = {
  teal: 'tyrkysová', ultramarine: 'ultramarínová', black: 'čierna', white: 'biela', 'light blue': 'svetlomodrá', 'dark blue': 'tmavomodrá',
  blue: 'modrá', pink: 'ružová', green: 'zelená', red: 'červená', grey: 'sivá', silver: 'strieborná', gold: 'zlatá', purple: 'fialová',
  yellow: 'žltá', orange: 'oranžová', beige: 'béžová', desert: 'púštna', titanium: 'titánová', natural: 'prírodná',
};

/** A canonical colour name in `lang`; a colour the catalogue does not know stays as the shop wrote it. */
export function colourName(lang: Lang, c: string): string {
  return lang === 'sk' ? COLOUR_SK[c] ?? c : c;
}

// ---- technical notes from robots.txt, redirects and the web search providers ----------------------
// These are written in English where they arise (and some are cached that way, so the cache stays the
// same whatever the language); they are translated only when shown.

const TECH_SK: [RegExp, string][] = [
  [/robots\.txt unreachable/g, 'robots.txt je nedostupný'],
  [/robots\.txt HTTP (\d+) \(no rules\)/g, 'robots.txt: HTTP $1 (bez pravidiel)'],
  [/robots\.txt redirects off-site/g, 'robots.txt presmerúva na iný web'],
  [/bot wall on robots\.txt/g, 'ochrana proti robotom na robots.txt'],
  [/too many robots\.txt redirects/g, 'príliš veľa presmerovaní robots.txt'],
  [/too many redirects/g, 'príliš veľa presmerovaní'],
  [/no search provider configured/g, 'nie je nastavená žiadna služba webového vyhľadávania'],
  [/(\w+) monthly credit used up/g, '$1: mesačný kredit je vyčerpaný'],
  [/(\w+) credits used up/g, '$1: kredit je vyčerpaný'],
  [/(\w+) rejected the key/g, '$1 odmietol kľúč'],
  [/\(since ([0-9T:.\-Z]+)\)/g, '(od $1)'],
];

/** A technical note in `lang`: known English phrases translated, anything else (exception text, HTTP codes) unchanged. */
export function techNote(lang: Lang, s: string): string {
  if (lang === 'en') return s;
  return TECH_SK.reduce((acc, [re, to]) => acc.replace(re, to), s);
}

// ---- the catalogue ------------------------------------------------------------------------------

const en = {
  // pipeline.ts: a pasted link without a name
  rejectedLink: () => "This link does not contain the product's name, so nothing was searched. Type or paste the product's name instead.",
  // pipeline.ts: shop details
  notRelevant: (p: { cats: string; label: string }) => `not asked: its categories (${p.cats}) do not fit ${p.label}`,
  internalError: (p: { msg: string }) => `internal error: ${p.msg}`,
  pageFailedCached: (p: { url: string; status: number }) => `${p.url}: HTTP ${p.status} (cached)`,
  noWebPages: () => 'the web search returned no pages on this domain',
  noShopProducts: () => 'the shop search returned no products',
  noneMatching: (p: { n: number; best: string }) => `${p.n} result(s), none matching the query (best: "${p.best}")`,
  blockedProductPage: (p: { vendor: string }) => `bot protection (${p.vendor}) on a product page; skipped for an hour`,
  blockedOnUrl: (p: { url: string }) => `bot protection on ${p.url}`,
  budgetReached: (p: { max: number }) => `request budget (${p.max} per shop) reached`,
  alreadyReadPages: (p: { n: number }) => `${p.n} page(s) already read in this search (same page under another link) not read again`,
  zeroPriced: (p: { n: number }) => `${p.n} offer(s) listed with price 0 (sold out?) ignored`,
  okOffers: (p: { n: number; exact: number; possible: number }) => `${p.n} matching offer(s): ${p.exact} exact, ${p.possible} possible`,
  pagesNotProduct: (p: { n: number }) => `fetched ${p.n} page(s) without schema.org Product data; this shop's product pages carry it, so these were probably not product pages`,
  pagesNeedJs: (p: { n: number }) => `fetched ${p.n} page(s) without schema.org Product data; prices are probably rendered by JavaScript`,
  robotsCandidates: () => 'robots.txt disallows the candidate product pages',
  alreadyReadMatching: () => 'the matching pages were already read in this search',
  noPageRead: () => 'no product page could be read',
  offersNoneMatching: (p: { offers: number; pages: number }) => `${p.offers} offer(s) on ${p.pages} page(s), none matching the query`,
  needsJs: () => 'prices on this shop only appear after JavaScript runs; not fetched (open the manual link)',
  noSchema: () => 'product pages carry no schema.org data; not fetched (open the manual link)',
  notAsked: (p: { reason: string }) => `not asked: ${p.reason}`,
  defaultUnreachable: () => 'the site answers a plain client with errors',
  blockedCached: (p: { vendor: string; at: string }) => `bot protection (${p.vendor}) at ${p.at}; skipped for an hour`,
  searchedAs: (p: { sent: string }) => `searched as "${p.sent}": the query without its category, colour and generic words, for a shop in another country`,
  blockedRobots: (p: { vendor: string }) => `bot protection (${p.vendor}) on robots.txt; skipped for an hour`,
  budgetRobots: () => 'request budget exhausted while reading robots.txt',
  robotsSearch: (p: { note?: string }) => `robots.txt disallows the shop's search page${p.note ? ` (${p.note})` : ''}`,
  blockedSearch: (p: { vendor: string }) => `bot protection (${p.vendor}) on the search page; skipped for an hour`,
  searchRedirectRobots: (p: { url: string }) => `search redirected to ${p.url}, which robots.txt disallows`,
  searchOffsite: (p: { url: string }) => `search redirected off-site to ${p.url}`,
  searchFailed: (p: { why: string; guess: boolean }) => `search page failed: ${p.why}${p.guess ? ' (the search URL template is a guess and may be wrong)' : ''}`,
  noItemList: () => 'no JSON-LD ItemList on the search page; candidates from links',
  noProvider: (p: { why: string; reason: string }) => `${p.why}no usable web search provider: ${p.reason}`,
  webFailed: (p: { error: string }) => `web search failed: ${p.error}`,
  foundVia: (p: { provider: string }) => `found via ${p.provider} web search`,
  setKey: (p: { notes: string }) => `${p.notes}; set SERPER_API_KEY or BRAVE_API_KEY to find product pages through a web search`,
  noRoute: (p: { reason: string }) => `${p.reason}; a web search key (BRAVE_API_KEY or SERPER_API_KEY) would let the app search it`,
  defaultNoSearchUrl: () => 'no search URL known for this shop',
  candidatesFromCache: () => 'candidates from cache',
  retrySaid: (p: { sent: string; shorter: string }) =>
    `the shop search returned no products for "${p.sent}"; repeated as "${p.shorter}" (without category, colour, generic and package words)`,
  results: (p: { n: number }) => `${p.n} result(s)`,
  fromCacheSuffix: () => ' (from cache)',
  retryNotPossible: (p: { said: string; max: number }) => `${p.said} was not possible: the request budget (${p.max} per shop) is used up`,
  retryFailed: (p: { said: string; failed: string }) => `${p.said}: failed (${p.failed})`,
  redirectRobots: (p: { url: string }) => `redirected to ${p.url}, which robots.txt disallows`,
  redirectOffsite: (p: { url: string }) => `redirected off-site to ${p.url}`,
  budgetUsedUp: (p: { max: number }) => `the request budget (${p.max} per shop) is used up`,
  shopSearchPrefix: (p: { detail: string }) => `shop search: ${p.detail}`,
  webNotTried: (p: { first: string; max: number }) => `${p.first}; the web search route was not tried: the request budget (${p.max} per shop) is used up`,
  webCouldNotTry: (p: { first: string; reason: string }) => `${p.first}; the web search route could not be tried: ${p.reason}`,
  webSearchPrefix: (p: { provider: string; detail: string }) => `${p.provider} web search: ${p.detail}`,
  foundBySecond: (p: { detail: string; first: string; web: string }) =>
    `${p.detail}, found by the web search after the shop search found nothing matching (both routes tried; ${p.first}; ${p.web})`,
  bothNothing: (p: { first: string; web: string }) => `both routes tried, nothing matching: ${p.first}; ${p.web}`,

  // totals.ts: delivery and pickup notes
  noDelivery: () => 'does not deliver to Slovakia',
  cheapestOf: (p: { n: number; country: string }) => `cheapest of ${p.n} delivery options to ${p.country} in the product data`,
  productDataDelivery: (p: { country: string }) => `product data: delivery to ${p.country}`,
  freeFrom: (p: { amount: number; currency: string; checked?: string }) =>
    `free from ${p.amount} ${p.currency} (shop's delivery page${p.checked ? `, checked ${p.checked}` : ''})`,
  shopMethod: (p: { method?: string; checked?: string }) => `${p.method ?? 'standard delivery'} (shop's delivery page${p.checked ? `, checked ${p.checked}` : ''})`,
  freeOnlyFrom: (p: { amount: number; currency: string }) => `free only from ${p.amount} ${p.currency}; price below that unknown`,
  shippingOnlyFor: (p: { other: string; country: string }) => `product data gives shipping only for ${p.other}, not ${p.country}`,
  shippingUnknown: () => 'shipping to SK unknown',
  pickupFree: () => 'pickup in the branch: free',
  pickupPrice: (p: { amount: number; currency: string }) => `pickup in the branch: ${p.amount} ${p.currency}`,
  noPickup: () => 'no pickup in the branch',
  pickupUnknown: () => 'pickup terms unknown',
  // totals.ts: headlineText
  noPriceReachesSk: () => 'no price that reaches Slovakia',
  fromPrice: (p: { price: string; shippingUnknown: boolean }) => `from ${p.price}${p.shippingUnknown ? ' + shipping?' : ''}`,
  cheapestKnownTotal: (p: { price: string; shop: string | null; pickup: boolean }) => `cheapest known total ${p.price} (${p.shop}${p.pickup ? ', pickup' : ''})`,
  noKnownTotal: () => 'no known total',

  // group.ts: product notes and variant labels
  noDeliveryOffers: (p: { n: number }) => `${p.n} offer${p.n > 1 ? 's' : ''} from shops that do not deliver to Slovakia (not ranked)`,
  gtinCount: (p: { n: number }) => `${p.n} GTIN${p.n > 1 ? 's' : ''}`,
  somePossible: () => 'some offers only possibly match: check them',
  someByName: () => 'some offers grouped by name only (no GTIN)',
  allByName: () => 'grouped by name only (no GTIN)',
  colourNotStated: () => 'colour not stated',

  // report.ts: the status summary line
  sumOk: (p: { n: number }) => `${p.n} found`,
  sumNoMatch: (p: { n: number }) => `${p.n} no match`,
  sumBlocked: (p: { n: number }) => `${p.n} blocked`,
  sumNeedsJs: (p: { n: number }) => `${p.n} need${p.n === 1 ? 's' : ''} a browser`,
  sumNeedsKey: (p: { n: number }) => `${p.n} need${p.n === 1 ? 's' : ''} a search key`,
  sumRobots: (p: { n: number }) => `${p.n} disallowed by robots.txt`,
  sumNoRoute: (p: { n: number }) => `${p.n} no automatic route`,
  sumError: (p: { n: number }) => `${p.n} error${p.n === 1 ? '' : 's'}`,
  sumNotRelevant: (p: { n: number }) => `${p.n} not asked (not relevant)`,
  sumNotStored: (p: { n: number }) => `${p.n} not stored`,
  // The local database (History)
  notStored: () => 'nothing stored for this search yet; check online to ask this shop',
  fromLocal: (p: { n: number; date: string }) => `from the local database: ${p.n} product page${p.n === 1 ? '' : 's'}, read ${p.date}`,
  storedNothing: (p: { date: string }) => `last checked ${p.date}: nothing matching was found`,
  storedStatus: (p: { date: string }) => `last checked ${p.date}`,
  localDatabase: () => 'local database',
  webReused: (p: { n: number; date: string }) => `the web search of ${p.date} found ${p.n} matching page${p.n === 1 ? '' : 's'}; read again now for current prices, without a new web search`,
  webNothingReused: (p: { date: string }) => `the web search of ${p.date} found nothing matching; not repeated (search the web again to repeat it)`,
};

export type MessageKey = keyof typeof en;
type Catalogue = { [K in MessageKey]: (typeof en)[K] };

const ponuka = (n: number) => pluralSk(n, 'ponuka', 'ponuky', 'ponúk');
const vysledok = (n: number) => pluralSk(n, 'výsledok', 'výsledky', 'výsledkov');
const checkedSk = (c?: string) => (c ? `, overené ${date('sk', c)}` : '');
const delivery = (country: string) => (country === 'SK' ? 'na Slovensko' : `do krajiny ${country}`);

const sk: Catalogue = {
  rejectedLink: () => 'Tento odkaz neobsahuje názov produktu, preto sa nič nehľadalo. Zadajte alebo vložte namiesto neho názov produktu.',
  notRelevant: (p) => `mimo výberu: kategórie obchodu (${p.cats}) nezodpovedajú hľadaniu (${p.label})`,
  internalError: (p) => `vnútorná chyba: ${p.msg}`,
  pageFailedCached: (p) => `${p.url}: HTTP ${p.status} (z vyrovnávacej pamäte)`,
  noWebPages: () => 'webové vyhľadávanie nenašlo na tejto doméne žiadne stránky',
  noShopProducts: () => 'vyhľadávanie obchodu nevrátilo žiadne produkty',
  noneMatching: (p) => `${p.n} ${vysledok(p.n)}, žiadny nezodpovedá hľadaniu (najbližší: ${q(p.best)})`,
  blockedProductPage: (p) => `stránka produktu je chránená proti robotom (${p.vendor}); obchod na hodinu vynechávame`,
  blockedOnUrl: (p) => `ochrana proti robotom na ${p.url}`,
  budgetReached: (p) => `dosiahnutý limit požiadaviek (${p.max} na obchod)`,
  alreadyReadPages: (p) => `znova sa nečítali stránky, ktoré toto hľadanie už prečítalo (tá istá stránka pod iným odkazom): ${p.n}`,
  zeroPriced: (p) => `vynechané ponuky s cenou 0 (vypredané?): ${p.n}`,
  okOffers: (p) => `${p.n} ${pluralSk(p.n, 'zodpovedajúca ponuka', 'zodpovedajúce ponuky', 'zodpovedajúcich ponúk')}: presne ${p.exact}, možno ${p.possible}`,
  pagesNotProduct: (p) => `načítané stránky bez údajov schema.org Product: ${p.n}; stránky produktov tohto obchodu ich majú, takže pravdepodobne nešlo o stránky produktov`,
  pagesNeedJs: (p) => `načítané stránky bez údajov schema.org Product: ${p.n}; ceny pravdepodobne zobrazuje až JavaScript`,
  robotsCandidates: () => 'robots.txt nepovoľuje nájdené stránky produktov',
  alreadyReadMatching: () => 'zodpovedajúce stránky toto hľadanie už prečítalo',
  noPageRead: () => 'nepodarilo sa načítať žiadnu stránku produktu',
  offersNoneMatching: (p) => `${p.offers} ${ponuka(p.offers)} na ${p.pages} ${pluralSk(p.pages, 'stránke', 'stránkach', 'stránkach')}, žiadna nezodpovedá hľadaniu`,
  needsJs: () => 'ceny sa v tomto obchode zobrazia až po spustení JavaScriptu; nenačítava sa (otvorte si odkaz na obchod)',
  noSchema: () => 'stránky produktov neobsahujú údaje schema.org; nenačítava sa (otvorte si odkaz na obchod)',
  notAsked: (p) => `nepýtali sme sa: ${p.reason}`,
  defaultUnreachable: () => 'web odpovedá jednoduchému klientovi chybami',
  blockedCached: (p) => `ochrana proti robotom (${p.vendor}) zistená ${p.at}; obchod na hodinu vynechávame`,
  searchedAs: (p) => `hľadané ako ${q(p.sent)}: výraz bez kategórie, farby a všeobecných slov, pre obchod v inej krajine`,
  blockedRobots: (p) => `ochrana proti robotom (${p.vendor}) na robots.txt; obchod na hodinu vynechávame`,
  budgetRobots: () => 'limit požiadaviek sa minul už pri čítaní robots.txt',
  robotsSearch: (p) => `robots.txt nepovoľuje stránku vyhľadávania obchodu${p.note ? ` (${p.note})` : ''}`,
  blockedSearch: (p) => `ochrana proti robotom (${p.vendor}) na stránke vyhľadávania; obchod na hodinu vynechávame`,
  searchRedirectRobots: (p) => `vyhľadávanie presmerovalo na ${p.url}, čo robots.txt nepovoľuje`,
  searchOffsite: (p) => `vyhľadávanie presmerovalo na iný web: ${p.url}`,
  searchFailed: (p) => `stránka vyhľadávania zlyhala: ${p.why}${p.guess ? ' (adresa vyhľadávania je odhad a nemusí byť správna)' : ''}`,
  noItemList: () => 'stránka vyhľadávania nemá JSON-LD ItemList; výsledky sú vybrané z odkazov',
  noProvider: (p) => `${p.why}nie je k dispozícii žiadna služba webového vyhľadávania: ${p.reason}`,
  webFailed: (p) => `webové vyhľadávanie zlyhalo: ${p.error}`,
  foundVia: (p) => `nájdené cez webové vyhľadávanie ${p.provider}`,
  setKey: (p) => `${p.notes}; nastavte SERPER_API_KEY alebo BRAVE_API_KEY, aby sa stránky produktov dali nájsť cez webové vyhľadávanie`,
  noRoute: (p) => `${p.reason}; s kľúčom webového vyhľadávania (BRAVE_API_KEY alebo SERPER_API_KEY) by ho aplikácia vedela prehľadať`,
  defaultNoSearchUrl: () => 'adresa vyhľadávania tohto obchodu nie je známa',
  candidatesFromCache: () => 'výsledky vyhľadávania z vyrovnávacej pamäte',
  retrySaid: (p) => `vyhľadávanie obchodu nevrátilo pre ${q(p.sent)} žiadne produkty; zopakované ako ${q(p.shorter)} (bez kategórie, farby, všeobecných slov a slov o balení)`,
  results: (p) => `${p.n} ${vysledok(p.n)}`,
  fromCacheSuffix: () => ' (z vyrovnávacej pamäte)',
  retryNotPossible: (p) => `${p.said}: opakovanie nebolo možné, limit požiadaviek (${p.max} na obchod) je vyčerpaný`,
  retryFailed: (p) => `${p.said}: zlyhalo (${p.failed})`,
  redirectRobots: (p) => `presmerované na ${p.url}, čo robots.txt nepovoľuje`,
  redirectOffsite: (p) => `presmerované na iný web: ${p.url}`,
  budgetUsedUp: (p) => `limit požiadaviek (${p.max} na obchod) je vyčerpaný`,
  shopSearchPrefix: (p) => `vyhľadávanie obchodu: ${p.detail}`,
  webNotTried: (p) => `${p.first}; webové vyhľadávanie sa neskúsilo: limit požiadaviek (${p.max} na obchod) je vyčerpaný`,
  webCouldNotTry: (p) => `${p.first}; webové vyhľadávanie sa nedalo skúsiť: ${p.reason}`,
  webSearchPrefix: (p) => `webové vyhľadávanie ${p.provider}: ${p.detail}`,
  foundBySecond: (p) => `${p.detail}; nájdené webovým vyhľadávaním, keď vyhľadávanie obchodu nenašlo nič zodpovedajúce (skúsili sme oba spôsoby; ${p.first}; ${p.web})`,
  bothNothing: (p) => `skúsili sme oba spôsoby, nič nezodpovedá: ${p.first}; ${p.web}`,

  noDelivery: () => 'nedoručuje na Slovensko',
  cheapestOf: (p) => `najlacnejšia z ${p.n} možností doručenia ${delivery(p.country)} podľa údajov produktu`,
  productDataDelivery: (p) => `podľa údajov produktu: doručenie ${delivery(p.country)}`,
  freeFrom: (p) => `zadarmo od ${money('sk', p.amount, p.currency)} (stránka obchodu o doprave${checkedSk(p.checked)})`,
  shopMethod: (p) => `${p.method ?? 'štandardné doručenie'} (stránka obchodu o doprave${checkedSk(p.checked)})`,
  freeOnlyFrom: (p) => `zadarmo až od ${money('sk', p.amount, p.currency)}; cena pod touto hranicou nie je známa`,
  shippingOnlyFor: (p) => `údaje produktu uvádzajú dopravu len pre ${p.other}, nie pre ${p.country}`,
  shippingUnknown: () => 'doprava na Slovensko nie je známa',
  pickupFree: () => 'osobný odber v predajni: zadarmo',
  pickupPrice: (p) => `osobný odber v predajni: ${money('sk', p.amount, p.currency)}`,
  noPickup: () => 'osobný odber v predajni nie je možný',
  pickupUnknown: () => 'podmienky osobného odberu nie sú známe',
  noPriceReachesSk: () => 'žiadna cena s doručením na Slovensko',
  fromPrice: (p) => `od ${p.price}${p.shippingUnknown ? ' + doprava?' : ''}`,
  cheapestKnownTotal: (p) => `najnižšia známa cena spolu ${p.price} (${p.shop}${p.pickup ? ', osobný odber' : ''})`,
  noKnownTotal: () => 'cena spolu nie je známa',

  noDeliveryOffers: (p) => `${p.n} ${ponuka(p.n)} z obchodov, ktoré nedoručujú na Slovensko (mimo poradia)`,
  gtinCount: (p) => `${p.n} ${pluralSk(p.n, 'kód', 'kódy', 'kódov')} GTIN`,
  somePossible: () => 'niektoré ponuky sa zhodujú len možno: overte ich',
  someByName: () => 'niektoré ponuky sú zoskupené len podľa názvu (bez GTIN)',
  allByName: () => 'zoskupené len podľa názvu (bez GTIN)',
  colourNotStated: () => 'farba neuvedená',

  sumOk: (p) => `${p.n} ${pluralSk(p.n, 'nájdený', 'nájdené', 'nájdených')}`,
  sumNoMatch: (p) => `${p.n} bez zhody`,
  sumBlocked: (p) => `${p.n} ${pluralSk(p.n, 'blokovaný', 'blokované', 'blokovaných')}`,
  sumNeedsJs: (p) => `${p.n} ${pluralSk(p.n, 'vyžaduje', 'vyžadujú', 'vyžaduje')} prehliadač`,
  sumNeedsKey: (p) => `${p.n} bez kľúča vyhľadávania`,
  sumRobots: (p) => `${p.n} s obmedzením v robots.txt`,
  sumNoRoute: (p) => `${p.n} bez automatického hľadania`,
  sumError: (p) => `${p.n} ${pluralSk(p.n, 'chyba', 'chyby', 'chýb')}`,
  sumNotRelevant: (p) => `${p.n} mimo výberu (iný sortiment)`,
  sumNotStored: (p) => `${p.n} ${pluralSk(p.n, 'neuložený', 'neuložené', 'neuložených')}`,
  notStored: () => 'pre toto hľadanie zatiaľ nie je nič uložené; tento obchod sa opýta pri overení online',
  fromLocal: (p) => `z lokálnej databázy: ${p.n} ${pluralSk(p.n, 'stránka produktu', 'stránky produktu', 'stránok produktu')}, načítané ${p.date}`,
  storedNothing: (p) => `naposledy overené ${p.date}: nič zodpovedajúce sa nenašlo`,
  storedStatus: (p) => `naposledy overené ${p.date}`,
  localDatabase: () => 'lokálna databáza',
  webReused: (p) => `webové vyhľadávanie z ${p.date} našlo ${p.n} ${pluralSk(p.n, 'zodpovedajúcu stránku', 'zodpovedajúce stránky', 'zodpovedajúcich stránok')}; teraz znova načítané kvôli aktuálnym cenám, bez nového webového vyhľadávania`,
  webNothingReused: (p) => `webové vyhľadávanie z ${p.date} nenašlo nič zodpovedajúce; neopakuje sa (opakujete ho voľbou „Hľadať znova aj na webe“)`,
};

const CATALOGUES: Record<Lang, Catalogue> = { en, sk };

/** The message `key` in `lang`, with its parameters. */
export function t<K extends MessageKey>(lang: Lang, key: K, ...params: Parameters<(typeof en)[K]>): string {
  const f = CATALOGUES[lang][key] as (...a: unknown[]) => string;
  return f(...params);
}

/** The keys of each language's catalogue (for the test that both have the same). */
export function catalogueKeys(lang: Lang): string[] {
  return Object.keys(CATALOGUES[lang]).sort();
}

// ---- the matcher's reasons (types.ts, MatchReason) -------------------------------------------------
// English is what MatchResult.reasons has always said; matcher.ts builds those strings from here. The
// page has the same texts in public/i18n.js (`matchReason`); a test checks that both agree.

type ReasonTexts = { [R in MatchReason as R['code']]: (p: R['params']) => string };
const qe = (xs: string[]) => xs.map((x) => `"${x}"`).join(', ');
const qs = (xs: string[]) => xs.map(q).join(', ');
const CONDITION_SK: Record<string, string> = { used: 'použitý', refurbished: 'repasovaný', damaged: 'poškodený', unknown_used: 'rozbalený / vystavený kus' };

const REASONS: Record<Lang, ReasonTexts> = {
  en: {
    codeStart: (p) => `"${p.token}" found only as the start of "${p.title}"`,
    nearSpelling: (p) => `"${p.token}" ~ "${p.title}"`,
    condition: (p) => `condition: ${p.condition}${p.words.length ? ` (${p.words.join(', ')})` : ''}`,
    insteadOf: (p) => `title has "${p.instead}" where the query has "${p.token}"`,
    titleLacks: (p) => `title lacks ${qe(p.words)}`,
    titleHas: (p) => `title has ${qe(p.words)} that the query lacks`,
    sameOrOlder: (p) => `title says "${p.before} ${p.after}" without "${p.token}": the same model or an older one`,
    variantNotInQuery: (p) => `variant ${p.words.join(', ')} not in the query`,
    extraWords: (p) => `check extra words: ${p.words.join(', ')}`,
  },
  sk: {
    codeStart: (p) => `${q(p.token)} sa našlo len ako začiatok ${q(p.title)}`,
    nearSpelling: (p) => `${q(p.token)} ~ ${q(p.title)} (podobný zápis)`,
    condition: (p) => `stav: ${CONDITION_SK[p.condition] ?? p.condition}${p.words.length ? ` (${p.words.join(', ')})` : ''}`,
    insteadOf: (p) => `v názve je ${q(p.instead)} namiesto ${q(p.token)}`,
    titleLacks: (p) => `v názve chýba ${qs(p.words)}`,
    titleHas: (p) => `v názve je navyše ${qs(p.words)}`,
    sameOrOlder: (p) => `v názve je ${q(`${p.before} ${p.after}`)} bez ${q(p.token)}: ten istý model alebo starší`,
    variantNotInQuery: (p) => `variant ${p.words.join(', ')} nie je v hľadanom výraze`,
    extraWords: (p) => `overte ďalšie slová: ${p.words.join(', ')}`,
  },
};

/** One matcher reason in `lang`. */
export function reasonText(lang: Lang, r: MatchReason): string {
  return (REASONS[lang][r.code] as (p: MatchReason['params']) => string)(r.params);
}

/** The reason codes each language has (for the test that both have all of them). */
export function reasonCodes(lang: Lang): string[] {
  return Object.keys(REASONS[lang]).sort();
}

// ---- Slovak (or other) versions of the free-text notes in data/shops.yaml ---------------------------

/** The free-text fields of one shop that the page can show, in another language (data/shops.sk.yaml). */
export interface ShopTextFields {
  no_route_reason?: string;
  shipping_to_sk?: { method?: string };
}

/** Per language, per shop id. A missing language, shop or field means the English text is shown. */
export type ShopTexts = Partial<Record<Lang, Record<string, ShopTextFields>>>;

/** The shop with its shown notes in `lang` where a translation exists; otherwise the shop unchanged. */
export function localizeShop(shop: Shop, lang: Lang, texts?: ShopTexts): Shop {
  const tr = lang === 'en' ? undefined : texts?.[lang]?.[shop.id];
  if (!tr) return shop;
  const out: Shop = { ...shop };
  if (tr.no_route_reason && shop.no_route_reason) out.no_route_reason = tr.no_route_reason;
  if (tr.shipping_to_sk?.method && shop.shipping_to_sk?.method) out.shipping_to_sk = { ...shop.shipping_to_sk, method: tr.shipping_to_sk.method };
  return out;
}
