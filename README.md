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

0. **Reads the query the way people type it.**
   - A brand typed with one wrong, missing or extra letter is searched as the brand ("Iral b io9"
     as "Oral-B io9", "Bosh" as "Bosch"). The page and the command line say so: `Searched for
     "Oral-B io9 doublepack" (you typed "Iral b io9 doublepack")`, with a link (or `--as-typed`) to
     search exactly as typed. Only brands of five or more letters are corrected, and never a word
     the app knows.
   - A model number written together with its line matches the shops' spelling: "io9" finds
     "iO Series 9" and "iO 9", and the other way round.
   - The words for a pack of two mean the same thing: duo, duopack, duo pack, doublepack, double
     pack, twin pack, Doppelpack, dvojbalenie. "Súprava ... Duo Pack" and "Duo, 2 ks" are that
     same pack. A pack of two is still a different product from the single item.
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
   - otherwise a web search restricted to the shop's domain (`site:`), through Brave Search,
     Serper.dev or Tavily, when a key is set;
   - otherwise nothing, and the shop says so.
   - **Once more without the package word:** when a shop's own search returns no products and the
     query has a package word ("doublepack", "set"), the shop's search is asked one more time
     without it ("Oral-B io9"). The results are still judged against the whole query, so a single
     brush is not offered for a duo pack. It is one request, inside the shop's limit of 6, and the
     shop's detail says it happened.
   - **Second route:** when the shop's own search ends with nothing matching (no products, no
     matching candidate, or pages read with no matching offer) and a web search provider is usable,
     the shop also tries the web search before it is reported as `no_match`. These fallback queries
     are batched across shops like the first ones (several `site:` domains per query). Both routes
     share the shop's limit of 6 requests, and a page read by the first route is not read again.
     Shops that ended `blocked`, `robots_disallowed`, `needs_js` or `not_relevant` do not get it. The
     shop's detail then says "both routes tried", and its route is shown as `both`.
   Click-tracking parameters (`srsltid`, `utm_*`, `gclid`, `gtmClickEvent`, Datart's `ltm_*` and
   similar) are removed from candidate links: they do not change the page, and some robots.txt files
   disallow URLs that carry them.
2. **Scores the candidates** against the query and reads at most the best 3 product pages per shop,
   extracting offers from schema.org JSON-LD (`Product`, `ProductGroup` with `hasVariant`, `Offer`,
   `AggregateOffer`). Review, comparison and manual pages ("Recenzia: ...", "Návod pro ...") are not
   taken as product candidates. When an offer's structured-data URL is the site root, the offer links
   to the page it was read from. One product page repeated under another link (a manual page, a copy
   with tracking parameters) gives one offer, not several.
3. **Matches and groups** offers into distinct products: by normalised GTIN, by manufacturer order
   code, otherwise by a signature of the brand/model tokens. Used, refurbished and unpacked items
   are flagged and never grouped with new ones; colour variants of one model sit side by side.
   At the same match level, a product with a price that reaches Slovakia is listed before one that
   no shop delivers.
   - **Similar models the shops list.** When a model is no longer on the shelves, shops still list
     its neighbours: for "Oral-B Pro 3 3000" the Pro 3 3500, the iO Series 3, the Pro 3 3900. The
     search already sees them among the candidates and pages the matcher rated as another product, so
     the app lists them (at most 8, closest first: the same line with another number, then the
     models most shops list) with a model name, how it differs from the query
     (`has "3500", lacks "3000"`), the shops that list it, and a "Compare this model" button that
     starts a new search for that name. Only models of the same brand and line count; accessories,
     review and manual pages, used items and the query's own model in a bundle do not. The same
     model written two ways ("Pro 3500" and "Pro 3 3500") is one entry. The list itself costs no
     shop requests and no web search queries (`src/core/nearby.ts`).
   - **A price for the closest similar models.** When no product matches exactly, the app reads one
     shop page for each of the first three models in that list (a shop with a branch in the city
     first) and shows the price with the shop, a link to the page and a warning sign: the price
     comes from one page and may not be the same product, so check it. It is a hint, not a
     comparison, and there is no price filter: a low price is shown as it is. This costs at most
     three shop requests per search, inside the limit of 6 requests per shop, and no web search
     queries.
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
   The name shown for a product comes from an offer you can get: a shop with a Košice branch first,
   then a shop that delivers to Slovakia; a shop that does not deliver only when there is no other.
5. Splits the comparison into **"Shops with a branch in Košice"** and **"Web shops"**.
6. Streams each shop's result to the page as soon as that shop is done (Server-Sent Events). The
   page shows the products and the comparison first (with the similar models: open when no shop
   lists exactly what you typed, collapsed below an exact match), then "Not checked automatically:
   open these yourself" (manual links of the relevant shops that could not be checked, and Heureka), then the
   per-shop statuses collapsed to one line ("6 found, 7 blocked, 1 needs a browser, ...").

Every shop ends with one status:

| status | meaning |
|---|---|
| `ok` | at least one offer that matches or possibly matches |
| `no_match` | the shop was searched (by both routes when the second route applied); nothing matching the query |
| `blocked` | bot protection answered (Cloudflare, DataDome, ...); the shop is skipped for an hour |
| `robots_disallowed` | robots.txt disallows the pages that would be needed |
| `needs_js` | either the shop is marked `needs_js: true` in `shops.yaml` and is not fetched, or its pages were fetched and none carried schema.org Product data, so the prices are probably rendered by JavaScript. The second case applies only to shops not known to publish that data: when the shop is marked `structured_data: true`, or one of its pages had Product data in the last 30 days, such pages are taken for non-product pages and the result is `no_match` (and the second route may follow) |
| `needs_search_key` | the shop's search is disallowed and no web search provider is usable (no key, or its credit is used up; the reason is shown) |
| `no_route` | no search URL and no key (the reason is shown, e.g. Teta's ASP.NET search form; with a key such shops use the web search), the shop publishes no structured data (Amazon.de), or the site answers every page with an error (OBI, notebooksbilliger.de) |
| `error` | anything else (timeout, unexpected HTTP status, ...) |
| `not_relevant` | not asked: the shop's categories do not fit the query (no request, not a failure) |

Each shop result also names its route: `shop_search` (the shop's own search page), `search_provider`
(web search), `both` (own search first, then web search) or `none`.

Shops without an offer that have a search template get a **manual link** (the shop's own search URL
for your query). There is always a manual link to **Heureka.sk** as well; the app never fetches
Heureka itself, because its terms and robots.txt do not allow it.

## Install on Windows, step by step

What you need: Windows 10 or 11 with `winget` (the "App Installer" from Microsoft, part of Windows
11 and of current Windows 10), an internet connection, and about 150 MB of free disk space for
Node.js and the app. The app runs on your own computer and is reachable only from it
(`127.0.0.1`); nothing is installed as a service.

1. Open **Command Prompt** (Start menu, type `cmd`).
2. Install Node.js 26 or newer (the app needs at least 26, because it runs TypeScript directly):

   ```
   winget install --id OpenJS.NodeJS.LTS -e
   ```

3. Install Git, to download the app and to update it later:

   ```
   winget install --id Git.Git -e
   ```

   Without Git: download the ZIP from the repository page on GitHub (Code, Download ZIP), unpack
   it, and skip the `git clone` line below.
4. **Close Command Prompt and open it again**, so the new programs are found. Check with
   `node --version`: it must print `v26` or higher.
5. Download the app and its four libraries:

   ```
   git clone https://github.com/SilverT91/PriceCompare.git
   cd PriceCompare
   npm install
   ```

6. Start it, and leave the window open while you use it:

   ```
   npm start
   ```

   Then open <http://localhost:8787> in your browser. Stop the app with Ctrl+C in the window.

Next time: open Command Prompt, `cd PriceCompare`, `npm start`. To update: `git pull`, then
`npm install`, then `npm start`.

If you use PowerShell instead of Command Prompt and it answers that "running scripts is disabled on
this system", type `npm.cmd` in place of `npm` (for example `npm.cmd start`).

The app works without any account. A free web search key makes it reach more shops; see
"Web search keys" below for where to get one (a table with the sign-up pages), what each choice
gives and how limited it is.

## Install and run (short form, any system)

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
npm run search -- "Iral b io9" --as-typed             # do not correct a brand typo
npm run search -- "..." --cat all                     # ask all shops (default auto; or electronics, tools, health, home, books)
npm run search -- "Bosch GSR 12V-15" --shops nay_sk,hornbach_sk
npm run search -- "..." --providers serper,brave      # provider order for this run ("none" = off)
npm run search -- "..." --site-search per-shop        # one web query per shop instead of combined
npm run search -- "..." --domains-per-query 4         # domains in one combined web query (default 6)
npm run search -- "..." --location kosice             # the city whose branches count as local (only kosice so far)
npm run search -- "..." --no-cache                    # ignore cached offers, candidates and web search results (they are still written)
npm run search -- "..." --width 200                   # table width in characters (default 160)
npm run search -- "..." --json                        # raw results
```

`--no-cache` does not bypass robots.txt rules, exchange rates or "blocked" marks, and a search with
it costs web search queries again.

`npm run typecheck` runs `tsc` (dev dependency) over the code; Node itself only strips types.

Data is cached in SQLite at `.cache/price-compare.sqlite` (git-ignored): extracted offers and search
candidates 6 hours, web search results 6 hours, robots.txt 24 hours, exchange rates 24 hours,
"blocked" marks 1 hour, plus the search history and a log of web search API calls. Page bodies are
never stored. Delete the file to start fresh.

## Web search keys

Some shops do not allow their own search page to be read automatically, and a few have none that
can be called. For those the app finds product pages through a web search API. That is the only
part of the app that needs an account somewhere, and it is optional.

### Where to get a key (checked on 2026-11-25)

| Provider | Sign up at | Free allowance | Payment card | Sign in with | Where the key is |
|---|---|---|---|---|---|
| Serper | <https://serper.dev/signup> | 2,500 queries, once | not needed | a Serper account: name, email, password | in the Serper dashboard after signing in |
| Tavily | <https://app.tavily.com> | 1,000 credits a month | not needed | Google, GitHub, LinkedIn or Microsoft account, or email | on the Tavily dashboard after signing in |
| Brave | <https://api-dashboard.search.brave.com/register> | 5 USD of credit a month, about 1,000 queries | asked for | Google or GitHub account, or email and password | first choose a plan in the dashboard, then create a key at <https://api-dashboard.search.brave.com/app/keys> |

Each key goes into the file `.env` (see "Setting a key" below). One key is enough; with several,
the app uses them in the order `brave,serper,tavily` and moves on when one runs out.

These offers change. The date in the heading is when the pages were last read; when you check
them again, update the table and the date. Not stated on the providers' pages that day: whether
Serper's 2,500 queries expire, and the exact place of the key in the Serper and Tavily
dashboards. The Tavily sign-in options are as seen at sign-up; its public pages do not list them.

### What each choice gives, and its limits

One product search needs about 5 to 7 web queries when nothing is cached; a repeat within 6 hours
needs none. The allowances below are from the providers' own pages, read on 2026-11-25; they
change, so check the page before relying on them.

| Choice | Account | Payment card | Free allowance | Product searches that gives |
|---|---|---|---|---|
| No key | none | no | none needed | unlimited, but only at the shops whose own search may be read (see below) |
| [Serper.dev](https://serper.dev/) | name, email, password | no | 2,500 queries (the page does not say whether they expire) | about 350 to 500 in total |
| [Brave Search API](https://brave.com/search/api/) | email, or a Google or GitHub login | yes, asked for at sign-up | 5 USD of credit every month, about 1,000 queries | about 140 to 200 a month |
| [Tavily](https://tavily.com/) | Google, GitHub, LinkedIn or Microsoft login, or email | no | 1,000 credits every month, one per query | about 140 to 200 a month |

**Without a key** the app still asks every shop whose own search page may be read. Measured on
2026-11-25 with a toothbrush query: of the 32 shops that sell such goods, 10 ended as
`needs_search_key` (Planeo, Dr.Max, Pilulka, iStores, Vaša Lekáreň, Profimed, Sanitino, Datart.cz,
MediaMarkt Austria, Morele.net) and 3 more have no search page that can be called (Teta,
MojaLekáreň, Euronics). Each of them gets a manual link instead. The second route (a web search
when the shop's own search finds nothing) is not available either.

An example from the same day, the query "Iral b io9 doublepack" (an Oral-B iO 9 pack of two):

| | Shops with an offer | What was found |
|---|---|---|
| No key | 1 | NAY in Košice, 297.90 € |
| With a key (8 queries) | 5 | also MojaLekáreň 299.96 € delivered and Profimed 450.90 € (out of stock); Datart.cz and Morele.net list it but do not deliver to Slovakia |

**For the least effort, use Serper**: no card, and in the measurement of 2026-11-24 it found
product pages at as many shops as Brave. When its queries are used up the app says so in the shop
statuses and carries on as without a key.

**Tavily** needs no card either and its allowance comes back every month, but in the measurement
of 2026-11-25 it returned pages at fewer of these shops than Brave did on the same four searches
(table below). It is useful as a free monthly fallback, less so as the only provider.

| Search (19 shops on the web-search route) | Brave: shops with a matching offer | Tavily: shops with a matching offer |
|---|---|---|
| Oral-B io9 doublepack | 4 | 0 (no page returned on any of the domains) |
| Oral-B Pro 3 3000 | 1 (possible match) | 1 (possible match) |
| iPhone 16 128GB | 4 | 3 |
| Bosch GSR 12V-15 | 1 | 1 |
| Queries used | 13 (some results were cached) | 18 |

Small sample: four searches on one day. Tavily was asked the same way as the others, several shop
domains in one query. Asking one shop per query was tried for the first search and found no
matching offer either (9 more credits).

The free allowances are small on purpose, and the app is careful with them: several shops share
one query, results are kept for 6 hours, and the command line prints what a search cost on its
last line.

Other providers were looked at on the same day (the details are in
[docs/research.md](docs/research.md), section 11). Tavily and Exa have a free monthly allowance
without a card, but filter by domain through their own parameter, so each needs its own small
adapter; Tavily has one now, Exa has none. Google's Custom Search JSON API is closed to new customers and
Bing's Web Search API was retired in 2025. The app only uses documented APIs, so it does not read
a search engine's result pages itself.

### Setting a key

Copy `.env.example` to `.env` (git-ignored; in Command Prompt: `copy .env.example .env`), open it
in Notepad and set one or both keys:

```
SERPER_API_KEY=...      # https://serper.dev/            (2,500 free queries, no card)
BRAVE_API_KEY=...       # https://brave.com/search/api/  (monthly free credit, card needed, about 1 request/s)
TAVILY_API_KEY=...      # https://tavily.com/            (1,000 free credits a month, no card)
SEARCH_PROVIDERS=brave,serper,tavily
```

Then start the app again. A key belongs only in `.env`: do not paste it into chats, issues or
commits.

The first provider in `SEARCH_PROVIDERS` (default `brave,serper,tavily`) that has a key is used;
when it reports used-up credit (Brave: HTTP 402; Tavily: HTTP 432 or 433) or a rejected key, it is
marked unusable (Brave and Tavily until the next month, Serper for 30 days; the mark lives in the
SQLite cache) and the next one takes over. If none is
usable, the affected shops get `needs_search_key` with the reason. Key values are never printed or
logged.

To use few queries, the domains of several shops go into one query
(`Oral-B Pro 3 3000 site:a.sk OR site:b.sk ...`, up to 6 per query), grouped by shop country so the
country/language parameters fit (Serper `gl`/`hl`: sk/sk, cz/cs, de/de, at/de, pl/pl; Brave
`country` + `search_lang`, with `country=ALL` for SK and CZ, which Brave's country list lacks).
The second route adds a second batch after the first routes finish: one query per country for the
shops whose own search found nothing matching (it waits up to 15 seconds for more such shops). With
nothing cached, one product search now costs about 5 to 6 queries (about 4 for the first route, 1
or 2 for the second; measured on two toothbrush searches with 39 shops in scope, 2026-11-24). A
repeat within 6 hours costs none, unless the set of shops that need the second route changes, which
changes the combined query. The command line reports the cost on its last line, and the `done`
event's summary carries `siteQueries` (all queries the search needed, cached or not),
`fallbackQueries` (the second-route part) and `fallbackShops` (shops that tried the second route).
Serper's free account refuses more than 10 results
per query ("Query pattern not allowed for free accounts"), so a combined Serper query returns 10
results for all its domains.

### Measurement behind the default order (2026-11-24)

With the 30 shops of that day, twelve took the web-search route (their search page is disallowed by
robots.txt or unknown).
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
`needs_js: true` (prices only rendered by JavaScript), `structured_data: false` (no schema.org data)
or `structured_data: true` (product pages carry it, so fetched pages without it are not product pages),
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
  correct.ts         a brand typed with one wrong letter is searched as the brand
  matcher.ts         query vs title: exact / possible / different, condition, colour, signature
  group.ts           distinct products and their variants
  nearby.ts          similar models the shops list (from what a search collected, no requests)
  totals.ts, rates.ts  shipping, EUR conversion (Frankfurter, ECB)
  search/            web search providers (Brave, Serper, Tavily), fallback chain, site: batching
  categories.ts      which shops to ask (category guess from the query)
  report.ts          status summary line and the "open these yourself" list
  pipeline.ts        the search: relevant shops in parallel, events as they finish
src/app.ts         HTTP API (Hono), portable: GET /api/search streams SSE
src/node/          Node-only: SQLite store (node:sqlite), .env, shops.yaml, server, CLI
public/            plain HTML/CSS/JS page (works from 380 px wide; offer tables become cards on narrow screens)
test/              node:test unit tests; fixtures are trimmed JSON-LD blocks, not whole pages
tools/             probe_shops.py (feasibility probe), extract_fixtures.ts, measure_site_search.ts,
                   fetch_info.ts (reads a shop's delivery/pickup/homepage under the request rules),
                   render_probe.py (measures what a browser engine would add for one page; the app
                   itself uses no browser)
```

## Coverage and cost (measured 2026-11-24, no guarantees)

`data/shops.yaml` has 39 shops in scope (29 Slovak, 3 Czech, 4 German or Austrian, 3 Polish
including Allegro.sk) plus 4 grocery chains kept out of scope. Shops with no automatic route
in every search: Amazon.de (no schema.org data), OBI and notebooksbilliger.de (every page answers
HTTP 404 to a plain client); dm (mojadm.sk) is marked `needs_js`. Euronics, Teta and MojaLekáreň
have no usable search URL and are read through the web search.

Two toothbrush searches on 2026-11-24 evening, Auto categories (32 of 39 shops asked):

| query | ok | no_match | blocked | needs_js | no_route | offers that reach Slovakia |
|---|---|---|---|---|---|---|
| Oral-B Pro 3 3000 | 2 | 18 | 9 | 1 | 2 | Nazuby.eu (a "Pro 3000" title, shown as possible) |
| Oral-B iO Series 3 | 12 | 7 | 9 | 2 | 2 | NAY, Planeo (Košice branches), Andreashop, TPD Euronics, MojaLekáreň, Nazuby.eu, Profimed, Sanitino, Teta |

`blocked` were Alza.sk, Alza.cz, Conrad, Notino, x-kom, Allegro, MediaMarkt.de, MediaMarkt.at and
Dr.Max; blocking varies between runs. The `needs_js` results besides dm were Pilulka pages without
Product data: its page for a product that is currently unavailable carries none (checked
2026-11-25 on one page), while pages of products on sale do.

Earlier measurement with 30 shops in scope (Planeo was then marked `needs_js`), one fresh search
(robots.txt cached, blocked shops inside their one-hour skip, before the second route existed):

| query | before (all 30 shops) | after (Auto categories) |
|---|---|---|
| Oral-B Pro 3 3000 | 30 shops, 14 requests, 4 web queries | 23 shops, 10 requests, 3 web queries |
| iPhone 16 128GB | 30 shops, 29 requests, 4 web queries | 17 shops, 24 requests, 3 web queries |
| Bosch GSR 12V-15 | 30 shops, 13 requests, 4 web queries | 20 shops, 10 requests, 3 web queries |

When the blocked shops' hour has passed, each blocked shop that is asked costs one more request
(robots.txt) before it is skipped again.

Delivery and pickup facts in `shops.yaml` (read 2026-11-24 and 2026-11-25 from the shops' own pages, sources in the
file): NAY (pickup free, delivery from 1.99 €), Mountfield (pickup 1 €, delivery 2.50 €, free from
80 €), Hornbach (free from 99 €, below unknown; pickup terms not readable), Andreashop (2.99 €),
iStores (2.98 €, free from 50 €), Pilulka (1.49 €, free from 29 €), Datacomp (1.99 €), ABCOM (3.50 €),
TPD Euronics (2.99 €), MojaLekáreň (0.99 €, free from 40 €), Vaša Lekáreň (0.99 €, free from 36.90 €),
Nazuby.eu (2.49 €, free from 54.90 €), Holime.eu (2.49 €), Profimed (3.39 €, free from 39 €), Teta
(1.99 €, free from 49 €), Planeo (pickup in a store free); the
complete list, with sources, is in `shops.yaml`. Datart.cz does not deliver abroad;
Morele.net ships abroad only to companies with a VAT number. Unknown: Dr.Max (blocked), Mironet.cz
(no Slovak prices on its page), MediaMarkt.de/.at (blocked), Sanitino and 101 Drogerie (no prices
on their pages).

## More documentation

- [docs/roadmap.md](docs/roadmap.md): current state, next steps, known problems.
- [docs/decisions.md](docs/decisions.md): the choices made and why.
- [docs/research.md](docs/research.md): market research, data sources, the shop probe.
- [docs/architecture.md](docs/architecture.md): how the code is organised.
