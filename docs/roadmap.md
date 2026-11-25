# Roadmap

Where the project stands and what comes next. Update this file when a round of work finishes.

## State on 2026-11-25 (after the fourth round)

The app works end to end: web page, command line, unit tests passing. The database has 39 non-food
shops in scope.

What the fourth round did (a short one, the same day):

- **Similar models, tidied.** The same model written two ways is one entry: "Pro 3500" at two shops
  joins "Pro 3 3500" at four, so for "Oral-B Pro 3 3000" the list starts with "Oral-B Pro 3 3500"
  at 6 shops. The rule: a shorter name joins a fuller one when it uses only the fuller name's words
  and the fuller name, searched for, finds the shorter listing with nothing missing but a line
  digit. Names are written as the query writes its own words ("Pro", not "PRO"), and a long word in
  capitals gets one capital ("SERIES" becomes "Series").
- **Product names in "Which one do you mean?"** no longer carry the shop's suffix, an appended
  cashback promotion, a doubled title or a leading specification list. Bundle contents after "+"
  stay. The offer rows keep the shop's own title.
- **A price for the closest similar models.** When no product matches exactly, one shop page is
  read for each of the first three models in the list, and the price is shown with the shop, a
  link and a warning that it may not be the same product. No price filter (see
  [decisions.md](decisions.md)). For "Oral-B Pro 3 3000": Pro 3 3500 at 74.99 € and Pro 3 3900 at
  69.99 € (both Planeo, Košice), iO Series 3 at 64.90 € (NAY, Košice).
- **Browser engine: decided, not in the app for now** (see [decisions.md](decisions.md)). A
  measurement tool, `tools/render_probe.py`, is written for the day the question comes back. Its
  first measurement, on dm's product page, supports the decision: the page needs several of dm's
  other hosts and more than 71 requests before a price could be read.

What the third round did:

- **Similar models the shops list.** When no shop lists exactly what was typed, the page shows the
  neighbouring models the search came across (same brand and line), with the shops that list each
  and a "Compare this model" button that starts a new search. For "Oral-B Pro 3 3000" the list
  starts with the Pro 3 3500 (4 shops), the Pro 3 3900 and the iO Series 3 (6 shops). It uses only
  what a search already collected: no extra requests.
- **Order of products:** a product that can reach Slovakia comes before one that no shop delivers.
- **Matcher:** "Použitie:" ("Use:") in a title is no longer read as a used item; Slovak "súprava" is
  a package word; advice pages that start with a question word are not product pages.
- **Delivery and branch facts** read again from the shops' own pages: Teta's delivery prices, free
  store pickup at Planeo, pharmacies of Vaša Lekáreň in Košice, no Košice place for TPD and
  MojaLekáreň.
- **Official routes to shops that do not allow automated reading** were researched
  ([research.md](research.md), section 10). None is open to a local tool with no public website.
- **A browser engine was tried by hand on two pages.** dm's product page carries full product data
  (price, GTIN, stock) once rendered. Pilulka's page for the Oral-B Pro 3500 does not, in a browser
  either: the product is currently unavailable there, which explains the pages without data seen
  in the second round.

What the test searches give (the first four measured on 2026-11-24, the last on 2026-11-25):

| Search | Result |
|---|---|
| iPhone 16 128GB | Useful: NAY in Košice 849 € with free pickup, iStores 959 € delivered, Andreashop 981.99 € delivered |
| Bosch GSR 12V-15 | Partial: Hornbach Košice 133.20 €; the other offers are a different kit or do not reach Slovakia |
| Oral-B iO Series 3 | Useful: 12 shops with offers. From 59.90 € (62.89 € delivered) at Andreashop and TPD; NAY in Košice 64.90 € with free pickup; also Planeo, Profimed, MojaLekáreň, Nazuby.eu, Teta, Sanitino |
| Oral-B Pro 3 3000 | One possible offer: Nazuby.eu lists a "PRO 3000 Blue" at 62.01 € (64.50 € delivered), to be checked by the user. The model appears to be leaving the shelves: NAY's pages for it answer 404 and the other shops list its successors, which the page now offers as similar models. Morele.net has it but does not deliver here |
| Oral-B PRO 3 3500 (reached through "Compare this model") | Thin as well: Planeo in Košice 74.99 € (out of stock), Nazuby.eu 68.22 € (70.71 € delivered, possible match), TPD an ex-display piece at 49.99 € |

What the second round did (2026-11-24):

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
pages carry no structured data because the products are currently unavailable there. Teta does not
appear to list the model.

Of the 39 shops, on 2026-11-24: 12 produced offers for a toothbrush, 9 were blocked, 2 could
not be read without a browser, 2 have no automatic route, 7 had nothing matching, 7 were not asked
(wrong category).

A product search costs about 5 to 7 web queries with nothing cached (3 to 4 before the second
route). Search quota used so far: Brave 59 requests (of about 1,000 per month), Serper 45 (of 2,500
in total). The third round used 7 Brave requests, for one live search; the fourth used none (it
worked from the cache).

## Next round

In this order.

1. **Test with the exact model the first user was looking for**, once known.
2. **Work through "Code issues found in review"** below; none blocks use.
3. **Browser engine: nothing to do now.** `tools/render_probe.py` measured dm's product page
   (numbers in [architecture.md](architecture.md), section "Add a new route for reading a shop"):
   it needs dm's assets host and data hosts let through, more than 71 requests per page.
   Use the tool on any other shop that reads as `needs_js` before reopening the decision. If a
   browser engine is ever built:
   - Make it optional: the app runs without it, and `needs_js` shops keep their manual link.
   - Same request rules: robots.txt, 3 seconds between page loads, a plain honest identity, no
     stealth settings. A challenge page means `blocked`.
   - It is Node-only, so it belongs outside `src/core/`, behind an interface the pipeline calls.
   - The README's request rules say "no headless browser"; update that section when this lands,
     keeping the ban on using one to get around protection.

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
- **Unknown delivery facts** (after a second reading on 2026-11-25): Mironet.cz (pickup points
  marked "ČR a SK", no Slovak prices), Dr.Max, MediaMarkt.de and .at (pages answered 403), Sanitino
  and 101 Drogerie (no prices on their pages); pickup at Hornbach (the page needs JavaScript),
  Alza.sk (403), Datacomp and Profimed (offered, fee not stated), Vaša Lekáreň (offered in
  "selected" pharmacies, not said which).
- **Unknown Košice branch:** Nazuby.eu, Holime.eu, Sanitino, Teta (its store page shows only the
  stores nearest to the reader).
- **Planeo pickup** is recorded as free from the shop's general delivery page, which names no store.
- **AGEM (agem.sk)** was left out: its product data has a stray character after the JSON, so it does
  not parse. A tolerant parser would make the shop readable.
- **Shops checked and found blocked** on 2026-11-24, so not added: Benu lekáreň, Kasa.sk, Kaufland.sk
  marketplace, Müller, Vivantis, Smarty.cz, TSBohemia. No Czech shop that delivers to Slovakia was
  found readable.
- **Nazuby.eu delivery price.** Its structured data lists a 0 € delivery option for Slovakia next to
  the paid ones, so a total can show free delivery below the shop's free-delivery threshold (54.90 €).
  Its delivery page lists three paid options and no 0 € one, so where the entry comes from is open.
- **Pages without product data** count as "not a product page" only once the shop is known to publish
  product data (set in `data/shops.yaml`, or seen on one of its pages in the last 30 days). Before
  that, the shop reads as `needs_js`.
- **The word list for article pages** (review, manual, comparison) could in rare cases skip a real
  product whose name contains such a word.
- **Out-of-stock offers** are listed with their price like any other; the stock column says so, but
  they are not ranked lower.
- **Out-of-credit handling** for Brave (402) and Serper is tested with mocks only, never seen live.
- **An HTTP 503 from an unknown vendor** is treated as `blocked`.
- **Similar models:**
  - A shorter form with an extra word of its own is not merged ("Elktrická Pro 3500", a shop's
    spelling; "EK Pro Kids 3+").
  - "Pro 3 Kids" and "Pro Kids 3+" count as one model because they have the same words; the "3"
    may mean the line in one title and the age in the other.
  - A merged model can carry an edition name ("Oral-B Pro 3 Frozen junior").
  - Short words in capitals stay as the shop writes them (so "OLED" is safe, and "IO" for "iO"
    stays too).
  - Replacement heads whose title has no accessory word ("Precision Clean Pro") appear as a model.
    The two listings give no sign (no piece count, no category word). Other shops' titles for the
    same heads do say "náhradné hlavice", but they fall outside the 10 candidates kept per shop,
    and a rule built on them would also hit a brush sold with spare heads.
  - Titles that are a specification list without bullets fail the name check and are left out.
  - Only the 10 best candidates per shop are kept, so a neighbour further down a shop's results is
    not seen.
  - Only the first three models get a price, each from one page. The price is the item price,
    without delivery, and an out-of-stock offer gives a price like any other.
  - In the live check one price came from a page read for it (one shop request) and two from
    pages already in the cache. A shop asked twice in one search has been seen in tests only.
  - The history of searches does not record how many prices were read.
- **Product names** in "Which one do you mean?" are tidied, but only a promotion written as
  "+ cashback ..." is removed. Other promotion wording ("+ darček", "zdarma", "akcia") stays in the
  name.

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
