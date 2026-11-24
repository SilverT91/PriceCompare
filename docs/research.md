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

Still unknown: Dr.Max (blocked), Mironet.cz (its pages never mention Slovakia), MediaMarkt.de and
.at, 101 Drogerie, Hornbach pickup, Alza.sk and Planeo pickup.

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
