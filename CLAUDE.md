# PriceCompare

A local app that compares the price of one non-food product across shops with a branch in Košice
(Slovakia) and web shops from any country that deliver to Slovakia. Node 26 + TypeScript + SQLite,
no build step. The repository is public.

## Read first

- `README.md`: what it does, how to run it, search keys, adding a shop, the request rules.
- `docs/roadmap.md`: current state, the next round of work, known problems. Start here to learn
  what to do next, and update it when a round finishes.
- `docs/decisions.md`: choices already made and why. Do not reopen them without new information.
- `docs/research.md`: market research, data sources, the shop probe, delivery facts.
- `docs/architecture.md`: how the code is organised and how a search flows through it.
- `docs/plan-parameters.md`: the planned parameters, filters and local catalogue (not built yet).

## Commands

```sh
npm test                               # unit tests, no network
npm run typecheck                      # tsc; Node itself only strips types
npm run search -- "iPhone 16 128GB"    # command-line search
npm start                              # page on http://localhost:8787
```

Run the tests and the type check after every change. A live search costs shop requests and search
quota, so use one only to check behaviour that tests cannot show.

## Rules that are not negotiable

1. **Request rules.** Every outgoing request honours robots.txt, keeps 3 seconds between requests
   to one host, never retries a 403 or 429, and uses the generic User-Agent. Never get around bot
   protection: no proxies, no browser impersonation, no CAPTCHA handling. A blocked shop is
   reported as `blocked`. The full list is in the README; these rules outrank coverage.
2. **Heureka is never fetched**, only linked to.
3. **Secrets.** API keys are in `.env` (git-ignored). Never print, log, echo or commit a key value,
   and never read `.env` into output. To check a key exists, check only that the name is set.
4. **Nothing personal in the repository or in requests**: no names, email addresses, usernames or
   machine paths in files, fixtures, the User-Agent or URLs.
5. **Search quota is small.** Brave: about 1,000 requests per month. Serper: 2,500 in total, one
   time. Never call a search API from a unit test. Reuse the 6-hour cache, and say how many queries
   a piece of work used.
6. **Respectful wording about other sites.** In docs, comments, page text and commit messages,
   describe shops and price comparison services neutrally: what they cover and what this tool does.
   No "better than" claims and no criticism of how they work; they have served people for years.
   "Blocked" and "not allowed by robots.txt" are stated as the site's choice, not as a fault.
7. **Do not guess facts.** Anything recorded in `data/shops.yaml` about a branch, pickup or delivery
   carries a source URL and a date. What could not be verified stays `unknown`.

## Conventions

- `src/core/` uses only standard web APIs (`fetch`, `URL`), so it can run on Cloudflare Workers
  later. Node-specific code (server, SQLite, files, command line) goes in `src/node/`.
- Prices come from schema.org JSON-LD. Do not add per-shop CSS selectors.
- Results must stay honest: every shop ends with an explicit status, unknown shipping is never
  counted as zero, and an uncertain match is shown as "possible".
- A matcher change needs a test in `test/matcher.test.ts` for the case that motivated it.
- Test fixtures are trimmed JSON-LD blocks made with `tools/extract_fixtures.ts`, never whole shop
  pages.
- The README table "Where to get a key" (sign-up pages, free allowance, card, sign-in options)
  carries the date it was last checked in its heading. When a provider's facts are read again or a
  provider is added, update the table and that date from the provider's own pages, never from
  memory.
- The page has two languages, English and Slovak. A new sentence a user can read goes into the
  catalogues in both languages (`src/core/i18n.ts` for what the search builds, `public/i18n.js`
  for what the page writes), never as a bare string. A note changed in `data/shops.yaml` is
  changed in `data/shops.sk.yaml` too. English strings that tests assert stay as they are.
- Dependencies are few and pinned. Add one only with a reason, and say so.
- On Windows, never put a path with backslashes inside code passed through a shell command; use
  forward slashes and the file-editing tools.

## Git

- Commit and push finished work without asking first (the owner's standing permission since
  2026-11-25): tests and type check passing, docs updated, then commit to `main` and push. This
  does not cover rewriting history or force pushing; ask before those.
- Commits in this clone use a GitHub no-reply address; leave that setting alone.
- Before committing, check that nothing from `.env`, `.cache/`, `.venv/` or `node_modules/` is
  staged.
