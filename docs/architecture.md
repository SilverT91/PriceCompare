# Architecture

This document is for a developer (or a coding agent) who is about to change PriceCompare and has
already read `README.md`. It describes how the code is organised and how one search flows through it,
so you can find the right place to change something without breaking the design. Line numbers are
given as `file:line` for the places where a decision is made; they will drift, so search for the
function name if a number is off.

## 1. The one design rule: `src/core/` is portable

`src/core/` must run anywhere that has the web-standard APIs: `fetch`, `Request`/`Response`,
`Headers`, `URL`, `AbortSignal.timeout`, `TextDecoder`, `setTimeout`. The goal is to run it later on
Cloudflare Workers. Everything that needs Node lives in `src/node/`: the HTTP server, SQLite
(`node:sqlite`), reading files and `.env`, parsing the shop file with `yaml`, and the command line.

What you can see in the imports today:

- No file in `src/core/` imports a `node:` module, `process`, `Buffer`, or anything from `src/node/`.
- The only non-relative imports in `src/core/` are `cheerio/slim` (`links.ts`, pure JavaScript).
  `src/app.ts` imports `hono`, which also runs on Workers. Pure-JavaScript libraries are fine;
  libraries that need native code or Node built-ins are not.
- `src/node/*.ts` and `tools/*.ts` import from `src/core/`, never the other way round.
- Core never reaches for a global service. Everything environmental is passed in:

| Need | Interface in core | Node implementation |
|---|---|---|
| Key-value cache with TTL | `Cache` (`types.ts`) | `Store` in `src/node/db.ts` |
| "When did I last call this host?" | `HostClock` (`http.ts`) | `Store` (same class) |
| Outgoing HTTP | `FetchLike` (`http.ts`), default global `fetch` | global `fetch` |
| Web search | `SearchProvider` (`search/provider.ts`) | built by `providersFromEnv()` in `setup.ts` |
| Shops, providers, history for the HTTP API | `AppDeps` (`src/app.ts`) | wired in `src/node/server.ts` |

In practice, when you add code:

1. If it touches the file system, environment variables, SQLite, or the console, it goes in
   `src/node/` (or `tools/`), and core receives its result through one of the interfaces above.
2. If core needs something new from the environment, add a small interface to core and inject it
   through `SearchOptions` (`pipeline.ts`) or `AppDeps`, the way `fetch?: FetchLike` is injected. Do
   not read `process.env` in core. API keys reach adapters through their constructor
   (`new BraveProvider(key)`).
3. Tests inject fakes the same way: a mocked `FetchLike`, the in-memory `MemoryCache`
   (`test/helpers.ts`), and a `HostScheduler` with a fast `sleep`. Nothing in the tests touches the
   network.

Nothing enforces the rule. `tsconfig.json` loads Node types for every folder, so a `node:` import in
core would typecheck. Check it by eye (or with `grep -rn "node:" src/core`) in review.

Some state is module-level or per process even in core: `HostScheduler` keeps per-host timing in
memory, and `ProviderChain.nextSlot` (`search/provider.ts:88`) is a `static` map that paces provider
calls. On Workers that state would be per isolate, which matters if you rely on those limits.

## 2. Module map

### Search engine (`src/core/`)

| File | Responsibility |
|---|---|
| `types.ts` | All shared types (`Shop`, `ShopStatus`, `RawOffer`, `Offer`, `MatchResult`, `Totals`, `Candidate`, `ShopResult`, `ProductGroup`, `ProductVariant`, `NearbyModel`, `NearbyShop`, `NearbyList`), the `Cache` interface and the `CACHE_TTL` table. |
| `pipeline.ts` | `runSearch()` (async generator of `SearchEvent`s), `searchShop()` (one shop from query to `ShopResult`, including the second route) and `readCandidates()` (fetch the best candidate pages, extract, match, decide a route's outcome; used by both routes). `dedupeOffers()` removes repeats of one page's offer. This is the orchestrator and the place where every shop status is decided. |
| `shops.ts` | `validateShops()` turns the parsed `shops.yaml` into `Shop[]`; `buildSearchUrl()`, `heurekaUrl()`, `Location`/`LOCATIONS`, `sectionFor()` (local vs online section). |
| `categories.ts` | Guesses categories from the query (`RULES`, `guessCategories`), the user-selectable `CATEGORY_GROUPS`, `chooseCategories()` and `shopIsRelevant()`. |
| `http.ts` | The polite fetcher. `HostScheduler` (3 s gap per host), `ShopSession` (one per shop per search: request budget, robots.txt check on every redirect hop, same-site redirects only, size and time limits, bot-wall detection). All shop requests go through it. |
| `robots.ts` | robots.txt parsing and matching (RFC 9309), `RobotsRecord`, `robotsFromResponse()`. |
| `botwall.ts` | `detectBotWall()`: recognises challenge pages and returns a vendor name. |
| `search/provider.ts` | The `SearchProvider` interface, `ProviderChain` (order, fallback, pacing, exhausted marks, result cache), `SiteSearchBatcher` (combines `site:` queries for several shops into one query), `Locale` per shop country. |
| `search/brave.ts`, `search/serper.ts`, `search/tavily.ts` | The three provider adapters. |
| `jsonld.ts` | JSON-LD extraction with a regex (no DOM): `extractOffers()` for product pages, `extractListCandidates()` for search pages (`ItemList`), `parsePrice()`, `offerUrl()` (an offer whose declared URL is the site root links to the page it was read from). |
| `links.ts` | `extractLinkCandidates()`: product links from a search page that has no `ItemList` (uses cheerio). `stripTrackingParams()`: removes click-tracking parameters from candidate URLs. `pageKey()`: one key per page (tracking parameters and fragment removed). |
| `gtin.ts` | `normaliseGtin()` maps UPC/EAN/GTIN-14/ISBN to one 14-digit form; `displayGtin()`. |
| `text.ts` | `fold()` (lowercase, no diacritics), `tokenize()`, `editDistance()`. |
| `correct.ts` | `correctQuery()`: a brand typed with one wrong, missing or extra letter is searched as the brand (section 4, step 1a). |
| `vocab.ts` | Word lists for the matcher: colours, neutral words, tier/package/accessory words, condition words, unit patterns. `NEUTRAL` is built from sub-lists; `BRANDS` and `CATEGORY_WORDS` (category and shop words) are exported for `nearby.ts`. |
| `matcher.ts` | `parseQuery()`, `matchTitle()` (query vs title: exact / possible / different, condition, colour, signature, codes, matched query tokens), `scoreCandidate()` (cheap pre-fetch score), `isArticlePage()` and `urlSlug()` (used by `scoreCandidate` and `nearby.ts`). |
| `group.ts` | `groupOffers()`: links offers into distinct products and variants. |
| `nearby.ts` | `nearbyModels()`: similar models the shops list, from the candidates and offers rated `different` (section 4, step 11a). `productPart()` and `deriveName()` make a model name from a title. Pure: no requests. |
| `totals.ts` | `computeTotals()` (EUR conversion, delivery, pickup), `sortOffers()`, `headline()`/`headlineText()`, `reachable()`. |
| `rates.ts` | `getRates()`: ECB rates from the Frankfurter API, cached. |
| `report.ts` | `statusSummary()` and `notCheckedList()`: the one-line status summary and the "open these yourself" list. |

### Entry points

| File | Responsibility |
|---|---|
| `src/app.ts` | `createApp(deps)`: the Hono HTTP API (`/api/search` as Server-Sent Events, `/api/shops`, `/api/locations`, `/api/categories`, `/api/history`). Portable; gets everything through `AppDeps`. |
| `src/node/server.ts` | Starts `createApp` on `127.0.0.1` (port from `PORT`, default 8787), serves `public/`, records finished searches in SQLite, purges expired cache rows at start. |
| `src/node/cli.ts` | The `npm run search` command: parses options, consumes `runSearch()` directly (no HTTP), prints tables, records the search itself. |
| `src/node/setup.ts` | Node wiring shared by server, CLI and tools: `loadEnv()`, `loadShops()` (reads and validates `data/shops.yaml`), `providersFromEnv()`, `openStore()`, `makeScheduler()`, `ROOT`. |
| `src/node/db.ts` | `Store`: SQLite through `node:sqlite`. Implements `Cache` and `HostClock`, plus search history and the provider-call ledger. |

### Front end, tools, tests, data

| Path | What it is |
|---|---|
| `public/index.html`, `app.js`, `style.css` | Plain HTML/CSS/JS, no build step. `app.js` opens an `EventSource` on `/api/search`, keeps one `state` object, and renders products, the similar models (`renderNearby()`, only what the `products` event carries), the comparison for the selected product, the manual-link list and per-shop statuses. Choosing a product ("Which one do you mean?") happens in the browser, not on the server; until the user picks one, the comparison follows the first product in the list as results arrive. `app.js` re-implements `headlineText`, `sortOffers`, and the status summary from core (comments say "Mirrors"), so a change to those rules needs a matching change here. |
| `tools/extract_fixtures.ts` | Builds test fixtures from pages cached by the probe, or (`--fetch`) from one page fetched now under the request rules (section 8). |
| `tools/fetch_info.ts` | Reads one shop page under the same request rules, to fill in `shops.yaml` facts by hand (`--links`, `--grep`, `--forms`). |
| `tools/measure_site_search.ts` | Runs the real pipeline against the web-search route and counts queries and hits. Makes live requests. |
| `tools/probe_shops.py` | Python feasibility probe (deps in `requirements.txt`). Fetches pages with the same politeness rules and caches them under `.cache/probe/`; writes `data/probe_results.json`. Not used by the app at runtime. |
| `test/` | `node:test` unit tests, one file per area, plus `helpers.ts` and `fixtures/`. |
| `data/shops.yaml` | The curated shop list, read at start-up by `loadShops()`. |
| `tools/render_probe.py` | Python measurement tool (needs `playwright` and its Chromium, which it never downloads itself). For a page it reports what one plain request sees next to what headless Chromium sees: whether a JSON-LD `Product` is there, how many requests the page made and how close together. Same robots.txt check, 3 seconds between page loads, default browser identity plus `price-compare/0.1`, no stealth settings. Not used by the app at runtime. |
| `data/known_product_urls.yaml`, `data/probe_results.json` | Inputs and output of `tools/probe_shops.py` only. No TypeScript reads them. |

## 3. Data types and how they relate

All in `src/core/types.ts`.

```
Shop (one row of shops.yaml, validated by validateShops)
  |
  |  search: shop's own search page, or web search `site:domain`
  v
Candidate { url, title, from: 'itemlist' | 'html_link' | 'search_provider', score?, level? }
  |
  |  best 3 are fetched; extractOffers() reads their JSON-LD
  v
RawOffer { shopId, url, title, brand, gtin, sku, mpn, color, price, currency,
           availability, itemCondition, seller, shipping: ShippingOption[], source }
  |
  |  matchTitle() -> MatchResult        computeTotals() -> Totals
  v
Offer = RawOffer + { shopName, section: 'local'|'online', shipsToSk, branchKnown, match, totals }
  |
  +--> ShopResult { shopId, status: ShopStatus, detail, route, manualUrl, offers: Offer[],
  |                 candidates: Candidate[], requestsUsed, fromCache, ms }     one per shop
  |
  |  groupOffers(all offers of all shops)
  v
ProductGroup { id, title, level, condition, gtins, signature, shopCount, offerCount,
               bestItemEur/Shop, bestTotalEur/Shop/Kind, notes, variants: ProductVariant[] }
  +-- ProductVariant { key, label, gtin, colour, offers: Offer[], bestItemEur, bestTotalEur, ... }

  nearbyModels(query, all ShopResults): candidates and offers rated 'different'
  v
NearbyList { models: NearbyModel[] (at most 8), total }
  +-- NearbyModel { query, shops: NearbyShop[], differs, missing, distinguishing, distance, seenPrice: SeenPrice { eur, shopName, url, from } | null }
        +-- NearbyShop { shopId, shopName, section, url, title }
```

Points worth knowing:

- `Shop` has two curated cost blocks that feed `Totals`: `shipping_to_sk` (`ShopShipping`) and
  `pickup_kosice` (`ShopPickup`). `TriState` (`true | false | 'unknown'`) is used wherever the data
  may be unknown; "unknown" is never coerced to false or to zero.
- `MatchResult.level` is `'exact' | 'possible' | 'different'`. `signature` is the grouping key;
  `codes` are manufacturer order codes found in the title; `condition` is a `Condition`; `matched`
  lists the query tokens the title (or brand, spec segments, a near spelling) has.
- `Totals` keeps item, delivery and pickup separately and says where each came from
  (`shippingSource`: `jsonld`, `shop_data`, `unknown`, `no_delivery`). `bestTotalEur` is the cheaper
  of pickup total and delivery total, or `null`.
- Offers with `match.level === 'different'` stay in `ShopResult.offers` and are grouped like the
  others; they end up in product groups with `level: 'different'` ("other products" on the page).
  Only `exact` and `possible` offers make a shop `ok`.
- `ShopResult.route` is `'shop_search' | 'search_provider' | 'both' | 'none'`: how candidates were
  found. `both` means the shop's own search found nothing matching and the web search was tried
  next (the second route, section 4 step 9a).
- `ProductGroup.title` comes from the best-placed offer the user can get: a local-branch shop first,
  then a shop with `ships_to_sk: true`, then one whose delivery is unknown, and a shop that does not
  deliver only as a last resort. `level`, `score` and `condition` still come from the best match.
- `ShopStatus` is described in the next section. `SearchEvent` (in `pipeline.ts`) is the stream the
  page and CLI consume: `start`, `rates`, `shop`, `products`, `done`.

## 4. The life of one search

```
page: EventSource /api/search?q=..&location=..&cat=..          CLI: runSearch(query, opts)
        |                                                              |
   src/app.ts  createApp -> streamSSE ------------------------------ runSearch() (pipeline.ts)
                                                                       |
   [start] chooseCategories -> shops split into asked / not_relevant   |
   [rates] getRates() runs in the background                           |
                                                                       v
          for every asked shop, in parallel:  searchShop(shop, pq, ...)
          ---------------------------------------------------------------
          flags (needs_js, structured_data, unreachable) -> early status
          cached "blocked" mark                          -> blocked
          candidates cache hit? -> skip to ranking
          robots.txt of the shop  --allowed--> shop search page ----+
                                  --disallowed--> SiteSearchBatcher |--> Candidate[]
                                  (no provider) -> needs_search_key |    (ItemList or links,
                                                                    |     or web search hits)
          readCandidates():                                         |
            rankCandidates (scoreCandidate) -> best 3 non-"different"|
            per page: offers cache -> ShopSession.get -> extractOffers |--> RawOffer[]
            dedupeOffers, per offer: matchTitle + computeTotals      |--> Offer[]
            decide outcome (ok / no_match / needs_js / ...)          |
          own search ended no_match and a provider exists?          |
            yes -> fallback SiteSearchBatcher -> readCandidates      |  (second route, same
                   again (pages already read are skipped)            |   session and budget)
          ShopResult (route shop_search / search_provider / both)   |--> ShopResult
          ---------------------------------------------------------------
        each finished shop pushes:  [shop] event, then [products] = groupOffers(all offers so far)
                                                              + nearbyModels(all results so far)
                                                                       |
   [done] summary (status counts, costs)  ---> Store.recordSearch (history)
```

Step by step:

1. **Query arrives.** On the page, `public/app.js` `start()` opens an `EventSource` on
   `/api/search`. `createApp` (`src/app.ts`) trims the query to 200 characters, resolves the
   location with `locationById()`, and iterates `runSearch()`, writing each `SearchEvent` as one SSE
   message whose event name is the event type. On the command line, `src/node/cli.ts` calls
   `runSearch()` directly and builds its tables from the same events. If the client disconnects, the
   loop stops reading events, but searches already started keep running to completion (shops are
   started eagerly) and `onSearchDone` is not called for them.

   1-pre. **A pasted link** (`linkInput()` in `matcher.ts`), before anything else. An input without
   spaces that starts with http(s), starts with `www.`, or is a host with a dot and a path, is a
   link. The query becomes the name in its path: the last segment that carries words, without
   file endings, leading or trailing ids and path words such as "product"; the query string and
   fragment are ignored. The link is never fetched. A link with no name in it yields a single
   `rejected` event and no request. With a name, the correction below is skipped, the `start`
   event carries `fromLink`, `linkShop` (when the host is one of the shops) and the pasted text
   as `typed`.

   1a. **Query correction** (`correct.ts`, `correctQuery()`), unless `asTyped` is set
   (`as_typed=1` on `/api/search`, `--as-typed` on the command line). A word, or two neighbouring
   words joined, that is letters only, not a vocabulary word, at least four letters long and
   exactly one edit away from exactly one brand of five or more letters is replaced by the brand
   as `BRAND_SPELLING` writes it ("Iral b" becomes "Oral-B"). The corrected query is what
   everything after this uses: the category guess, shop search URLs, web queries, the matcher, the
   cache keys and the Heureka link. The `start` event carries `query`, `typed` and `corrected`, the
   `done` summary `typed`; the page and the command line show both forms and offer the search as
   typed.
2. **Category selection.** `runSearch()` calls `chooseCategories(query, opts.category)`:
   `all`, a group id, or `auto`, which runs `guessCategories()` over `RULES` in `categories.ts`.
   Strong (product-word) rules beat brand-only rules. `shopIsRelevant()` keeps shops whose
   `categories` intersect the choice; shops with `general` are always kept; no hint means all shops.
   Left-out shops get a synthetic `ShopResult` with status `not_relevant` and no requests. The
   `start` event carries the full shop list and the category choice.
3. **Rates and provider setup.** `getRates()` is started once and awaited later by each shop (it
   emits a `rates` event). If any provider is configured, one `ProviderChain` and two
   `SiteSearchBatcher`s over it are created: one for the first route (8 s deadline) and one for the
   second route (`fallbackDeadlineMs`, default 15 s). Each shop tells each batcher exactly once
   either `find(domain, country)` or `decline()` (`runSearch` declines the second one for every shop
   that did not ask when the shop finishes), so a batcher knows when every shop has decided and can
   send the combined queries.
4. **Per shop: early exits.** `searchShop()` creates a `ShopSession` (budget of 6 requests,
   robots-aware) and returns at once for `needs_js`, `structured_data: false`, `unreachable`, or a
   live `blocked` cache mark (section 5).
5. **Choosing a route.** Candidates are looked up in the `candidates` cache first. Otherwise:
   - If the shop has `search_url_template`, `session.allowed(manualUrl)` reads robots.txt. A bot
     wall on robots.txt gives `blocked`. If the search page is allowed, route `shop_search`: fetch it
     through `session.get(url, 'search')`; candidates come from `extractListCandidates()` (JSON-LD
     `ItemList`), or if there is none, `extractLinkCandidates()` (HTML links, filtered by the
     shop's `link_exclude_regex`).
   - If the search page is disallowed, or the shop has no template, and a provider exists, route
     `search_provider`: `batcher.find()` returns the hits on this shop's domain from a combined
     `site:` query (up to 6 domains per query, grouped by shop country so language and country
     parameters fit). `providerCandidates()` strips click-tracking parameters (`stripTrackingParams()`
     in `links.ts`: `srsltid`, `utm_*`, `gclid`, `gtmClickEvent`, `ltm_*` and similar) and drops
     duplicates. Some robots.txt files disallow URLs with those parameters (Teta: `/*srsltid=`).
   - Otherwise the shop ends as `needs_search_key` (it has a template that is disallowed) or
     `no_route` (nothing to search with).
   Candidates are cached after a successful lookup. Failures are not cached.

   5a. **Once more without the package words** (step 1b in `searchShop()`). When the shop's own
   search returned no products (also when that empty answer came from the cache) and
   `withoutPackageWords(query)` differs from the query ("Oral-B io9 doublepack" becomes
   "Oral-B io9"), the shop's search page is asked once more with the shorter query, through the
   same session, so robots.txt, the host gap and the budget of 6 apply. The candidates have their
   own cache key and are scored against the full query as usual. The shop's detail says the search
   was repeated, whatever came of it. Not done when results came back and none matched.
   Since the same day the shorter query is the core query without package words (see 5b), so the
   retry also drops category and colour words.

   5b. **The text each shop receives** (`searchTexts()` in `pipeline.ts`, `coreQuery()` and
   `namesSomething()` in `matcher.ts`). Shops in the search location's country get the query as
   typed. Shops in another country get the core query: the query without category, connector,
   generic and colour words, keeping brands, line, model, tier and package words and every token
   with a digit. That applies when the core still names something (a brand plus one more token, or
   a token with a digit); otherwise they get the query as typed. The same text goes into the
   combined web query for that country (`queryFor(country)` in the batcher) and into the shop's
   manual link. Caches are keyed by the text sent; scoring happens after the cache, always
   against the full query, where a colour in the query is matched by the same colour in any
   language.
6. **Politeness, on every request.** `ShopSession.get()` checks robots.txt for the URL and every
   redirect hop, follows only same-registered-domain redirects, counts every request (robots.txt
   included) against the budget, waits through `HostScheduler` for the 3 s gap, applies a 15 s
   timeout and a 6 MB cap, never retries, and runs `detectBotWall()` on the answer. robots.txt
   records are cached for 24 h.
7. **Candidate scoring** (`readCandidates()`). `rankCandidates()` runs `scoreCandidate()` on title
   and URL slug of each candidate and sorts exact, then possible, then different. Review, comparison
   and manual pages (`ARTICLE_WORDS` in `matcher.ts`: "recenzia", "návod", "porovnanie" ...) score
   `different`. Pages are read from the non-`different` candidates until `MAX_PRODUCT_PAGES` (3)
   have been tried; a candidate that robots.txt disallows is skipped without using a slot. The top 10
   candidates are kept on the result for display.
8. **Product pages.** For each pick: `offers` cache by URL, else `session.get(url, 'product')`, then
   `extractOffers()` (JSON-LD: `Product`, `ProductGroup` with `hasVariant`, `Offer`, `AggregateOffer`,
   `@graph`, `@id` references; an offer URL that is the site root becomes the page's URL,
   `offerUrl()`). The extracted offers are cached for 6 h. A 404 or 410 is cached as an empty result.
   A bot wall on a product page stops the loop; it becomes `blocked` only if no offers were read yet.
   A page with Product data sets a `structured_data` mark for the shop (30 days), used in step 9.
9. **Matching.** Raw offers with price above zero go through `dedupeOffers()` (one offer per page
   URL without tracking parameters, title, price and currency, merged only when seller and GTIN do
   not contradict each other), then `matchTitle()` (section 7) and `computeTotals()`. When every
   page read had no Product data, the outcome is `needs_js`, unless the shop is known to publish the
   data (`structured_data: true` in `shops.yaml`, or the cache mark): then the pages were not product
   pages and the outcome is `no_match`.

   9a. **Second route.** If the route was `shop_search`, the outcome is `no_match` and a provider is
   configured, the shop calls the second batcher's `find()`. Its query has the same form as the
   first route's, combined over all shops that fall back in that batch. The hits go through
   `readCandidates()` again with the same `ShopSession` (so the 6-request budget covers both routes)
   and a set of URLs already read, which are skipped. The result has route `both`: `ok` with a
   detail that says the offers came from the web search after the shop search found nothing
   matching, `blocked` if the second route met bot protection, otherwise `no_match` with
   "both routes tried, nothing matching: shop search: ...; <provider> web search: ...". No second
   route when the budget is used up or the provider is unavailable (the detail says so), and none
   for `blocked`, `robots_disallowed`, `needs_js`, `error` or `not_relevant` outcomes.
10. **Totals.** `computeTotals()` converts the item price to EUR, then finds delivery to the search
    country in this order: JSON-LD `shippingDetails` that names the country, then the shop's
    `shipping_to_sk` (free-from threshold first, then price), else unknown. For shops in the local
    section it also computes pickup from `pickup_kosice`. A shop with `ships_to_sk: false` gets
    `no_delivery`, stays visible, and is outside the ranking (`reachable()`).
11. **Streaming.** When a shop finishes, `runSearch()` pushes a `shop` event and then a `products`
    event with `groupOffers()` over all offers collected so far. Grouping (`group.ts`) joins offers
    by GTIN plus condition, by identical `match.signature`, or by shared order code; inside a
    product it splits variants by GTIN or colour. The same event carries `nearby` (step 11a). The
    page re-renders on every `products` event.

    11a. **Similar models** (`nearby.ts`, `nearbyModels()`). Input is what the shops already gave:
    candidates that `scoreCandidate()` rates `different` (pages that were read are represented by
    their offers instead) and offers whose `match.level` is `different` (these have a price). One
    counts as a nearby model when it is not an article page (`isArticlePage()`); its product part
    (`productPart()`: `cleanTitle()`, the name segment of a "Name / spec / spec" title, nothing after
    " + ", the name after a leading "Typ: … • Počet rýchlostí: 3" spec list, a doubled title taken
    once) is `different` from the query, so the query's own model in a
    bundle is not one; no distinguishing token there is an `ACCESSORY_WORDS` word; every family token
    of the query (`familyTokens()`: alphabetic, not a tier or package word, not a category word;
    brands count) is matched, plus at least one of the other query tokens when there are any; it has
    no amount unit (`75ml`, `1kg`) that the query lacks; its condition (judged on the whole title) is
    new; and its page is not the source of a matching offer. The slug of the URL stands in for a
    title that is missing or names nothing of the query. `deriveName()` then takes the title words
    from the first word with a matched family token (else the first with any matched query token)
    to the last word the matcher places (matched,
    distinguishing or variant-unit token), drops category, colour and condition words inside that
    span (`CATEGORY_WORDS`; brand, line and connector words stay) and keeps unknown words inside it.
    The name must add a token the query lacks, and must match its own product part again as `exact`
    or `possible` (self-check); otherwise the listing is left out. Listings cluster by the name's
    tokens run together in order or as a sorted set (a token that repeats two others, "iO3" after
    "iO" and "3", is ignored; a brand written as two words, "Oral B", is one token). Then the same
    model written shorter is merged (`mergeShorterForms()`): cluster B joins cluster A when every
    name of B uses only tokens of A's name and A's name, parsed as a query, matches every listing of
    B as `exact` or `possible` with nothing missing but a number ("Pro 3500" joins "Pro 3 3500").
    A cluster's name (`chooseName()`) is one from a title rather than a slug that finds most of its
    listings again, not a shorter form that was merged in, in the form most shops write, with the
    fewest words in capitals. It is then written the query's way (`inQueryWriting()`): the brand and
    any word the query also has as the query writes them, and a word of five or more letters in
    capitals with one capital ("Oral-B Pro 3 3900" for "ORAL B PRO 3 3900"), provided the name
    still finds a listing. `distance` is `nearbyDistance()` over the closest listing's
    missing and distinguishing tokens: a missing number paired with an extra number is one step, a
    missing or extra tier or package word two, anything else one each. Order, closest first: the same
    line with another number (distance 1), by number of shops, then a local branch; then the models
    most shops list, then distance, then a local branch, then name. At most 8 (`NEARBY_LIMIT`), with `total`. `seenPrice` is the lowest
    `totals.itemEur` among the cluster's offers, with the shop name and the page URL (`from: 'search'`).

    11b. **Prices for the similar models** (`pipeline.ts`, `priceNearbyModels()`). After the last
    shop, when no product group is `exact` and the list is not empty, one page is read for each of
    the first three models (`NEARBY_PRICE_READS`) that have no `seenPrice`. The listing is picked by
    shop: a branch in the city, then a shop that delivers to Slovakia, then any other; a shop not
    yet asked for another model is preferred. A shop whose result was `blocked`,
    `robots_disallowed`, `error`, `needs_js` or `not_relevant`, or whose request budget is spent,
    is not asked. The read uses the shop's own `ShopSession` from the search (`readPage()`, the same
    function the search uses: `offers` cache, robots.txt, host gap, budget, bot-wall detection), so
    the limit of 6 requests per shop covers it. The page's offers are matched against the model's
    own name; the best `exact` or `possible` offer in new condition with a EUR price gives
    `seenPrice` (`from: 'list'`). An offer rated `different` gives none, and no second page is
    read. The read offers are not added to the shop results, so product groups and offer counts
    stay as they were. When a price was found, one more `products` event carries the list with it;
    `done.nearbyPrices` counts them. There is no plausibility check on the price: it is shown with
    a warning that it may not be the same product. The page renders the list inside
    "Which one do you mean?": open when no product matches exactly (introduced by "No shop lists
    exactly what you typed", plus "the products above are possible matches" when there are possible
    ones), collapsed in a `<details>` below the products when an exact match exists.
    "Compare this model" calls `go()` with the name and the current location and category.

    After the last shop, `done` carries the summary: status counts, `nearby` (the total of similar
    models), shop requests, `siteQueries`
    (web queries the search needed, cached or not), `fallbackQueries` (the second-route part of
    them), `fallbackShops` (shops that tried the second route) and `providerCalls` (new API calls).
    `server.ts` and `cli.ts` store it in `searches`. With nothing cached a search costs about 5 to 6
    web queries: about 4 for the first route and 1 or 2 for the second.

## 5. Shop statuses and where each is assigned

All assignments are in `runSearch()`, `searchShop()` and `readCandidates()` in
`src/core/pipeline.ts`. Every return of `searchShop()` goes through the local helper
`finish(status, detail, extra)`, which also tells the first batcher this shop will not (or no
longer) use it. `readCandidates()` returns a route outcome that `searchShop()` turns into the
result, possibly after the second route.

| Status | Assigned in | Condition |
|---|---|---|
| `not_relevant` | `runSearch` | The shop's categories do not fit the chosen categories. No request. |
| `needs_js` | `searchShop`, early exit | `shop.needs_js` is set in `shops.yaml`; nothing is fetched. |
| | `readCandidates` | Pages were fetched, none had a `Product`/`ProductGroup` node, no matching offer exists, and the shop is not known to publish Product data (neither `structured_data: true` nor a `structured_data` cache mark). |
| `no_route` | `searchShop`, early exit | `structured_data: false`, or `unreachable: true`. |
| | `searchShop`, route choice | No search template and no provider configured. |
| `blocked` | `searchShop` | A `blocked` cache mark exists (set for 1 h by `markBlocked`), or a bot wall on robots.txt or on the search page. |
| | `readCandidates` | Bot wall on a product page before any offer was read (in either route). |
| `robots_disallowed` | `searchShop` | The search page redirected to a URL robots.txt disallows. |
| | `readCandidates` | Every candidate product page was disallowed and none was fetched. |
| `needs_search_key` | `searchShop` | `batcher.find()` reports `unavailable` (no provider usable: out of credit, rejected key), or the search page is disallowed and no providers are configured. |
| `error` | `runSearch` | `searchShop()` threw. |
| | `searchShop` | Request budget used up on robots.txt; off-site redirect from search; search page failed; web search failed. |
| | `readCandidates` | No product page could be read. |
| `no_match` | `readCandidates` | No candidates at all, none that passed scoring, pages read with no matching offer, or pages without Product data at a shop known to publish it. |
| | `searchShop`, second route | Both routes tried and nothing matching (route `both`); or the second route could not be tried (budget used up, provider unavailable), which the detail says. |
| `ok` | `readCandidates` | At least one offer with level `exact` or `possible`, from the first or the second route. |

`needs_js` therefore has two meanings: a configured flag (not fetched) and an inferred result (fetched,
no Product data, at a shop not known to publish it). Only the second kind could be retried by a
future rendering route.

## 6. The SQLite store

`src/node/db.ts`, class `Store`. The file is `.cache/price-compare.sqlite` (override with
`PRICE_COMPARE_DB`, or `:memory:`). WAL mode, `STRICT` tables. Page bodies are never stored.

| Table | Holds |
|---|---|
| `cache` | `(ns, key)` primary key, JSON `value`, `created_at`, `expires_at`. This is the generic TTL cache behind the `Cache` interface. An expired row is deleted when read; `purgeExpired()` also sweeps them, and only `server.ts` calls it (at start). |
| `host_clock` | `host`, `last_ms`: time of the last request per host, so the 3 s gap holds across separate command-line runs (`HostClock`). |
| `searches` | History: query, location, start time, duration, status counts (JSON), offer and group counts. Written by `recordSearch()`, read by `history()` for `/api/history`. |
| `provider_calls` | Ledger of every web-search API call: time, provider, query, country, language, result count, credits, ok, error. `providerUsage()` sums it. |

Namespaces in the `cache` table, with their lifetimes (`CACHE_TTL` in `types.ts`, except the last):

| `ns` | Key | Value | TTL |
|---|---|---|---|
| `offers` | product page URL | extracted `RawOffer[]`, node count, HTTP status, final URL | 6 h |
| `candidates` | shop id, normalised query, provider ids and site-search mode, joined with `\|` | route and `Candidate[]` | 6 h |
| `provider` | provider id, results per query, country, language and the query text, joined with `\|` | web search hits | 6 h |
| `robots` | origin | `RobotsRecord` | 24 h (network errors and bot-wall robots.txt are not cached here) |
| `rates` | sorted currency list | ECB rates | 24 h |
| `blocked` | shop id | vendor and time | 1 h |
| `structured_data` | shop id | time a product page of the shop had schema.org Product data | 30 days |
| `provider_exhausted` | provider id | reason and time | set by the adapter's `exhaustedTtlSeconds()`: Brave quota until the first of next month (at least 1 h), Serper quota 30 days, either one 24 h for a rejected key |

`openStore({ noCache: true })` (the CLI's `--no-cache`) makes `get()` ignore only the `offers`,
`candidates` and `provider` namespaces (`setup.ts:54`); robots, rates and blocked marks still apply,
and writes still happen.

## 7. How the matcher decides

`src/core/matcher.ts`, with word lists in `src/core/vocab.ts` and tokenising in `src/core/text.ts`.
The aim is that an offer for another model, bundle, colour or condition is never shown as the product
the user typed. `matchTitle(query, input)` goes through these stages:

1. **Normalise.** `parseQuery()` folds the query (lowercase, no diacritics) and turns pack phrases
   into tokens (`PACK_RE`, `TIMES_RE`: "39-dielna" becomes `39pc`, "2x" becomes `2x`). `tokenize()`
   joins "Oral-B" to `oralb`, "12V-15" to `12v15`, and glues units ("128 GB" to `128gb`).
2. **Clean the title.** `cleanTitle()` removes shop suffixes ("| iStores", " - NAY"), an appended
   promotion ("+ Cashback 10€ pri nákupe ...") and bracketed part codes. A title of the form
   "Name / spec / spec" is split: only the first segment is the name. Pharmacy pack notation is
   read as a count: "1×1 ks", "1×1 set" and "1×150 ml" are one item, "1×2 ks" is `2pc`.
   `displayTitle()` uses the same suffix and promotion step, plus `nameOnly()` (a leading
   specification list removed, a doubled title taken once), for the product name shown in "Which one
   do you mean?" (`group.ts`); it keeps bundle contents after " + " and bracketed codes.
   Every way of writing a pack of two becomes the one token `duo` (`twoPack()` in `vocab.ts`:
   duopack, "duo pack", doublepack, "double pack", "twin pack", Doppelpack, dvojbalenie); a piece
   count of two right next to it ("Duo, 2 ks") is absorbed, and so is a generic set word in a title
   that has the two-pack word (`GENERIC_SET_WORDS`: "Súprava ... Duo Pack"). A bare "2 ks" stays a
   piece count, and a set word without a two-pack word stays an extra.
3. **Cover the query tokens.** Every query token must appear in the title, in the brand, in a joined
   form ("iphone" + "16" is `iphone16`), or in the spec segments. A query token of letters followed
   by digits also matches a title that writes the two apart, with at most two neutral or line
   words between them ("io9" for "iO Series 9"); the number must be the same token (not "90", not
   "9n") and the letter part must not be a neutral word.
   Specifications are normalised to one token each before this step ("6000 MHz" and "6000MT/s"
   to `6000mhz`, "4,7 GHz" to `4.7ghz`, "256-bit" to `256bit`); interface versions ("PCI-E 4.0",
   "USB 3.2") and port counts ("1x HDMI + 3x DP") are dropped. Units are either variants
   (capacity, memory speed, refresh rate, latency, screen size, power: an unmentioned one makes
   the match `possible`) or neutral (processor clock, transfer rate, bus width: ignored when
   unmentioned). A bare query number meets the same number with MHz, Hz or inch when the title
   has no bare token with it. A one or two digit query number meets a code of digits, two or more
   letters and digits ("16" and "16IMH10") as `possible`. A missing query word with an unknown
   title word in its place is `different` ("MX Anywhere 3S" for "mx master 3s"). A missing token with a digit is
   `missing`, except a line digit left out in front of a model number that starts with it and
   follows the same word ("Pro 3000" for "Pro 3 3000"): that makes the match `possible` at best,
   since shops write it so and an older model of that name exists. A missing plain word that is in
   `NEUTRAL` is ignored; a near spelling (edit distance 1,
   length 6 or more) is accepted and noted; any other missing word is `missingAlpha`.
4. **Classify the extra title tokens** (those the query does not have), in this order: condition
   words (`conditionOfToken`), colour (`colourOf`), the brand, Czech "pro" meaning "for", then
   `MODEL_WORDS`, `PACKAGE_WORDS`, `ACCESSORY_WORDS` (all go to `distinguishing`), part codes
   (kept as `codes`), neutral units, variant units such as `256gb` (`specExtras`), neutral words,
   other tokens with digits (`distinguishing`), and everything else (`unknownExtras`). Pack counts the
   query lacks also go to `distinguishing`.
5. **Condition.** `conditionFrom()` combines JSON-LD `itemCondition`, condition words, and URL path
   segments such as `/bazar/` or `/outlet/`.
6. **Level.** A missing token, a missing tier or package word, two or more missing words, or any
   `distinguishing` token gives `different`. Otherwise any `missingAlpha`, `unknownExtras` or
   `specExtras` gives `possible`; else `exact`. The numeric `score` follows from the level and counts.
7. **Signature.** The sorted set of matched, distinguishing and spec tokens, plus `[condition]` when
   not new. Colour is excluded on purpose, so colour variants share a signature; condition is
   included, so used items never join new ones.

`scoreCandidate()` is the cheap version used before fetching: it matches the search-result title and
the URL slug and takes the better score, but a distinguishing word in either one marks it different.

Where to extend the vocabulary (all in `vocab.ts` unless noted):

| To teach it | Edit |
|---|---|
| A colour word in another language | `COLOURS` (`[stem, canonical, 'exact' or 'prefix']`; order matters for prefixes) |
| A word that marks used, refurbished, ex-display or damaged items | `CONDITION_WORDS` |
| A tier or model word (Pro, Plus, Kids, FC, XL) | `MODEL_WORDS` |
| A bundle or package word (duopack, set, with battery) | `PACKAGE_WORDS`; count patterns such as "39-dielna" are `PACK_RE`/`TIMES_RE` in `matcher.ts` |
| A spare part or accessory word | `ACCESSORY_WORDS` |
| A word that never tells products apart (category words, brand names, marketing) | one of the sub-lists `NEUTRAL` is built from: `CATEGORY_EXACT` / `CATEGORY_PREFIX` (category words, dropped from similar-model names), `GENERIC_WORDS` (shop and marketing words, also dropped), `BRANDS` (brand names; they also name the product family), `LINE_WORDS` ("professional"), `CONNECTOR_WORDS` |
| A unit that defines a variant, or one that is only a spec | `VARIANT_UNITS`, `NEUTRAL_UNITS` |
| Units glued to numbers when tokenising | `UNIT_RE` in `text.ts` |

The category guesser has its own, separate word lists (`RULES` in `categories.ts`). Do not confuse
the two.

The behaviour is pinned by `test/matcher.test.ts` (sections named after the rules: model and number
tokens, distinguishing tokens, condition, colour, languages, possible matches, cases found in live
runs, part codes, candidate scoring) and, for grouping and totals, `test/group_totals.test.ts`. Add a
failing test there first when you change a word list. Many cases there are regressions from real
shops; a vocabulary change can flip them.

## 8. Tests and fixtures

`npm test` runs `node --test "test/**/*.test.ts"` with no network.

| File | Covers |
|---|---|
| `matcher.test.ts` | Tokenizer, matcher rules, candidate scoring. |
| `correct.test.ts` | Query correction: brands corrected, and what is left as typed. |
| `jsonld.test.ts` | JSON-LD extraction against fixtures, `parsePrice`. |
| `group_totals.test.ts` | `computeTotals`, sorting, headline, `groupOffers`. |
| `nearby.test.ts` | Similar models: family rule, accessories / articles / used items / bundles of the query's model left out, name derivation on real titles, slug fallback, the self-check, clustering, ordering, the cap, `seenPrice`. |
| `http_robots_links.test.ts` | robots.txt, bot walls, `ShopSession` politeness, `HostScheduler`, link candidates. |
| `pipeline.test.ts` | Whole search over mocked shops: statuses, routes, offers, totals; the second route (batching, budget across both routes, no re-fetch, unavailable provider), the known-structured-data case, `dedupeOffers`, `nearby` in the `products` event and the summary. |
| `providers.test.ts` | Serper and Brave adapters (mocked), provider chain, batching. |
| `categories.test.ts` | Category guess, `not_relevant`, status summary, manual list. |
| `app.test.ts` | The HTTP API streams one `shop` event per shop as it finishes. |
| `gtin.test.ts` | GTIN normalisation. |

Fixtures live in `test/fixtures/`. They are trimmed JSON-LD blocks, not whole pages, because the
repository is public and shops' HTML is not ours to publish. `fixtures/jsonld/<name>.json` has the
shape `{ source, kind, url, blocks }`; `fixtures/links/<name>.html` holds only a list of anchors
(`<nav>` marks the ones that were in header, nav or footer). `test/helpers.ts` loads them:
`fixture(name)`, `fixtureHtml(name)` (wraps the blocks in a minimal HTML page so tests go through
`extractOffers()` as in production), and `linksHtml(name)`.

To add a fixture with `tools/extract_fixtures.ts`:

1. Get the page into `.cache/probe/` (git-ignored). The cache is written by `tools/probe_shops.py`,
   which makes live requests under the same politeness rules; its file name is
   `<shop_id>-<first 10 hex digits of sha1(url)>.html`.
2. Add an entry `{ file, name, url }` to `PRODUCT_PAGES`, `SEARCH_PAGES` (JSON-LD, `kind: 'search'`)
   or `LINK_PAGES` (anchors only). `file` is the cache file name without `.html`; `name` is the
   fixture name; `url` is recorded in the fixture.
3. Run `npm run fixtures`. It keeps only blocks whose `@type` is a product, list or offer type, drops
   bulky or irrelevant keys (`DROP`: description, images, reviews and so on), caps arrays and string
   length, and writes the JSON. Entries whose cache file is missing are skipped, so existing
   fixtures are not touched.
4. Read the written file and check that it contains no personal data and nothing you would not want
   in a public repository. Then write a test that uses `fixtureHtml(name)`.

For a page that is not in the probe cache, `node tools/extract_fixtures.ts --fetch <domain> <url>
<name>` fetches it once through `ShopSession` (robots.txt, 3 s per host, no retry, bot walls
reported, at most 2 requests) and writes the same trimmed form, stamped with the day it was fetched.

## 8b. Languages and credit usage

**Languages.** `lang` (`en` or `sk`) comes from the page's switch (`public/i18n.js`: `?lang=`,
then `localStorage`, then the browser's language) as a query parameter of `/api/search`, or from
`--lang` on the command line, into `SearchOptions.lang`. Core builds every user-visible sentence
through `t(lang, key, params)` in `src/core/i18n.ts`: shop details (`pipeline.ts`), delivery and
pickup notes (`totals.ts`), product notes (`group.ts`), the status summary (`report.ts`). Events
keep their identifiers (status codes, levels, colour codes), and carry structure next to English
strings where the page must be able to switch language without a new search: `noteFacts` on a
product, `words` on a variant, `reasonCodes` next to `reasons` on a match, `reasonIds` next to
`reasons` on the category choice, `missing` and `distinguishing` on a similar model. Free-text
shop notes are translated in `data/shops.sk.yaml` (keyed by shop id and field, loaded by
`loadShopTexts()` in `setup.ts`, applied by `localizeShop()`); a missing translation shows the
English note. Nothing language-specific is cached. Shop details and delivery notes already on
screen keep the language they were fetched in until the next search; everything else re-renders
on a switch.

**Credit usage.** `src/core/usage.ts` turns credits used and a limit into the entries of
`GET /api/usage` (`provider`, `used`, `limit`, `period`, `source`, `exhausted`), one per provider
with a key. `Store.creditsUsed()` sums the successful calls in `provider_calls`: since the first
of the month (UTC) for Brave and Tavily, over all time for Serper. Brave's answers carry
`X-RateLimit-*` headers; `parseBraveRateLimit()` keeps the entry with the longest window, the
chain caches it as `provider_quota` until that window resets, and while it exists the entry shows
the provider's figure (`source: 'provider'`). Limits default to the free allowances and can be set
in `.env`. The page renders the bars in the footer and refreshes them after each search.

## 9. Extension points

### Add a web search provider

1. Create `src/core/search/<name>.ts` with a class implementing `SearchProvider`
   (`search/provider.ts`): `id`, `resultsPerQuery`, `minIntervalMs`, `exhaustedTtlSeconds(kind)`, and
   `search(s, locale, fetchImpl = fetch)` returning `{ hits, credits }`. `s` is a `SiteSearch`
   `{ query, domains }`: the provider builds its own request from it. Brave and Serper send
   `searchText(s)`, the `query site:a OR site:b` string; Tavily sends the plain query and the
   domains in its `include_domains` parameter. Use the `fetchImpl` argument, not a hard-wired
   `fetch`, so tests can mock it. Map `Locale` (`country`, `lang`) to the provider's parameters;
   the three adapters show three different mappings. The cache key and the call log use
   `searchText(s)` for every provider.
2. Throw `ProviderUnavailableError('quota' | 'auth', status, message)` when the provider cannot be
   used until something changes. `ProviderChain` then stores a `provider_exhausted` mark and moves to
   the next provider. Throw a plain `Error` for transient failures (the chain tries the next provider
   for that query, no retry). Never put the key in an error message.
3. Register it in `providersFromEnv()` (`src/node/setup.ts`): one more `else if (id === '<name>' &&
   process.env.<NAME>_API_KEY?.trim())` branch. Add the variable to `.env.example`, and mention it in
   the README key section.
4. Add a mocked-fetch test next to the Serper and Brave ones in `test/providers.test.ts`.

No change is needed in the pipeline: the provider id is part of the `provider` and `candidates` cache
keys, and the batcher and chain are provider-agnostic.

### Add a new route for reading a shop (for example a headless-browser renderer for `needs_js`)

Today a route is not an object: it is the branch structure inside `searchShop()` (`pipeline.ts`,
"1. candidates" and "4. second route"), the shared page reading in `readCandidates()`, and the value
recorded in `ShopResult.route`. Page reading always goes through one seam: `ShopSession.get(url, kind)` returns a
`PageResult` whose `text` is then handed to `extractOffers()` or the candidate extractors. A renderer
fits there. Suggested shape:

1. Define the capability in core as an injected function, like `fetch?: FetchLike` in
   `SearchOptions`. For example `render?: (url: string) => Promise<{ status: number; html: string }>`.
   Core must not import a browser library; the implementation (Playwright, or Cloudflare browser
   rendering on Workers) lives in `src/node/` (or the Worker entry) and is passed in from
   `server.ts` and `cli.ts`.
2. Keep every request rule. The simplest way is to give `ShopSession` a second fetch-like dependency
   in `ShopSessionDeps` and use it in `raw()` when the shop is marked for rendering, so robots.txt on
   every hop, the host scheduler, the request budget and `detectBotWall()` still wrap the call. Do not
   call the renderer straight from `searchShop()`.
3. Replace the early return for `shop.needs_js` in `searchShop()` with a branch that uses the
   renderer when `opts.render` is present and keeps today's `needs_js` result when it is not. The
   inferred `needs_js` in `readCandidates()` could retry through the renderer in the same way.
4. Add a value to the `route` union in `ShopResult` (`types.ts`) if the route should be visible; the
   CLI table prints it and the page shows `detail`.
5. Cache keys: `offers` is keyed by URL only, so rendered and plain extractions of one URL would
   share a cache entry. That is fine as long as a rendered result is never worse than a plain one.
6. Tests: use a fake `render` in a `pipeline.test.ts`-style test; fixtures remain trimmed JSON-LD.

Note that the README currently states a rule of no headless browser; adding this route changes that
rule, so it needs a deliberate decision first.

Measured by hand on 2026-11-25 with a browser engine: dm's product page carries JSON-LD `Product`
with price, GTIN and availability once rendered. Loading the page made about 200 requests, most of
them images, fonts and third-party scripts, so a renderer should switch those off. dm is the only
shop it would add today: Pilulka's pages without product data are pages of products that are
currently unavailable, and a browser shows no product data on them either.

Measured again the same day with `tools/render_probe.py`, which switches off images, fonts,
stylesheets and every host outside the page's own domain unless a host is named with
`--allow-host`:

| dm product page | Requests let through | Result |
|---|---|---|
| Nothing outside mojadm.sk | 3 (26 to `assets.dm.de` stopped) | Empty page, one JSON-LD block of type `WebSite` |
| `assets.dm.de` allowed | 71, about 2 MB | 459 characters of text, still no `Product`; 10 requests to four hosts under `services.dmtech.com` stopped |

So a renderer for dm has to let through the assets host and the data hosts on dm's services
domain, each with its own robots.txt to honour, and it cannot keep 3 seconds between the page's
own requests (59 of 60 requests to the assets host were closer together). The run with the data
hosts allowed was not made. A Planeo page without product data in its plain HTML
(`/iphone-16-blue`) had none in the browser either.

### Add a field to `data/shops.yaml`

`validateShops()` (`src/core/shops.ts`) copies a fixed list of fields into `Shop`. A key it does not
know is dropped without a warning, so a new field needs all of these:

1. `Shop` in `src/core/types.ts`: add the property (make it optional unless every shop gets a
   value).
2. `validateShops()`: read and coerce it, and add a `problems.push(...)` message if a wrong value
   should be reported. The existing code shows the patterns: `tri()` for `true/false/unknown`,
   `str()` for text or dates, explicit defaults for booleans.
3. The place that uses it: usually `searchShop()` in `pipeline.ts`, `computeTotals()` in `totals.ts`
   or `shopIsRelevant()` in `categories.ts`.
4. If the page or API needs it, add it explicitly. `/api/shops` in `src/app.ts` and `ShopInfo` in
   `pipeline.ts` list the fields they expose; nothing is passed through automatically.
5. Document it in the field notes at the top of `data/shops.yaml` and in the README "Adding a shop"
   section. Add values to the shops that need it.
6. Tests that build shops go through `validateShops()` (see `test/pipeline.test.ts`), so defaults
   you add there apply to them as well.

Limits you will meet: `categories` values are not checked against the vocabulary, so a typo silently
means the shop is never asked in `auto` mode; and the location is wired to one city
(`Location.branchField` is the literal `'has_kosice_branch'`, and `pickup_kosice` is named for the
city), so a second city means a new field on `Shop`, a new entry in `LOCATIONS`, and a change to
that literal type.

## 10. Differences from the README

- **robots.txt cache.** The README says 24 hours. Network errors and bot-wall answers for robots.txt
  are only remembered for the current shop session, not stored for 24 hours (`http.ts`); the wall
  case is stored as a 1-hour `blocked` mark by the pipeline.
- **Tools and data.** The README's layout section does not mention `data/known_product_urls.yaml`,
  `data/probe_results.json` or `requirements.txt`; they belong to the Python probe only.
