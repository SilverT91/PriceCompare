# Decisions

The choices that shape this project, with the reason for each, so they are not reopened without new
information. Dates are when the decision was made. Background facts are in
[research.md](research.md).

## Build, not adopt (2026-11-24)

The specific combination asked for (shops with a local branch plus web shops from several countries,
in one list) is not something the existing services or open-source projects are built for. They
remain the right tool for what they do: the app links to Heureka.sk for every search, and never
fetches it.

## Scope: non-food goods only (2026-11-24)

The person who asked for the tool wanted to compare things like an electric toothbrush. Groceries
are out: the only real source (cenyslovensko.sk) has unclear reuse terms and covers basic foods
only. Supermarkets stay in `data/shops.yaml` with `in_scope: false`.

## Location: Košice first; web shops from any country (2026-11-24)

The local side is Slovakia, with Košice as the only city that has data. Web shops count from any
country as long as they deliver to Slovakia. Location is a setting, and `branches` is reserved in
the shop model, so other cities can be added without redesign.

## A local app, not a hosted one (2026-11-24)

It runs on the user's own machine. Requests come from a home connection, which shops block less;
there are no hosting limits; nobody else can use up the search quota; and it stays a personal tool.
Hosting on Cloudflare remains possible later, which is why the core is kept portable.

## Node + TypeScript + SQLite (2026-11-24)

- One language for the page and the server.
- Node 26 runs TypeScript directly and includes SQLite (`node:sqlite`), so there is no build step,
  no database server and no native module to compile.
- Cloudflare's free database is SQLite as well, so a later port changes the outer layer only.
- Rejected: Python + Streamlit (fastest first screen and better extraction libraries, but poor at
  progressive results and a custom comparison layout, and it cannot move to Cloudflare);
  Docker + Postgres (a server to run for about 30 shops of data).
- The Python probe (`tools/probe_shops.py`) stays as a measurement tool only.

## Core is portable; Node-specific code is separate (2026-11-24)

`src/core/` uses only standard web APIs. HTTP server, SQLite, file access and the command line live
in `src/node/`. This is a requirement, not a preference: it is what keeps the Cloudflare option open.

## Two ways to find a product page (2026-11-24)

1. The shop's own search page, when robots.txt allows it.
2. Otherwise a web search restricted to the shop's domain.

The probe showed 12 of 30 shops disallow their search page but allow their product pages, so the
second route is needed for about 40% of shops.

Amended the same day: when the shop's own search works but finds nothing matching, the web search
is tried as well before the shop is reported as `no_match`. A shop's search page often lists
related products first and misses the exact one. This costs one or two more web queries per product
search; the limit of 6 requests per shop covers both routes together.

## Brave first, Serper as fallback (2026-11-24)

Both found the right pages equally often in the measurement. Brave's free credit renews every month
(about 1,000 requests); Serper's 2,500 are one time. Several shop domains go into one query, which
costs 3 to 5 queries per product search. The order is a setting (`SEARCH_PROVIDERS`).

Amended 2026-11-25: Tavily is a third provider, last in the default order. It was added because it
needs no payment card and its free allowance renews monthly, which suits a second user. In the
measurement that day it returned pages at fewer shops than Brave on the same four searches (5
shop results against 10), so it stays a fallback and is not recommended as the only provider.

## Read prices from schema.org JSON-LD only (2026-11-24)

Every readable shop in the probe published JSON-LD `Product` data. There are no per-shop CSS
selectors: they break silently when a shop changes its page. A shop without structured data
(Amazon.de) gets `no_route` and a manual link.

## Never get around bot protection (2026-11-24)

A shop decides who may read its pages automatically, and the app respects that decision.
No proxies, no browser impersonation, no CAPTCHA handling. A shop that blocks the app is shown as
`blocked` with a link the user can open themselves. This costs real coverage (Alza, Notino,
MediaMarkt on many days) and is accepted. The full request rules are in the README.

Rendering a JavaScript-only page in a real browser engine, for a shop whose robots.txt allows the
page and which does not block it, is not circumvention and is planned (see
[roadmap.md](roadmap.md)). If such a shop answers with a challenge, it is `blocked` like any other.

## Honest results over complete-looking results (2026-11-24)

- Every shop ends with an explicit status; none is silently missing.
- Unknown shipping is shown as unknown and never counted as zero.
- An uncertain match is shown as "possible, check it", not hidden and not presented as certain.
- Shops that do not deliver to Slovakia stay visible but are not ranked.
- Facts in `data/shops.yaml` (branch, pickup, delivery) carry a source URL and a date. Where a fact
  could not be found it stays `unknown`; nothing is guessed.

## Two-step search (2026-11-24)

The user first picks which product they mean from the distinct products found, then sees the
comparison for that one, because one model is often sold in several variants. Offers are grouped by
normalised GTIN, then by manufacturer order code, then by brand and model tokens.

## Similar models come from what the search already saw (2026-11-25)

When no shop lists exactly what was typed, the app offers neighbouring models of the same brand and
line. They are taken from the candidates and pages the matcher rated as another product, so the
list costs no extra shop requests and no extra web queries. Consequences that are accepted:

- The list is not a comparison. Comparing a model is a new search, started by the user with one
  click.
- Order: the same line with another number first, then the models most shops list. How many shops
  list a model says more about what is on the shelves than fine differences in the name.
- A name is only offered when searching for it would find its own listing again.

Amended the same day: the first three models in the list get a price from one shop page each (at
most three shop requests per search, no web search queries), so the user can judge a model before
spending a new search on it.

## A price hint carries a warning, not a filter (2026-11-25)

A price shown next to a similar model comes from one page and from a looser match than the main
comparison, so it can belong to another product. Two ways to handle that were weighed: assume the
price should be close to the others and drop outliers, or show it with a warning. The owner chose
the warning. A filter would hide a real sale or an older model sold off, which are the cases a
user most wants to see. Every such price is shown with a warning sign, the shop and a link to the
page it was read from.

## Partner programmes are not pursued while the app is local (2026-11-25)

Shops that do not allow automated reading offer data, if at all, through affiliate programmes and
networks. Those are built for publishers with a public website and review each site, so a local
tool does not qualify (see [research.md](research.md), section 10). This is revisited only if the
app is ever hosted as a public site, or when Alza releases the partner API it has announced.

## No browser engine in the app for now (2026-11-25)

A browser engine would make one more shop readable today (dm, whose product data appears only after
JavaScript runs). Against that stand a large dependency and a request rule that cannot hold in the
same way: the 3 seconds between requests can govern page loads, but a page's own scripts and data
calls go out when the page makes them. The owner decided to leave it out until another use for it
turns up.

What is prepared: the design of the route (see [architecture.md](architecture.md), "Add a new route
for reading a shop") and a measurement tool, `tools/render_probe.py`, that shows for any page what a
browser engine would add over a plain request. A shop that looks unreadable can be measured with it
before this decision is reopened.

Measured with the tool the same day, on one dm product page: with every host outside mojadm.sk
switched off the page stays empty (3 requests). With dm's assets host allowed it renders some text
but still no product data, after 71 requests and about 2 MB; the product data would need three
more hosts on dm's own services domain, which were not tried. So for dm a renderer means more than
71 requests to several hosts for one price, nearly all of them less than 3 seconds apart. That
supports the decision.

## A corrected query is shown, and can be undone (2026-11-25)

The first user's own sentence had a typo in the brand, and nothing was found. The app now corrects
a brand that is one letter off, because a search that silently finds nothing teaches the user
nothing. The correction is deliberately narrow (brands of five or more letters, never a word the
app knows), it is always shown above the results with both forms, and one click searches exactly
what was typed. The matcher was also taught the ways people and shops write the same thing ("io9"
and "iO Series 9"; "doublepack" and "Duo Pack"), instead of expecting the user to know a shop's
spelling.

## A second user installs it without an account (2026-11-25)

The app must be useful with no key at all: shops whose own search may be read are asked, and the
rest get a manual link. A web search key is an option that widens coverage, and the README says
what each choice gives and how limited it is. The provider recommended for the least effort is the
one that needs no payment card. Only documented APIs are used; reading a search engine's result
pages, directly or through a self-hosted metasearch, stays out.

## A pasted link gives its words, and is not fetched (2026-11-25)

A user may paste the address of a product page instead of typing a name. The name is taken from
the address itself. The page is not read, whichever shop it belongs to: many of the shops people
copy links from do not allow automated reading, and a rule that depends on the host would be hard
to explain. Reading the linked page of a shop that allows it, for the exact name and GTIN, stays
possible later.

## Language-specific words go only to shops that understand them (2026-11-25)

Brand and model are the same in every language; category and colour words are not. Shops outside
the country searched from receive the query without them, when the rest still names a product.
The words are not translated: a missing word costs less than a wrong one. The match is judged
against everything the user typed, so the colour asked for still decides.

## Two languages, by code and not by sentence (2026-11-25)

The page speaks English and Slovak. What the search reports travels as codes and facts (status,
reason code with its words, amounts, dates), and each language writes its own sentence from
them. English stays the language of the stored and tested strings. Product titles and shop names
are never translated. Free-text notes about shops keep their English original in
`data/shops.yaml`, the file with the sources; the Slovak versions sit next to it in
`data/shops.sk.yaml`, and a test checks that both carry the same numbers, dates and addresses.

## The credit bars count what the app used (2026-11-25)

The page shows how much of each web search allowance is used, so a user sees it before it runs
out. The number is the app's own count of the calls it made, because that needs no request and
works for every provider. Where a provider states the remaining allowance in its ordinary
answers (Brave), that figure is shown instead. No request is made only to ask for a balance; a
provider's usage endpoint would be used only if its documentation says the call is free.

## Specifications are attributes, not identity (2026-11-25)

Titles of computer parts carry specifications that the matcher first read as model numbers, so
correct offers were rejected. A number with a unit, an interface name or a port list is now a
specification. One that changes what the buyer gets (capacity, memory speed, latency, screen size)
makes a match "possible" when the query does not state it; the others are ignored. A whole
computer that contains the part stays a different product, because it names other parts' model
numbers.

Amended 2026-11-28: when a title is the product's name followed by a list of its specifications,
and the name holds the query, the processor and graphics card in the list are the configuration,
not other products. The match is "possible", so the user checks the configuration.

## Configurations of one line are separate products (2026-11-28)

A computer line ("HP Z2 Tower G1i") is sold in configurations that differ in processor, graphics
card, memory and disk, at prices from about 2,300 € to 5,500 €. Shops name a configuration either
by its part number ("HP Z2 Tower G1i, EE7H6ES") or by listing its specifications after the name.
Both now count as what tells two products apart: two part numbers in one colour, or two different
specification lists, are two products in "Which one do you mean?". The same part number at two
shops is one product. Different part numbers in different colours stay colour variants of one
product, because that is how phones are numbered.

A typed or pasted title with its whole specification list is searched by its name, and the page
says so. Matching such a list word for word would find nothing, since every shop writes the
specifications its own way; choosing among the configurations found keeps the person in charge
of the comparison. Judging which configuration is "better" stays outside the app.

## Only ask shops in the query's category (2026-11-24)

A toothbrush query does not go to a furniture shop. Categories are guessed from the query with a
word list (`src/core/categories.ts`); with no hint, all shops are asked, and the user can always
widen to all shops. This saves shop requests and search quota.

## Public repository hygiene (2026-11-24)

- API keys live in `.env`, which is git-ignored. Key values are never printed, logged or put in
  fixtures.
- Test fixtures are trimmed JSON-LD blocks, not whole shop pages.
- No personal information in any file or outgoing request. The User-Agent is the generic
  `price-compare/0.1`.

## A local database, and a web search is not repeated for 14 days (2026-11-28)

The owner asked that the app ask again only what it does not already know, to save web search
credit, with two buttons: load from the local database, and check online.

- Every online search stores, without an expiry, the product pages it read (offers and
  parameters), which pages matched the query at each shop, and each shop's last result. "Load
  saved" shows that and asks nothing at all, with the date each price was read.
- "Check online" asks the shops as before (their own search and product pages cost no credit).
  For a shop whose web search for the same query was answered in the last 14 days, the pages it
  found are read again for current prices and the web search is not asked again; "found nothing"
  is not asked again either. "Search the web again too" asks it anyway. A product that a shop has
  newly listed can therefore be missed for up to 14 days at a shop reached only through the web
  search; the page says when shops were answered this way.
- What is kept is the app's own reading of the shops' pages and their addresses.

Amended the same day, after reading the providers' terms ([research.md](research.md), section 14):
Brave's terms forbid storing or caching its results beyond transient use, links included. So
nothing of a Brave answer goes into the local database: a shop reached through Brave is asked
through the web search again next time, and "Load saved" does not list what only Brave found.
Serper's and Tavily's terms say nothing about keeping results, so the reuse stays for them.

