# Roadmap

Where the project stands and what comes next. Update this file when a round of work finishes.

## State on 2026-11-25 (after the sixth round)

The app works end to end: web page, command line, unit tests passing. The database has 39 non-food
shops in scope.

What the sixth round did (the same day):

- **Computer parts.** Six searches typed loosely (an SSD, a processor, a graphics card, a mouse,
  memory, a laptop) showed that specifications in titles were read as model numbers. The matcher
  now treats them as specifications; the same six searches, without a search key, went from 13
  shop results to 26. Category hints for computer parts keep such searches away from drugstores
  and DIY stores.
- **The page speaks Slovak** as well as English, with a switch; sentences from the search, shop
  notes and match reasons included.
- **Credit bars** in the page footer show how much of each web search allowance is used.
- **ASBIS SK** is listed for its manual link (no product data on its pages); two other computer
  shops could not be reached from this client.

What the fifth round did (the same day):

- **The first user's own sentence works.** He typed "Iral b io9 doublepack" (an Oral-B iO 9 pack
  of two). Before this round every shop title was rejected. Now:
  - a brand typed with one wrong letter is searched as the brand, and the page says so, with a
    link to search exactly as typed;
  - "io9" matches "iO Series 9" and "iO 9";
  - the words for a pack of two (duo, duopack, doublepack, "Duo Pack", "Súprava ... Duo Pack",
    "Duo, 2 ks") are one thing, still different from the single brush;
  - a shop whose own search finds nothing for a query with a package word is asked once more
    without it.
- **Install guide for Windows** in the README (winget, Node.js 26, Git, four commands).
- **Search providers for a second user** were researched ([research.md](research.md), section
  11). Without a key the app still works at the shops whose own search may be read. The least
  effort with a key is Serper: no payment card, 2,500 queries.
- **Tavily is a third provider** (no card, 1,000 credits a month), last in the default order. On
  the same four searches it gave a matching offer at 5 shops where Brave gave 10, so it is a
  fallback.
- **A pasted product link is a query.** The first user asked for it. The name is taken from the
  address; the page is not fetched.
- **Language-specific words stay at home.** Shops outside Slovakia get the query without category
  and colour words; colours are compared across languages.

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

What the test searches give (the first four measured on 2026-11-24, the last two on 2026-11-25):

| Search | Result |
|---|---|
| iPhone 16 128GB | Useful: NAY in Košice 849 € with free pickup, iStores 959 € delivered, Andreashop 981.99 € delivered |
| Bosch GSR 12V-15 | Partial: Hornbach Košice 133.20 €; the other offers are a different kit or do not reach Slovakia |
| Oral-B iO Series 3 | Useful: 12 shops with offers. From 59.90 € (62.89 € delivered) at Andreashop and TPD; NAY in Košice 64.90 € with free pickup; also Planeo, Profimed, MojaLekáreň, Nazuby.eu, Teta, Sanitino |
| Oral-B Pro 3 3000 | One possible offer: Nazuby.eu lists a "PRO 3000 Blue" at 62.01 € (64.50 € delivered), to be checked by the user. The model appears to be leaving the shelves: NAY's pages for it answer 404 and the other shops list its successors, which the page now offers as similar models. Morele.net has it but does not deliver here |
| Oral-B PRO 3 3500 (reached through "Compare this model") | Thin as well: Planeo in Košice 74.99 € (out of stock), Nazuby.eu 68.22 € (70.71 € delivered, possible match), TPD an ex-display piece at 49.99 € |
| Iral b io9 doublepack (the first user's sentence, searched as "Oral-B io9 doublepack") | Useful: NAY in Košice 297.90 € with free pickup, MojaLekáreň 299.96 € delivered (possible match), Profimed 450.90 € (out of stock). Datart.cz and Morele.net list it but do not deliver to Slovakia. Without a search key: the NAY offer only |
| https://www.alza.sk/roborock-qrevo-edge-2-pro-d13260955.htm (a link the first user pasted, searched as "Roborock Qrevo Edge 2 Pro") | Useful: 7 shops with offers. TPD Euronics and Andreashop 699 € (701.99 € delivered), Datacomp 709.89 €, NAY in Košice 709.90 € (in store only), ABCOM Košice 917 € (out of stock). Datart.cz and Morele.net list it but do not deliver to Slovakia. Alza itself is blocked and gets a manual link |
| Samsung 990 Pro 2TB (no search key) | Useful: NAY and Datacomp 474.90 € (with heatsink, possible), Mironet.cz 481.17 €, ABCOM Košice 515 € |
| ryzen 7 9800x3d (no search key) | Useful: Datacomp 379.90 € and Mironet.cz 422.71 € (tray versions, possible), NAY 453.90 € |
| rtx 5070 ti (no search key) | A choice of five specific cards, 1,594 € to 1,869 €, each at one shop |
| logitech mx master 3s (no search key) | Useful: 6 shops, from 77.25 € (Mironet.cz); NAY 79.90 € |
| kingston fury 32gb ddr5 6000 (no search key) | Partial: 4 shops, from 737.64 €; a 64 GB kit of two 32 GB modules is offered as possible |
| notebook lenovo ideapad slim 5 16 (no search key) | A choice of two models at 5 shops, from 839 € (NAY) |

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
route). Search quota used so far: Brave 94 requests (of about 1,000 per month), Serper 45 (of 2,500
in total), Tavily 27 (of 1,000 per month). The third round used 7 Brave requests, for one live
search; the fourth none (it worked from the cache); the fifth 8 for the first user's sentence,
then 13 Brave and 27 Tavily for the measurement of Tavily. The search from a pasted link used 5 more Brave requests. Repeating it after the cross-language change used 9 more, because foreign shops' queries got new cache keys.

## Next round

In this order.

1. **More real queries from the first user**, typed as he types them, in several categories.
   Run each without a key first (no quota), then with a key where it matters. His first two
   inputs each showed something the tidy test queries had not.
2. **Re-check the provider table in the README** ("Where to get a key") from time to time and
   update its date. Tavily stays a fallback: one query per shop was tried for the first user's
   sentence and found nothing either. Its `language` parameter is untried.
3. **Read Brave's terms on keeping results.** Its FAQ says storing results needs a plan with
   storage rights; the app keeps web search results for 6 hours. If the terms do not allow that,
   shorten or drop the cache for Brave.
4. **Similar models, third pass.** The first user's search showed rough names (see known
   problems).
5. **Work through "Code issues found in review"** below; none blocks use.
6. **Browser engine: nothing to do now.** `tools/render_probe.py` measured dm's product page
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
- **Query correction** changes a real word that is one letter from a long brand ("brain" to
  Braun, "apply" to Apple). The line above the results and the link to search as typed are the
  only guard. Brands of four letters (Sony, Dell, Acer, Asus, IKEA) are not corrected at all, nor
  are typos of two letters.
- **The repeat without package words** also drops tool package words ("solo", the battery words),
  so "Bosch GSR 12V-15 solo" is repeated as "Bosch GSR 12V-15" when the first search is empty. The
  kits that come back stay `different`; it costs one request.
- **"Series" is now a neutral word**, so "Oral-B iO Series 3" matches a title "Oral-B iO 3"
  exactly.
- **"iO Series 9N"** (MediaMarkt Austria's duo pack) counts as a different model from "iO 9".
- **A name taken from a link** can be long when a shop puts a description into its addresses
  ("Oral-B Vitality Pro Cerny Elektricky Zubni Kartacek ..."). A trailing model code of one letter
  and four or more digits ("s9000") is read as an id and dropped.
- **Category words the matcher does not know** leave a correct offer as "possible" ("Robotický
  vysávač Roborock Qrevo Edge 2 Pro biely").
- **A kit counted by its modules.** "64GB (2x32GB)" is offered as a possible match for "32gb".
- **Laptops with a long specification list** in the title ("... 16IMH10 - Ultra 5 135H,16" ...")
  stay rejected: the processor's name reads as a model number.
- **Power in watts** is treated as a variant, so a graphics card title that states a recommended
  power supply is "possible", not exact.
- **Variant labels** show the matcher's folded words ("biela, robot"), not the shop's wording.
- **Slovak wording** was written by a model and read once; a native speaker should read the
  glossary in `public/i18n.js`, `src/core/i18n.ts` and `data/shops.sk.yaml`.
- **Credit bars:** Brave's own figure covers 30 days and every use of the key, the app's count a
  calendar month and this app only, so the bar can jump when the source changes. Tavily documents
  a usage endpoint but not whether calling it is free, so it is not used.
- **Category word** "robot" (Polish "Robot sprzątający") still leaves an offer as "possible".
- **Similar models:**
  - Accessories whose link text runs words together ("Roborock Vacuum Cleaner
    AccessoryRoborockRotating Mop Cloth...") appear as models with very long names.
  - Rough names seen in the search for "Oral-B io9 doublepack" (the list is collapsed there,
    below an exact match): "DUO na Oral-B", "Oral-B Oral B IO 9" (the brand twice),
    "Oral-B iOM9D.2J2.2AD Duo" (an order code as the name), "Oral-B iO Series 6 Duo 2", and one
    name made of a whole specification sentence where a shop's link text runs the name and the
    description together.
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
