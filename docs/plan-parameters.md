# Plan: parameters and filters (computers, phones, later other categories)

Status: proposed on 2026-11-28, not built. Four questions for the owner are at the end; phase 1
needs none of them answered.

## What it should do

Today the app compares one named product across shops. This adds a second way to use it:

- **Configuration view.** After a search that hits a line with many configurations ("HP Z2 Tower
  G1i", "iPhone 17"), show them in a table with their parameters (processor, graphics card and its
  memory, RAM, disk, power supply; for phones storage, RAM, colour) and filter or sort it: VRAM at
  least 24 GB, RAM at least 64 GB, price at most 6,000 €.
- **Local catalogue.** Every search stores the products it saw with their parameters in the local
  SQLite database. Filters can then run over everything seen so far, not only the last search,
  with the date each price was read and a button that searches that product again for a fresh
  price.

What it does not do: decide which configuration is "better". It shows the parameters side by side;
the person judges.

## The rules it must keep

The request rules, "do not guess facts" and "prices only from schema.org JSON-LD, no per-shop CSS
selectors" all stay. In practice:

- A parameter is read from text the app already has or reads under the same rules: the offer's
  title, and the JSON-LD on product pages it already fetches. No HTML parameter tables (that would
  need per-shop selectors).
- Every parameter carries where it came from (title, JSON-LD, another shop's offer of the same part
  number, a reference table) and the page shows it. What is not known stays unknown, and a filter
  shows unknown values separately instead of hiding them.
- Reference facts the app adds itself (a graphics card's memory and bandwidth) live in a data file
  with a source URL and date, like the shop facts.
- No extra web search queries for parameters.

## Where the parameters come from

| Source | Cost | What it gives | Measured? |
|---|---|---|---|
| Offer titles | nothing | ABCOM, Mironet and others write the configuration into the title: "HP PC Z2 Tower G1i 700W, Intel Core U9 285K vPro, RTX Pro 4000Bl 24GB, 2×16GB DDR5, 1TB" | the matcher already splits these lists |
| JSON-LD `additionalProperty`, `description`, `model` on product pages already read | nothing extra | named values ("Operačná pamäť: 64 GB") where a shop publishes them | no: phase 0 measures it |
| Another offer of the same product | nothing | specifications borrowed through a shared part number, GTIN or long model code (Datacomp names a configuration only by part number; ABCOM lists its specifications) | grouping already joins them |
| Reference tables in `data/` | nothing | facts that follow from a part's name: RTX PRO 4000 Blackwell → 24 GB, 672 GB/s | to be written, with sources |
| An open product catalogue (for example Open Icecat) | an account and a documented API | specifications by GTIN or manufacturer part number | no: its terms and coverage are unchecked (question 3) |

## Data model

`data/parameters.yaml` defines the parameters per category, not per shop:

```yaml
computer:
  cpu:     { type: text }
  gpu:     { type: text }
  vram_gb: { type: number, unit: GB, from: [gpu] }      # also from the reference table
  ram_gb:  { type: number, unit: GB, labels: [RAM, Operačná pamäť, Operační paměť, Pamięć RAM, Arbeitsspeicher] }
  disk_gb: { type: number, unit: GB }
  psu_w:   { type: number, unit: W }
phone:
  storage_gb: { type: number, unit: GB }
  ram_gb:     { type: number, unit: GB }
  colour:     { type: text }
```

The `labels` are the words shops use in JSON-LD property names, in the languages of the shops.
`data/gpus.yaml` holds the reference facts (memory, bandwidth, power) with source and date.

New tables in the SQLite store (`src/node/db.ts`):

- `products`: one row per product the app has seen. Key: GTIN, else part number, else brand and
  model code. Category, name, first and last seen.
- `params`: product, parameter, value, unit, source (`title`, `jsonld`, `borrowed`, `reference`,
  `catalogue`), source URL, read at. Several sources for one parameter are kept; a conflict is
  shown, not resolved silently.
- `prices`: product, shop, price, currency, availability, URL, read at. History comes free.

Code: `src/core/params.ts` (portable: titles and JSON-LD properties to parameters, using
`specList()` and `processorSpan()` from the matcher), `src/core/jsonld.ts` keeps
`additionalProperty` and `description`, `src/node/db.ts` stores, `GET /api/catalogue?cat=computer&vram_gb_min=24&ram_gb_min=96&price_max=6000`
filters, and the page gets a table with filters (both languages).

## Phases

**Phase 0: measure (no code in the app).** Read 10 to 20 computer and phone product pages the cache
already knows, under the request rules, and count which shops publish `additionalProperty` and
which parameters it holds. Read the open catalogue's terms and coverage. Result: a table in
`research.md` that says which sources are worth building.

**Phase 1: configuration view for one search.** Parameters from titles and from JSON-LD of the
pages the search reads anyway; borrowing within a product; the reference table for graphics cards;
a table with filters and sorting on the page. Nothing stored yet. This is the view proposed after
the workstation test, and it already answers "which Z2 G1i configurations have 24 GB and 64 GB,
and at what price".

**Phase 2: local catalogue.** Store products, parameters and prices from every search; a filter
page over everything seen, with the date of each price and a button to search it again.

**Phase 3: finding more products (needs question 2).** The catalogue only knows what was searched.
Ways to widen it, from least to most load on the shops:
1. A watch list: lines the owner names ("HP Z2 Tower G1i", "Lenovo ThinkStation P3"), searched
   again on request.
2. Search by part: "RTX PRO 4000" finds computers that contain it (today a whole computer is
   another product for a part's name, on purpose; this would be a separate mode).
3. Reading shop category pages ("Workstations"), where robots.txt allows it: many more requests,
   so opt-in, slow (3 s per page per shop) and with its own limit.

**Phase 4: an open product catalogue (needs question 3)**, for shops that name a configuration only
by part number.

## Questions for the owner

1. **Categories first:** computers (desktops and laptops) and phones, then monitors and SSDs? Or
   another order?
2. **Finding products:** only from searches you run plus a watch list (options 1 and 2 above), or
   also reading shop category pages (option 3)?
3. **An open product catalogue** needs an account with its provider. Should phase 0 look into one?
4. **Unknown values in a filter:** shown in a separate group below the matches (proposed), or
   hidden?
