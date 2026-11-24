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
