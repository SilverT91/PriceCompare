# PriceCompare

A local tool that compares the price of one non-food product across shops with a branch in your
city (Košice, Slovakia, for now) and web shops that deliver to Slovakia.

The point is to show **the right product** and to be **honest about what could not be checked**.
The same model is often sold in several colours, bundles and package sizes, so PriceCompare groups
offers into distinct products first ("Which one do you mean?"), then compares only the one you
pick. Every shop gets an explicit status, with a link to search the shop by hand when it could not
be checked automatically.

This is a small personal tool with a narrow focus: one product, one city, a short list of shops.
It is not a replacement for the established price comparison services, which cover far more shops
and products; it links to one of them for every search.

Status: first working version (2026-11). Coverage is partial on purpose; see "Coverage" below.

## What it does

0. **Chooses which shops to ask.** By default ("Auto") the likely categories are guessed from brand
   and product words in the query (Slovak, Czech, German, Polish, English; `src/core/categories.ts`)
   and only shops whose `categories` fit are asked: a toothbrush query does not go to IKEA or a
   bookshop. Shops with `general` (marketplaces) are always asked. With no hint, all shops are asked.
   The page and the command line show which categories were used, with a one-click way (or
   `--cat all`) to search all shops. Shops left out get `not_relevant`, cost nothing and are not
   failures.
1. **Finds candidate product pages** at each shop that is asked, in parallel:
   - the shop's own search page, when it has a search URL template and robots.txt allows it
     (candidates from a JSON-LD `ItemList`, otherwise from product links in the HTML);
   - otherwise a web search restricted to the shop's domain (`site:`), through Brave Search or
     Serper.dev, when a key is set;
   - otherwise nothing, and the shop says so.
2. **Scores the candidates** against the query and reads at most the best 3 product pages per shop,
   extracting offers from schema.org JSON-LD (`Product`, `ProductGroup` with `hasVariant`, `Offer`,
   `AggregateOffer`).
3. **Matches and groups** offers into distinct products: by normalised GTIN, by manufacturer order
   code, otherwise by a signature of the brand/model tokens. Used, refurbished and unpacked items
   are flagged and never grouped with new ones; colour variants of one model sit side by side.
4. **Totals** per offer, converted to EUR with ECB reference rates (Frankfurter API):
   - delivery to Slovakia: from the product's JSON-LD `shippingDetails` when it applies to SK, else
     from `shipping_to_sk` in `shops.yaml` (cheapest standard delivery and free-delivery threshold,
     read from the shop's delivery page, with source and date);
   - pickup in the Košice branch (`pickup_kosice`): shown in the "Shops with a branch in Košice"
     section as the pickup total (the item price when pickup is free);
   - a shop that does not deliver to Slovakia (`ships_to_sk: false`) keeps its offers visible,
     marked "does not deliver to Slovakia" and outside the ranking.
   Unknown shipping is shown as unknown, never as zero; offers with a known total come first.
   The product's headline shows the **cheapest item price** ("+ shipping?" when its shipping is
   unknown) and, separately, the **cheapest known total**.
5. Splits the comparison into **"Shops with a branch in Košice"** and **"Web shops"**.
6. Streams each shop's result to the page as soon as that shop is done (Server-Sent Events). The
   page shows the products and the comparison first, then "Not checked automatically: open these
   yourself" (manual links of the relevant shops that could not be checked, and Heureka), then the
   per-shop statuses collapsed to one line ("6 found, 7 blocked, 1 needs a browser, ...").

Every shop ends with one status:

| status | meaning |
|---|---|
| `ok` | at least one offer that matches or possibly matches |
| `no_match` | the shop was searched; nothing matching the query |
| `blocked` | bot protection answered (Cloudflare, DataDome, ...); the shop is skipped for an hour |
| `robots_disallowed` | robots.txt disallows the pages that would be needed |
| `needs_js` | prices only appear after JavaScript runs; not fetched |
| `needs_search_key` | the shop's search is disallowed and no web search provider is usable (no key, or its credit is used up; the reason is shown) |
| `no_route` | no search URL and no key (the reason is shown, e.g. Teta's ASP.NET search form), the shop publishes no structured data (Amazon.de), or the site answers every page with an error (OBI, notebooksbilliger.de) |
| `error` | anything else (timeout, unexpected HTTP status, ...) |
| `not_relevant` | not asked: the shop's categories do not fit the query (no request, not a failure) |

Shops without an offer that have a search template get a **manual link** (the shop's own search URL
for your query). There is always a manual link to **Heureka.sk** as well; the app never fetches
Heureka itself, because its terms and robots.txt do not allow it.

## Install and run

Needs Node.js 26 (TypeScript runs directly, no build step) and npm.

```sh
npm install
npm test                                   # unit tests, no network
npm run search -- "Oral-B Pro 3 3000"      # command line, prints the tables
npm start                                  # web page on http://localhost:8787
```

Command line options:

```
npm run search -- "iPhone 16 128GB" --pick 2          # compare product #2 of the list
npm run search -- "..." --cat all                     # ask all shops (default auto; or electronics, tools, health, home, books)
npm run search -- "Bosch GSR 12V-15" --shops nay_sk,hornbach_sk
npm run search -- "..." --providers serper,brave      # provider order for this run ("none" = off)
npm run search -- "..." --site-search per-shop        # one web query per shop instead of combined
npm run search -- "..." --json                        # raw results
```

`npm run typecheck` runs `tsc` (dev dependency) over the code; Node itself only strips types.

Data is cached in SQLite at `.cache/price-compare.sqlite` (git-ignored): extracted offers and search
candidates 6 hours, web search results 6 hours, robots.txt 24 hours, exchange rates 24 hours,
"blocked" marks 1 hour, plus the search history and a log of web search API calls. Page bodies are
never stored. Delete the file to start fresh.

## Web search keys

Without a key, shops whose own search page robots.txt disallows end as `needs_search_key`.
Copy `.env.example` to `.env` (git-ignored) and set one or both keys:

```
BRAVE_API_KEY=...       # https://brave.com/search/api/  (monthly free credit, about 1 request/s)
SERPER_API_KEY=...      # https://serper.dev/            (one-time free credit)
SEARCH_PROVIDERS=brave,serper
```

The first provider in `SEARCH_PROVIDERS` (default `brave,serper`) is used; when it reports used-up
credit (Brave: HTTP 402) or a rejected key, it is marked unusable (Brave until the next month,
Serper for 30 days; the mark lives in the SQLite cache) and the next one takes over. If none is
usable, the affected shops get `needs_search_key` with the reason. Key values are never printed or
logged.

To use few queries, the domains of several shops go into one query
(`Oral-B Pro 3 3000 site:a.sk OR site:b.sk ...`, up to 6 per query), grouped by shop country so the
country/language parameters fit (Serper `gl`/`hl`: sk/sk, cz/cs, de/de, at/de, pl/pl; Brave
`country` + `search_lang`, with `country=ALL` for SK and CZ, which Brave's country list lacks).
One full product search costs about 4-5 queries. Serper's free account refuses more than 10 results
per query ("Query pattern not allowed for free accounts"), so a combined Serper query returns 10
results for all its domains.

### Measurement behind the default order (2026-11-24)

Twelve shops take the web-search route (their search page is disallowed by robots.txt or unknown).
For "Oral-B Pro 3 3000", "iPhone 16 128GB" and "Bosch GSR 12V-15", the number of those shops where
the search returned a product page of the right product, confirmed from the page's own JSON-LD
(in brackets: shops that ended with a priced offer; Datart lists sold-out items with price 0):

| provider, mode | Oral-B | iPhone | Bosch | queries per product search |
|---|---|---|---|---|
| Serper, combined (6 domains/query) | 2 (1) | 3 (3) | 2 (1) | 4-5 |
| Serper, one query per shop | 2 (1) | 3 (3) | 2 (1) | 11 |
| Brave, combined | 2 (1) | 3 (3) | 2 (1) | 4-5 |
| Brave, one query per shop | 2 (1) | 3 (3) | 2 (1) | 11 |

The same shops were found by both (Datart.cz, Morele.net, and iStores.sk for the iPhone), though not
always the same pages; Oral-B matches are only "possible" (the shops name a head type such as
CrossAction). No Slovak drugstore, DIY or furniture shop on the list returned a matching page with
either provider (some do not sell these products), and MediaMarkt.at's product pages were blocked by
Cloudflare. Brave returns up to 20 results per query against Serper's 10, but for Slovak shops many
of Brave's are unrelated pages of the domain. Combined queries were as good as one query per shop,
at less than half the cost. Small sample: 3 products, 12 shops. With equal results Brave goes first
because its free credit renews every month; Serper is the fallback. Run
`node tools/measure_site_search.ts --providers brave --mode combined "query" ...` to measure again
(responses are cached, so repeating within 6 hours costs no queries).

## Adding a shop

Add an entry to `data/shops.yaml` (field notes are at the top of the file):

```yaml
  - id: example_sk
    name: Example
    country: SK
    domain: example.sk
    kind: webshop                 # or local_chain
    categories: [electronics]
    currency: EUR
    has_kosice_branch: unknown    # true needs has_kosice_branch_source
    ships_to_sk: true
    search_url_template: "https://www.example.sk/hladat?q={query}"   # or null
    search_template_basis: form
    shipping_to_sk: null          # or {price: 3.99, currency: EUR, free_from: 50, source: <url>, checked: <date>}
    in_scope: true
```

Then run a search with `--shops example_sk` and check its status. Useful extra fields:
`needs_js: true` (prices only rendered by JavaScript), `structured_data: false` (no schema.org data),
`no_route_reason` and `unreachable: true` (no search URL / site unusable, with the reason shown),
`ships_to_sk_source`, `pickup_kosice: {available, price, currency, note, source, checked}` for shops
with a Košice branch, `accept_language`, `link_exclude_regex`. Set `categories` carefully: they decide
which queries ask the shop. `branches: []` is reserved for per-branch data later.
`node tools/fetch_info.ts <domain> <url> --links | --grep "regex" | --forms` reads a shop's delivery
page or homepage under the request rules to fill these in.

## Rules for every outgoing request

These override coverage:

- robots.txt is honoured for every URL, including every redirect hop (RFC 9309: our product token
  `price-compare` or `*`; longest match wins; a 5xx or unreachable robots.txt means "disallow all").
  A disallowed URL is never fetched.
- At least 3 seconds between requests to the same host (also across separate command-line runs,
  through the SQLite clock), at most 6 requests per shop per search (robots.txt and redirects count),
  a 15-second timeout, and no retries at all (so none on 403 or 429).
- A plain, generic User-Agent: `price-compare/0.1`. No cookies, no personal or repository data.
- No getting around bot protection: no proxies, no browser impersonation, no headless browser, no
  CAPTCHA handling. A blocked shop gets status `blocked`, is skipped for an hour, and the user gets
  the manual link. `needs_js` shops get the manual link.
- Heureka is never fetched. Redirects to another site are not followed.

## Code layout

```
src/core/          portable core: only fetch, URL, AbortSignal, TextDecoder (+ cheerio for HTML links)
  types.ts           shop, offer, status, cache interface
  shops.ts           shops.yaml validation, search URLs, manual links, locations
  http.ts            polite fetcher: robots per hop, per-host spacing, budget, timeouts, bot walls
  robots.ts          robots.txt (RFC 9309)        botwall.ts  challenge-page detection
  jsonld.ts          JSON-LD extraction (Product, ProductGroup, Offer, AggregateOffer, ItemList)
  links.ts           product links from search pages without an ItemList
  gtin.ts            GTIN normalisation (UPC-A / EAN-13 / GTIN-14 / ISBN -> one 14-digit form)
  text.ts, vocab.ts  tokenizer and word lists (sk/cs/de/pl/en)
  matcher.ts         query vs title: exact / possible / different, condition, colour, signature
  group.ts           distinct products and their variants
  totals.ts, rates.ts  shipping, EUR conversion (Frankfurter, ECB)
  search/            web search providers (Brave, Serper), fallback chain, site: batching
  categories.ts      which shops to ask (category guess from the query)
  report.ts          status summary line and the "open these yourself" list
  pipeline.ts        the search: relevant shops in parallel, events as they finish
src/app.ts         HTTP API (Hono), portable: GET /api/search streams SSE
src/node/          Node-only: SQLite store (node:sqlite), .env, shops.yaml, server, CLI
public/            plain HTML/CSS/JS page (works from 380 px wide; offer tables become cards on narrow screens)
test/              node:test unit tests; fixtures are trimmed JSON-LD blocks, not whole pages
tools/             probe_shops.py (feasibility probe), extract_fixtures.ts, measure_site_search.ts,
                   fetch_info.ts (reads a shop's delivery/pickup/homepage under the request rules)
```

## Coverage and cost (measured 2026-11-24, no guarantees)

Of 30 in-scope shops, on that day 9 were `blocked` by bot protection (Alza.sk, Alza.cz, Conrad,
Notino, Sconto, x-kom, Allegro, MediaMarkt.de, MediaMarkt.at; blocking varies between runs),
2 `needs_js` (Planeo, dm), and 3 had no automatic route (Amazon.de; OBI and notebooksbilliger.de
answer every page with HTTP 404). With "Auto" categories a search asked 17-23 shops instead of 30.

One fresh search (robots.txt cached, blocked shops inside their one-hour skip):

| query | before (all 30 shops) | after (Auto categories) |
|---|---|---|
| Oral-B Pro 3 3000 | 30 shops, 14 requests, 4 web queries | 23 shops, 10 requests, 3 web queries |
| iPhone 16 128GB | 30 shops, 29 requests, 4 web queries | 17 shops, 24 requests, 3 web queries |
| Bosch GSR 12V-15 | 30 shops, 13 requests, 4 web queries | 20 shops, 10 requests, 3 web queries |

When the blocked shops' hour has passed, each blocked shop that is asked costs one more request
(robots.txt) before it is skipped again.

Delivery and pickup facts in `shops.yaml` (read 2026-11-24 from the shops' own pages, sources in the
file): NAY (pickup free, delivery from 1.99 €), Mountfield (pickup 1 €, delivery 2.50 €, free from
80 €), Hornbach (free from 99 €, below unknown; pickup terms not readable), Andreashop (2.99 €),
iStores (2.98 €, free from 50 €), Pilulka (1.49 €, free from 29 €). Datart.cz does not deliver abroad;
Morele.net ships abroad only to companies with a VAT number. Unknown: Dr.Max (blocked), Mironet.cz
(no mention of Slovakia), MediaMarkt.de/.at (blocked), 101 Drogerie (no delivery page found).

## More documentation

- [docs/roadmap.md](docs/roadmap.md): current state, next steps, known problems.
- [docs/decisions.md](docs/decisions.md): the choices made and why.
- [docs/research.md](docs/research.md): market research, data sources, the shop probe.
- [docs/architecture.md](docs/architecture.md): how the code is organised.
