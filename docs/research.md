# Research findings

What was learned before and during the first build, and where each fact came from. Everything here
was checked on **2026-11-24** unless stated otherwise. Shops, APIs and prices in this area change
often, so re-check anything you are about to depend on.

Facts marked *(unverified)* were reported by a source but not confirmed on the page itself.

## 1. Does a free tool already do this?

**Not this particular combination.** The request was: type a product, say where you live, get
prices from shops with a branch near you and from web shops in any country that deliver to you, in
one comparison. Several established services each do a large part of this well, at a scale this
project will never have. The table records what each one is built for, to show where a small
personal tool can add something and where it should simply point to them.

| Need | Existing service | What it is built for |
|---|---|---|
| Web shops in one country | Heureka.sk, Pricemania.sk, NajNakup.sk | Broad comparison of a country's web shops, with delivery cost; one country per site |
| Basic food prices by chain | cenyslovensko.sk (Slovak Ministry of Finance) | Daily food prices from six chains; see section 6 |
| Leaflet promotions per branch | Kimbino.sk, Kupino.sk | Current promotional leaflets of nearby branches |
| Local and online in one list, by postcode | idealo.de ("In deiner Nähe" tab) | Web shops plus nearby stores with stock, in Germany. The model for PriceCompare's interface. |
| AI shopping assistants | ChatGPT shopping (available in CZ) | Conversational product research across web shops |

What this project adds for its one use case:

1. Shops with a branch in Košice and web shops in one list, including pickup at the branch.
2. Web shops from neighbouring countries next to Slovak ones, with delivery to Slovakia and
   currency conversion.
3. A step where the user picks the exact product (model, variant, package) before prices are
   compared.

One caution from a price sample: an iPhone 16 128GB cost about the same in Slovak and German
listings (about 705 € and 710 €). Cross-border savings can be small, so the local-versus-online side
may be the more useful half.

## 2. Existing open-source projects

These are price trackers: the user gives them product URLs and they follow the price over time.
That is a different job from searching for a product across shops, so none was adopted, but two
informed the design.

| Project | What it does | What we took from it |
|---|---|---|
| PriceBuddy (jez500), GPL-3.0, PHP | URL tracking, per-shop definitions, optional SearXNG lookup | The idea of a per-shop definition file |
| PriceGhost (clucraft), TypeScript | URL tracking; reads JSON-LD first, with other methods as backup | Reading JSON-LD first |
| changedetection.io, Apache-2.0 | Generic page monitor with price and restock detection | Nothing directly |
| Hlídač shopů (topmonks), EUPL-1.2 | Price history for Czech shops, as a browser extension | Nothing directly; a browser extension is noted in the roadmap as a possible later route |

## 3. Data sources

### Web search (to find product pages on a shop's domain)

| Source | Status | Notes |
|---|---|---|
| Google Custom Search JSON API | Closed to new customers, ends 2027-01-01 | Do not use |
| Bing Search API | Retired 2025-08-11 | Gone |
| **Brave Search API** | In use (default) | "Search" plan, 5 USD per 1,000 requests, 5 USD free credit every month (about 1,000 requests). With the spend limit set to "Free", requests return HTTP 402 when the credit is used up, until the next month. About 1 request per second. Its country list has no SK or CZ, so those queries use `country=ALL` with `search_lang`. |
| **Serper.dev** | In use (fallback) | 2,500 free queries, one time, no card. The free account refuses more than 10 results per query. Its out-of-credit response is undocumented and has not been seen live. Google sued a similar vendor (SerpApi) in 2025, so this kind of service carries a continuity risk. |
| SearXNG, self-hosted | Not used | Upstream engines rate-limit self-hosted instances |
| DuckDuckGo | Not used | No real API; the unofficial library forbids commercial use |

Measured on 12 shops and 3 products: Brave and Serper found the same shops; several `site:` domains
combined in one query worked as well as one query per shop, at less than half the cost. See the
README for the table.

### Price comparison services

Heureka and Zboží.cz do not offer a public search or price API, and their robots.txt and terms do
not permit automated use of their search. **PriceCompare respects that: it never fetches them**, and
only gives the user a link to open Heureka.sk for the same query.

### Structured data on shop pages

Every product page that carried structured data used schema.org `Product` in **JSON-LD** (19 of 19
in the probe; none used microdata). MediaMarkt uses `ProductGroup` with variants. On those pages:
price and currency 19 of 19, availability 18, brand 18, GTIN 13, `shippingDetails` 9.

GTIN keys vary (`gtin`, `gtin13`, `isbn`) and the same product appears as 12 digits at one shop and
zero-padded to 14 at another, so GTINs must be normalised before comparing.

### Other sources

| Source | Finding |
|---|---|
| Frankfurter API | Free wrapper around ECB reference rates; in use for currency conversion |
| OpenStreetMap / Overpass | Branch coordinates by `brand:wikidata`; cache a periodic extract, do not query live. Not used yet. |
| Nominatim | Free geocoding, 1 request per second, no autocomplete. Not used yet. |
| Open Food Facts "Open Prices" | Almost no Slovak data |
| eBay Browse API | Has a `deliveryCountry:SK` filter; production use needs approval. Not used. |
| Amazon | The old Product Advertising API is deprecated; the replacement needs an Associates account. Amazon.de product pages carry no schema.org data. |
| Allegro | Offer listing API is for verified apps only; its site blocks plain clients (DataDome) |
| IKEA | An unofficial per-store stock endpoint exists; the product page references `/sk/sk/lower-funnel-fragments/product-availability/?itemNo=...`. Not tested; check robots.txt first. |

## 4. Shop probe (30 non-food shops)

`tools/probe_shops.py` fetched each shop's search page and a product page with a plain HTTP client,
honouring robots.txt, 3 seconds per host, no retries. Raw results are in `data/probe_results.json`.

| Outcome | Shops | Which |
|---|---|---|
| Own search page readable, priced product data | 5 | NAY, Hornbach.sk, Andreashop, Mironet.cz, MediaMarkt.de |
| Search disallowed by robots.txt, product pages allowed and readable | 10 | Mountfield, Dr.Max, Pilulka, IKEA, JYSK, Martinus, iStores, Datart.cz, MediaMarkt.at, Morele |
| Search disallowed, product page needs JavaScript | 2 | Planeo, dm (mojadm.sk) |
| Blocked (HTTP 403 with a challenge page) | 7 | Alza.sk, Alza.cz, Conrad, Notino, Sconto, x-kom, Allegro.sk |
| No structured data | 1 | Amazon.de |
| No usable search URL, or site answers 404 to a plain client | 5 | OBI, notebooksbilliger.de, Euronics, Teta, 101 Drogerie (no results) |

What follows from it:

- **The shop's own search is off limits at 40% of shops**, but their product pages are allowed. That
  is why product URLs for those shops come from a web search provider.
- **Blocking is not stable.** MediaMarkt.de and Dr.Max returned 403 on one run and 200 on the next
  with the same settings. During the build, 7 to 9 shops were blocked on any given run, including
  both MediaMarkt sites. Treat `blocked` as something that happens, not as a property of a shop.
- **The first search result is often a related product, not the exact one.** Shop search pages
  list related models, bundles and accessories too, which is reasonable for a shopper browsing but
  not for automatic comparison: "Oral-B Pro 3 3000" had the exact product first at 1 of 5 shops,
  and "iPhone 16 128GB" had another model of the same family first at one shop. Title tokens alone
  are not enough to pick the right page, which is why the matcher exists.
- **Per-branch stock is not in static HTML anywhere.** Hints for later: IKEA's availability
  fragment (above); Hornbach's page state includes the Košice store with `storeId` 746; MediaMarkt
  and Planeo load pickup data with JavaScript.

Shops that no longer exist and were left out: Datart.sk (became NAY on 2024-09-01), Hej.sk
(redirects to NAY), Okay elektro (closed), Mall.cz and CZC.cz (now sellers on Allegro). They are
listed under `excluded` in `data/shops.yaml`.

## 5. Delivery and pickup facts

Read from each shop's own delivery page and recorded in `data/shops.yaml` with source and date.

| Shop | Recorded |
|---|---|
| NAY | Pickup in a branch free (0.99 € only when paying at the till); delivery from 1.99 € to a pickup point |
| Mountfield | Store pickup 1.00 €; pickup point 2.50 €, courier 3.80 €; free from 80 € |
| Hornbach | Free for parcels from 99 €; the price below that and the pickup terms could not be read |
| Andreashop | Packeta 2.99 €, courier 3.99 € |
| iStores | 2.98 €, free over 50 € |
| Pilulka | 1.49 € to 3.39 €, free from 29 € |
| Datart.cz | **Does not deliver abroad** |
| Morele.net | **Does not deliver to Slovakia** for consumers (abroad only for companies with a VAT number) |

Added on 2026-11-25, from a second reading of the shops' own pages:

| Shop | Recorded |
|---|---|
| Teta | Pickup point 1.99 €, courier 2.99 € to 3.49 €; free to the address from 49 € |
| Planeo | Pickup in a store is free once the shop confirms the reservation; the page names no store |
| Vaša Lekáreň | Its pharmacy list has eight entries in Košice; pickup is offered in "selected" pharmacies, which ones is not stated |
| TPD | The contact page lists stores in Bratislava, Zvolen, Žilina and Žiar nad Hronom; none in Košice |
| MojaLekáreň | No place of its own to collect an order; external pickup points only |
| Mironet.cz | Pickup points are marked "ČR a SK", but no Slovak prices are given, so delivery stays unknown |
| Nazuby.eu | The delivery page lists three paid options and no 0 € one; the 0 € entry in its product data is not explained there |

Still unknown: Dr.Max, MediaMarkt.de and .at and Alza.sk pickup (their pages answered 403), Hornbach
pickup (the page needs JavaScript), Sanitino and 101 Drogerie (no prices on their pages), the pickup
fee at Datacomp and Profimed (offered, fee not stated), and a Košice branch for Nazuby.eu, Holime.eu
and Sanitino.

## 6. cenyslovensko.sk (groceries, currently out of scope)

Groceries were dropped from the scope, so this is recorded for a possible later phase.

- State food price comparator, live since 2025-07-01. Chains must report daily prices by law (Act
  18/1996 §14a, Decree 15/2025). Chains: Billa, Fresh Plus, Kaufland, Lidl, Terno, Tesco. Košice has
  33 branches listed (Fresh Plus 18, Lidl 8, Billa 4, Kaufland 2, Tesco 1; no Terno).
- About 1,090 product listings in 6 categories. Products are exact branded items with an EAN, plus
  a generic product-type code for comparing across brands. Updated daily by 06:00.
- The page loads its data from JSON endpoints at `api.cenyslovensko.sk/api/...` with no token
  (`/product-prices/current-day`, `/product-prices/detail`, `/product-prices/product/by-vendor`,
  `/vendor-branch`). Price responses give a **minimum and maximum per chain**, not a price per
  branch. The "my stores" view with branches selected was not tested.
- **Terms are unclear.** No terms of use or reuse licence were found. The methodology page promises
  "free and open access" but also says data is published "exclusively via the website". No
  open-data listing was found. `robots.txt` returns 403.
- Project contact: `cenyslovensko@mfsr.sk`. Ask before building on it.

## 7. Cross-border totals

Short notes, not tax advice.

- Slovak standard VAT is 23% since 2025-01-01. EU shops selling to Slovak consumers charge Slovak
  VAT once they pass the EU distance-selling threshold.
- Non-EU parcels up to 150 €: a flat 3 € customs duty per item applies from 2026-07-01 to
  2028-07-01. No non-EU shop is in the database yet, so this is not implemented.
- There is no universal way to learn whether a shop delivers to Slovakia. JSON-LD
  `shippingDestination` is often missing, so `ships_to_sk` and `shipping_to_sk` are curated by hand
  in `data/shops.yaml`.

## 8. Legal position on reading shop pages

Commonly cited position, not legal advice.

- Where the database right does not apply, a site's terms can forbid automated reading (CJEU,
  *Ryanair v PR Aviation*, C-30/14).
- EU text and data mining rules let a rightholder reserve its rights in a machine-readable way;
  robots.txt is the usual signal.
- The posture this project takes: obey robots.txt, identify the client honestly, rate-limit, read
  only the individual pages needed for the user's query, store facts (price, URL, time) and not
  catalogues, never get around bot protection, and prefer official feeds or APIs where they exist.

## 9. Hosting

Not hosted; it runs locally. What was considered:

- **Cloudflare Pages + Workers** (free): fits, and auto-deploys from GitHub. The free plan limits
  outgoing fetches per request (about 50) and CPU time *(from memory, unverified)*, the backend
  would have to stay TypeScript, and shops distrust data-centre addresses more than a home
  connection, so more of them would block it. `src/core/` is kept portable for this.
- A public site would also let strangers use up the search quota and turn a personal tool into a
  public scraping service. If it is ever hosted, put it behind a login (Cloudflare Access).
- Running locally and sharing through a Cloudflare Tunnel is the cheapest way to give one other
  person access.

## 10. Official routes to shops that do not allow automated reading

Checked on 2026-11-25. The question was whether Alza, Notino, MediaMarkt and Dr.Max offer product
and price data through a partner programme that one private person with a local tool could join.
Several of the shops' own pages could not be read, so parts of this come from the networks'
catalogue pages; those are marked *(unverified)* where the shop's own page was not seen.

| Shop | Programme | Product data for partners | Who may join |
|---|---|---|---|
| Alza | Its own programme, [affiliate.alza.sk](https://affiliate.alza.sk/) | Text links and banners. The page says an API for partners is in preparation; no date. | A company ID (IČO) and a website that Alza reviews. Non-entrepreneurs only occasionally, under 1,000 € a year. |
| Notino | Listed in the [VIVnetworks catalogue](https://www.vivnetworks.com/sk/affiliate-katalog/notinosk/) and on FlexOffers *(unverified)* | The catalogue page says an XML feed is supported; its fields are not listed | Application describing the partner's website, reviewed by the shop |
| MediaMarkt.at | [Awin, merchant 13996](https://ui.awin.com/merchant-profile/13996) | Product feed "on demand and by arrangement" | Awin publisher account, then approval. The profile states shipping within Austria only. |
| MediaMarkt.de | No current programme found | | |
| Dr.Max | Listed in the [VIVnetworks catalogue](https://www.vivnetworks.com/sk/affiliate-katalog/drmaxsk/), sign-up through CJ *(unverified)* | The catalogue page says no product feed | Not stated |

Affiliate networks with product data across several shops:

- **Tradedoubler Products API**: EAN, price, stock, delivery time and shipping cost per product,
  limited to the feeds of advertisers the publisher is connected to
  ([documentation](https://dev.tradedoubler.com/products/publisher)).
- **Awin product feeds**: per advertiser, after joining that advertiser's programme. Applications
  are checked by hand and ask for the publisher's URLs.
- **Dognet** (Slovak): a natural person may register, and its FAQ says an active website or project
  is needed ([FAQ](https://www.dognet.sk/faq/)). It has a feeds section; which shops provide feeds
  was not visible without an account.

What follows from it:

- **None of these routes is open to a local tool with no public website.** Each programme is built
  for publishers who send visitors to the shop, and asks for a site to review.
- They become relevant if the tool is ever hosted as a public site (section 9). The order to try
  then: Dognet, then Tradedoubler and Awin for individual shops.
- Alza's partner API is worth checking again once it is released.
- Shops produce product feeds for comparison services, at an address the service downloads from.
  Whether any shop publishes that address openly was not established, and none was probed.

## 11. Web search providers for someone who wants no card and little setup (2026-11-25)

The question: what can a second user install with the least effort, and how limited is it. All
facts are from the providers' own pages, read on 2026-11-25. "Not stated" means the page was read
and does not say. One product search costs 5 to 7 queries with nothing cached.

The two providers the app supports:

| | Brave Search API | Serper.dev |
|---|---|---|
| Free allowance | 5 USD of credit every month; at 5 USD per 1,000 requests that is about 1,000 requests. The same page also says "up to $20 in free calls every month" in its headline | 2,500 queries |
| Recurring | Monthly | Not stated |
| Expiry | Not stated | Not stated for the free queries (paid credits: 6 months) |
| Payment card at sign-up | Yes ("to prevent abuse") | No ("no credit-card needed") |
| Sign-up | Email and password, or a Google or GitHub login; then a plan must be activated before a key can be made | Name, email, password |
| `site:` with OR | Documented, marked as experimental | Not stated |
| Product searches | About 140 to 200 a month | About 350 to 500 in total |

Sources: <https://brave.com/search/api/>,
<https://api-dashboard.search.brave.com/documentation/resources/search-operators>,
<https://api-dashboard.search.brave.com/documentation/guides/authentication>,
<https://serper.dev>, <https://serper.dev/signup>, <https://serper.dev/terms>.

Two points to keep in mind:

- Brave's FAQ says that storing results needs a plan with storage rights. The app keeps web search
  results for 6 hours to save queries. Brave's full terms on this were not read; it is an open
  point, not a finding.
- Serper's terms describe its data as "web-scraped data collected from public domain sources" and
  say it is not affiliated with Google. The app calls only Serper's documented API.

Other providers:

| Provider | Free allowance | Card | Domain filter | Source |
|---|---|---|---|---|
| Tavily | 1,000 credits a month, 1 per basic search | No | `include_domains` parameter (no `site:` in the docs) | <https://tavily.com/pricing>, <https://docs.tavily.com/documentation/api-reference/endpoint/search> |
| Exa | 10 USD of credit a month, "up to 2,500 Lite searches" | No | `includeDomains` parameter | <https://exa.ai/pricing>, <https://docs.exa.ai/reference/search> |
| You.com | An endpoint with no key and no account, 100 queries a day, over the MCP protocol; accounts get 10 USD of credit | No | `site:` and OR documented for the Web Search API; not confirmed for the keyless endpoint | <https://you.com/docs/agents/mcp-server.md>, <https://you.com/docs/guides/search/search-operators.md> |
| Google Custom Search JSON API | 100 queries a day | n/a | n/a | Closed to new customers; service ends 2027-01-01: <https://developers.google.com/custom-search/v1/overview> |
| Bing Web Search API | none | n/a | n/a | Retired 2025-08-11: <https://learn.microsoft.com/en-us/lifecycle/announcements/bing-search-api-retirement> |
| Mojeek API | A free credit of unstated size | Yes | Operators included, not listed | <https://www.mojeek.com/services/api.html> |
| Kagi Search API | None stated; 12 USD per 1,000 | Not stated | Not stated | <https://kagi.com/api/pricing> |
| Marginalia | Free non-commercial key by email; a shared public key that "often hits a rate limit" | No | Not documented | <https://about.marginalia-search.com/article/api> |
| DuckDuckGo | No official web search API was found | | | Could not be verified on its own pages |

Left out on purpose:

- **Resellers of collected search results** (SerpApi, SearchApi.io, ScrapingDog): small free
  allowances (250 a month, 100 once, 20 requests), and their data comes from reading search
  engines' result pages.
- **Self-hosted metasearch (SearXNG).** Its documentation says it passes requests on to other
  search services and is classified by them as a bot. Google's terms and robots.txt do not allow
  automated access to its result pages. That is outside this project's request rules.
- **Common Crawl.** A free archive and URL index, crawled about monthly. Its FAQ calls it a sample
  of the web and warns of strict rate limits on the index. It gives URLs without text search or
  ranking, a few weeks old, so it does not replace a search API.

What follows from it:

- There is no key-free web search API among the established providers, apart from You.com's
  endpoint, which needs more code and whose domain filter is unconfirmed.
- **Least effort today: Serper.** No card, and no change to the app.
- **A provider with a monthly allowance and no card would be Tavily or Exa.** Each needs an adapter
  that sends the shop domains as a parameter, and a measurement like the one in the README before
  it becomes a default. Whether their indexes cover small Slovak and Czech shops is not stated
  anywhere.
