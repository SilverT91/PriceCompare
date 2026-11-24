# Roadmap

Where the project stands and what comes next. Update this file when a round of work finishes.

## State on 2026-11-24

The first version works end to end: web page, command line, 134 unit tests passing.

| Search | Result |
|---|---|
| iPhone 16 128GB | Useful: NAY in Košice 849 € with free pickup, iStores 959 € delivered, Andreashop 981.99 € delivered |
| Bosch GSR 12V-15 | Partial: Hornbach Košice 133.20 €; the other offers are a different kit or do not reach Slovakia |
| Oral-B Pro 3 3000 | Nothing that reaches Slovakia: the only offers were from Morele.net, which does not deliver here |

**The weak point is coverage, not the mechanics.** Of 30 non-food shops, about 6 produce offers for
an electronics query, 7 to 9 are blocked on a given day, 2 need JavaScript, and several have no
route. The toothbrush case, which is the kind of product the tool was asked for, comes back empty.

Search quota used so far: Brave 39 requests (of about 1,000 per month), Serper 45 (of 2,500 in
total).

## Next round

In this order.

1. **Fix the drugstore and small-appliance case.**
   - Add Slovak shops that sell these goods and can be read: check candidates with
     `tools/probe_shops.py` or `tools/fetch_info.ts` before adding them to `data/shops.yaml`.
   - Find out why Dr.Max, Pilulka and Teta return no matching page through web search for a
     toothbrush: wrong query form, pages not indexed, or they do not sell the model.
   - Test with the exact model the first user was looking for, once known.
   - When a shop's own search page works but returns nothing matching, the shop ends as `no_match`
     and the web-search route is never tried (`src/core/pipeline.ts`). Try the second route before
     giving up, and measure what it costs in queries.
2. **Read the JavaScript-only shops** (dm / mojadm.sk and Planeo) with a real browser engine
   (Playwright), as a new route for shops marked `needs_js`.
   - Same request rules: robots.txt, 3 seconds per host, a plain honest identity, no stealth
     settings. A challenge page means `blocked`.
   - It is Node-only, so it belongs outside `src/core/`, behind an interface the pipeline calls.
   - The README's request rules currently say "no headless browser"; update that section when this
     lands, keeping the ban on using one to get around protection.
3. **Look for an official route to the blocked shops** (Alza, Notino, MediaMarkt): affiliate
   programmes or product feeds. Not yet investigated.

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
- **Unknown delivery facts:** Mironet.cz, Dr.Max, MediaMarkt.de and .at, 101 Drogerie, pickup at
  Hornbach, Alza.sk and Planeo.
- **Out-of-credit handling** for Brave (402) and Serper is tested with mocks only, never seen live.
- **An HTTP 503 from an unknown vendor** is treated as `blocked`.
- **Rejected candidates** are not listed among "other products"; only their title appears in the
  shop's detail line.

## Code issues found in review

Found while writing [architecture.md](architecture.md); none is fixed yet.

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
- **`needs_js` has two meanings**: the shop is marked so in the database (not fetched), or pages
  were fetched and had no product data. The README describes only the first.
- **`registeredDomain` takes the last two labels** (`src/core/http.ts`), which is wrong for
  `co.uk`-style domains. No current shop is affected.
- **Pacing state for search providers is module-level** in core (`ProviderChain`), so it would be
  shared across requests on Cloudflare Workers.
- Small: a note about price-0 offers in `pipeline.ts` can never appear; duplicate stems in
  `vocab.ts`; a stale README reference in `src/node/setup.ts`; `tools/extract_fixtures.ts` stamps
  every fixture with a fixed date; the README omits the `--no-cache`, `--location` and `--width`
  command-line options.

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
