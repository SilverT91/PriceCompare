# Roadmap

Where the project stands and what comes next. Update this file when a round of work finishes.

## State on 2026-11-24 (after the second round)

The app works end to end: web page, command line, unit tests passing. The database has 39 non-food
shops in scope.

| Search | Result |
|---|---|
| iPhone 16 128GB | Useful: NAY in Košice 849 € with free pickup, iStores 959 € delivered, Andreashop 981.99 € delivered |
| Bosch GSR 12V-15 | Partial: Hornbach Košice 133.20 €; the other offers are a different kit or do not reach Slovakia |
| Oral-B iO Series 3 | Useful: 12 shops with offers. From 59.90 € (62.89 € delivered) at Andreashop and TPD; NAY in Košice 64.90 € with free pickup; also Planeo, Profimed, MojaLekáreň, Nazuby.eu, Teta, Sanitino |
| Oral-B Pro 3 3000 | One possible offer: Nazuby.eu lists a "PRO 3000 Blue" at 62.01 € (64.50 € delivered), to be checked by the user. The model appears to be leaving the shelves: NAY's pages for it answer 404 and the other shops list its successors. Morele.net has it but does not deliver here |

What the second round did:

- **Nine more shops** that sell small appliances, personal care and dental goods and can be read:
  Datacomp, ABCOM Košice, TPD, MojaLekáreň, Vaša Lekáreň, Nazuby.eu, Holime.eu, Profimed, Sanitino.
  Planeo turned out to have static product pages, so it is now read through the web search route.
- **A second route.** When a shop's own search finds nothing matching, the shop joins a second,
  batched web search before it is reported as `no_match`. The limit of 6 requests per shop covers
  both routes together.
- **Matcher:** pharmacy pack notation ("1×1 ks") counts as one item; "Pro 3000" for "Pro 3 3000" is
  a possible match; promotions appended to a title ("+ Cashback ...") are ignored.
- **Tracking parameters** added by search engines are removed from candidate URLs.
- **Smaller fixes:** review and manual pages are not taken as product pages; an offer whose
  structured data points to the shop's homepage links to the product page; the same offer reached
  through several links is shown once; a product is named after an offer that can reach the user.

Why the drugstores returned nothing for "Oral-B Pro 3 3000": Dr.Max names it "Pro 3000 ... 1×1 ks",
which the matcher rejected (fixed; its pages then answered 403 that day). Pilulka's Oral-B product
pages carry no structured data, while other pages of the shop do. Teta does not appear to list the
model.

Of the 39 shops, on the day of the test: 12 produced offers for a toothbrush, 9 were blocked, 2 could
not be read without a browser, 2 have no automatic route, 7 had nothing matching, 7 were not asked
(wrong category).

A product search costs about 5 to 6 web queries with nothing cached (3 to 4 before the second
route). Search quota used so far: Brave 52 requests (of about 1,000 per month), Serper 45 (of 2,500
in total).

## Next round

In this order.

1. **Show nearby models when the exact one is not sold.** The Pro 3 3000 search ends empty although
   shops list the Pro 3 3500 and the iO Series 3. Candidates the matcher rejected are known but not
   shown as products. List them under "other products found" so the user can pick the successor.
2. **Read the JavaScript-only shop dm (mojadm.sk)** with a real browser engine (Playwright), as a
   new route for shops marked `needs_js`. Planeo no longer needs it. Decide first whether one shop
   justifies the dependency; Pilulka's Oral-B pages may be a second case (not yet checked whether a
   browser shows their price data).
   - Same request rules: robots.txt, 3 seconds per host, a plain honest identity, no stealth
     settings. A challenge page means `blocked`.
   - It is Node-only, so it belongs outside `src/core/`, behind an interface the pipeline calls.
   - The README's request rules currently say "no headless browser"; update that section when this
     lands, keeping the ban on using one to get around protection.
3. **Look for an official route to the blocked shops** (Alza, Notino, MediaMarkt, Dr.Max):
   affiliate programmes or product feeds. Not yet investigated.
4. **Fill in delivery and branch facts still unknown** for the new shops (see below).
5. **Test with the exact model the first user was looking for**, once known.

## Known problems

- **Bosch kits.** Shops do not state the package in the title. A bare tool at 66 € and a kit at
  133 € can end up in one product through a shared order code. The matcher cannot know; consider
  reading package contents from the description or flagging large price gaps inside one product.
- **Regional SKUs.** The same colour of a phone has different GTINs for different regions and
  different colour names between shops ("teal" and "green"), so some variants appear twice.
- **Oral-B head types** (CrossAction, PureClean, Sensitive Clean) stay "possible" matches.
- **Category guessing is a word list.** Unusual products fall back to all shops; a wrong hint can
  leave out a shop that sells the item.
- **Order value for delivery prices** is the single item's price; no basket is modelled.
- **Unknown delivery facts:** Mironet.cz, Dr.Max, Teta, Sanitino, MediaMarkt.de and .at, 101 Drogerie;
  pickup at Hornbach, Alza.sk, Planeo, Datacomp and Profimed (offered, fee not stated).
- **Unknown Košice branch:** TPD, MojaLekáreň, Vaša Lekáreň (pickup in its pharmacies), Nazuby.eu,
  Holime.eu, Sanitino.
- **AGEM (agem.sk)** was left out: its product data has a stray character after the JSON, so it does
  not parse. A tolerant parser would make the shop readable.
- **Shops checked and found blocked** on 2026-11-24, so not added: Benu lekáreň, Kasa.sk, Kaufland.sk
  marketplace, Müller, Vivantis, Smarty.cz, TSBohemia. No Czech shop that delivers to Slovakia was
  found readable.
- **Nazuby.eu delivery price.** Its structured data lists a 0 € delivery option for Slovakia next to
  the paid ones, so a total can show free delivery below the shop's free-delivery threshold (54.90 €).
- **Pages without product data** count as "not a product page" only once the shop is known to publish
  product data (set in `data/shops.yaml`, or seen on one of its pages in the last 30 days). Before
  that, the shop reads as `needs_js`.
- **The word list for article pages** (review, manual, comparison) could in rare cases skip a real
  product whose name contains such a word.
- **Out-of-stock offers** are listed with their price like any other; the stock column says so, but
  they are not ranked lower.
- **Out-of-credit handling** for Brave (402) and Serper is tested with mocks only, never seen live.
- **An HTTP 503 from an unknown vendor** is treated as `blocked`.
- **Rejected candidates** are not listed among "other products"; only their title appears in the
  shop's detail line.

## Code issues found in review

Found while writing [architecture.md](architecture.md). Not fixed yet.

- **A closed page does not stop its search** (`src/app.ts`). When the browser disconnects, shop
  searches already started keep making requests, and the search is missing from the history.
- **Unknown fields in `data/shops.yaml` are dropped silently** (`validateShops` in
  `src/core/shops.ts`), and `categories` values are not checked, so a typo means the shop is never
  asked in Auto mode. Warn on unknown keys and unknown categories.
- **The portability rule is not enforced.** `tsconfig.json` gives every folder Node types, so a
  `node:` import in `src/core/` would pass the type check. Add a check (a test that scans imports,
  or a separate tsconfig for core).
- **The page repeats core logic.** `public/app.js` re-implements the headline price, the offer
  sorting and the status summary; a rule change needs two edits. Send the computed values from the
  server instead.
- **`registeredDomain` takes the last two labels** (`src/core/http.ts`), which is wrong for
  `co.uk`-style domains. No current shop is affected.
- **Pacing state for search providers is module-level** in core (`ProviderChain`), so it would be
  shared across requests on Cloudflare Workers.
- Small: a note about price-0 offers in `pipeline.ts` can never appear; duplicate stems in
  `vocab.ts`; a stale README reference in `src/node/setup.ts`; `tools/extract_fixtures.ts` stamps
  every fixture with a fixed date.

## Later

- **Per-branch stock and price.** Leads: IKEA's availability fragment, Hornbach's store id for
  Košice (746), MediaMarkt and Planeo pickup data. The shop model reserves `branches` for this.
- **Other cities.** Needs branch addresses (OpenStreetMap extract) and geocoding of the user's
  address (Nominatim, 1 request per second).
- **Product discovery from sitemaps.** Shops publish product sitemaps for crawlers. A local index of
  product URLs could replace the web search provider for some shops and remove the quota limit. Not
  explored; sitemaps of large shops are big.
- **A browser extension** that reads the price from pages the user opens themselves would cover
  shops that block automated clients, with no circumvention. Not explored.
- **Non-EU shops** (AliExpress, Temu): need the 3 € per item customs rule and VAT handling.
- **Sharing with another person**: a Cloudflare Tunnel to the local app, or hosting on Cloudflare
  behind a login. See research.md, section 9.
- **Groceries** through cenyslovensko.sk, only after its operator confirms the data may be used.
