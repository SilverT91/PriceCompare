// HTTP API (Hono). Portable: it only uses web-standard APIs and gets storage, shops and providers
// injected, so it can run on Node (src/node/server.ts) or, later, on Cloudflare Workers.
//
//   GET /api/search?q=...&location=kosice&cat=auto[&as_typed=1]   Server-Sent Events: start (with the
//        searched and the typed query), rates, shop (one per shop as it finishes), products (regrouped
//        after each shop), done
//   GET /api/shops   GET /api/locations   GET /api/categories   GET /api/history

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { HostScheduler } from './core/http.ts';
import { runSearch, type SearchSummary } from './core/pipeline.ts';
import type { ProviderCall, SearchProvider } from './core/search/provider.ts';
import { CATEGORY_GROUPS } from './core/categories.ts';
import { LOCATIONS, locationById, sectionFor } from './core/shops.ts';
import type { Cache, Shop } from './core/types.ts';

export interface AppDeps {
  shops: () => Shop[];
  cache: Cache;
  scheduler: HostScheduler;
  providers: () => SearchProvider[];
  onSearchDone?: (s: SearchSummary & { location: string; startedAt: string }) => void;
  onProviderCall?: (c: ProviderCall) => void;
  history?: () => unknown;
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

  app.get('/api/search', (c) => {
    const q = (c.req.query('q') ?? '').trim().slice(0, 200);
    if (!q) return c.json({ error: 'missing q' }, 400);
    const location = locationById(c.req.query('location'));
    const category = (c.req.query('cat') ?? 'auto').slice(0, 20);
    // as_typed=1: no brand correction for this search (the page's "search exactly as typed" link).
    const asTyped = c.req.query('as_typed') === '1';
    const startedAt = new Date().toISOString();
    return streamSSE(c, async (stream) => {
      let aborted = false;
      stream.onAbort(() => {
        aborted = true;
      });
      let id = 0;
      for await (const ev of runSearch(q, {
        shops: deps.shops(), cache: deps.cache, scheduler: deps.scheduler, location, providers: deps.providers(), category, asTyped,
        onProviderCall: deps.onProviderCall,
      })) {
        if (aborted) break;
        await stream.writeSSE({ event: ev.type, data: JSON.stringify(ev), id: String(id++) });
        if (ev.type === 'done') deps.onSearchDone?.({ ...ev.summary, location: location.id, startedAt });
      }
    });
  });

  return app;
}
