// HTTP API (Hono). Portable: it only uses web-standard APIs and gets storage, shops and providers
// injected, so it can run on Node (src/node/server.ts) or, later, on Cloudflare Workers.
//
//   GET /api/search?q=...&location=kosice&cat=auto[&as_typed=1][&lang=sk][&mode=local][&refresh_web=1]
//        Server-Sent Events: start (with the searched and the typed query), rates, shop (one per shop as
//        it finishes), products (regrouped after each shop), done. lang=sk: the sentences in the events in
//        Slovak (default English). mode=local: only the local database, no request at all. refresh_web=1:
//        ask the web search again even where the local database has its answer.
//   GET /api/shops   GET /api/locations   GET /api/categories   GET /api/history
//   GET /api/usage   web search credit used per provider with a key (for the bars on the page)

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { HostScheduler } from './core/http.ts';
import { runSearch, type SearchSummary } from './core/pipeline.ts';
import type { ProviderCall, SearchProvider } from './core/search/provider.ts';
import { CATEGORY_GROUPS } from './core/categories.ts';
import { parseLang, type ShopTexts } from './core/i18n.ts';
import { LOCATIONS, locationById, sectionFor } from './core/shops.ts';
import type { Cache, History, Shop } from './core/types.ts';
import type { ProviderUsage } from './core/usage.ts';

export interface AppDeps {
  shops: () => Shop[];
  cache: Cache;
  scheduler: HostScheduler;
  providers: () => SearchProvider[];
  onSearchDone?: (s: SearchSummary & { location: string; startedAt: string }) => void;
  onProviderCall?: (c: ProviderCall) => void;
  history?: () => unknown;
  /** Translated shop notes (data/shops.<lang>.yaml); without them the English notes are shown. */
  shopTexts?: () => ShopTexts;
  /** Credit usage of the providers that have a key (core/usage.ts, providerUsage); never key material. */
  usage?: () => Promise<ProviderUsage[]>;
  /** The local database of what searches found (src/node/db.ts); without it nothing is kept. */
  stored?: History;
}

export function createApp(deps: AppDeps) {
  const app = new Hono();

  app.get('/api/locations', (c) => c.json(LOCATIONS.map((l) => ({ id: l.id, name: l.name }))));

  app.get('/api/categories', (c) => c.json([
    { id: 'auto', label: 'Auto (from the query)' },
    ...CATEGORY_GROUPS.map((g) => ({ id: g.id, label: g.label })),
    { id: 'all', label: 'All shops' },
  ]));

  app.get('/api/shops', (c) => {
    const loc = locationById(c.req.query('location'));
    return c.json(deps.shops().filter((s) => s.in_scope).map((s) => ({
      id: s.id, name: s.name, domain: s.domain, country: s.country, section: sectionFor(s, loc),
      branch: s[loc.branchField], shipsToSk: s.ships_to_sk, hasSearchTemplate: Boolean(s.search_url_template),
    })));
  });

  app.get('/api/history', (c) => c.json(deps.history?.() ?? []));

  // One entry per provider with a key: { provider, used, limit, period, source, exhausted }; [] without keys.
  app.get('/api/usage', async (c) => {
    const list = (await deps.usage?.()) ?? [];
    return c.json(list.map((u) => ({ provider: u.provider, used: u.used, limit: u.limit, period: u.period, source: u.source, exhausted: u.exhausted })));
  });

  app.get('/api/search', (c) => {
    // Room for a pasted product link (only the name in its path is used; the link is never fetched).
    const q = (c.req.query('q') ?? '').trim().slice(0, 600);
    if (!q) return c.json({ error: 'missing q' }, 400);
    const location = locationById(c.req.query('location'));
    const category = (c.req.query('cat') ?? 'auto').slice(0, 20);
    // as_typed=1: no brand correction for this search (the page's "search exactly as typed" link).
    const asTyped = c.req.query('as_typed') === '1';
    const lang = parseLang(c.req.query('lang'));
    const mode = c.req.query('mode') === 'local' ? 'local' : 'online';
    const refreshWeb = c.req.query('refresh_web') === '1';
    const startedAt = new Date().toISOString();
    return streamSSE(c, async (stream) => {
      let aborted = false;
      stream.onAbort(() => {
        aborted = true;
      });
      let id = 0;
      for await (const ev of runSearch(q, {
        shops: deps.shops(), cache: deps.cache, scheduler: deps.scheduler, location, providers: deps.providers(), category, asTyped,
        lang, shopTexts: deps.shopTexts?.(), onProviderCall: deps.onProviderCall, history: deps.stored, mode, refreshWeb,
      })) {
        if (aborted) break;
        await stream.writeSSE({ event: ev.type, data: JSON.stringify(ev), id: String(id++) });
        if (ev.type === 'done') deps.onSearchDone?.({ ...ev.summary, location: location.id, startedAt });
      }
    });
  });

  return app;
}
