// Local web server: the portable Hono app plus static files from public/ and SQLite storage.
//   npm start            -> http://localhost:8787  (PORT to change; binds to 127.0.0.1 only)

import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createApp } from '../app.ts';
import { loadEnv, loadShops, loadShopTexts, makeScheduler, makeUsage, openStore, providersFromEnv, ROOT } from './setup.ts';

loadEnv();
const store = openStore();
store.purgeExpired();
const shops = loadShops();
const shopTexts = loadShopTexts(shops);
const scheduler = makeScheduler(store);

const app = createApp({
  shops: () => shops,
  shopTexts: () => shopTexts,
  cache: store,
  scheduler,
  providers: () => providersFromEnv(),
  onProviderCall: (c) => store.recordProviderCall(c),
  onSearchDone: (s) => store.recordSearch({ query: s.query, location: s.location, startedAt: s.startedAt, ms: s.ms, statusCounts: s.statusCounts, offers: s.offers, groups: s.groups }),
  history: () => store.history(),
  usage: makeUsage(store),
});
app.use('/*', serveStatic({ root: `${ROOT}public`.replace(/\\/g, '/') }));

const port = Number(process.env.PORT) || 8787;
serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, (info) => {
  const names = providersFromEnv().map((p) => p.id);
  console.log(`PriceCompare on http://localhost:${info.port}  (web search: ${names.length ? names.join(' > ') : 'none'})`);
});
