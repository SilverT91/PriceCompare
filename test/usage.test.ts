// Web search credit bars: the app's own count (month boundary in UTC, Serper over all time, failed
// calls), the limits from the environment, Brave's rate-limit headers, the thresholds, and
// GET /api/usage with and without keys. No request leaves the process.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../src/app.ts';
import { HostScheduler, type FetchLike } from '../src/core/http.ts';
import { BraveProvider } from '../src/core/search/brave.ts';
import { ProviderChain } from '../src/core/search/provider.ts';
import { DEFAULT_LIMITS, limitsFromEnv, monthStartUtc, parseBraveRateLimit, providerUsage, usageLevel } from '../src/core/usage.ts';
import { Store } from '../src/node/db.ts';
import { makeUsage } from '../src/node/setup.ts';
import { MemoryCache } from './helpers.ts';

function storeWith(rows: [string, string, number, boolean][]): Store {
  const store = new Store(':memory:');
  const ins = store.db.prepare('INSERT INTO provider_calls (at, provider, query, country, lang, results, credits, ok, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  for (const [at, provider, credits, ok] of rows) ins.run(at, provider, 'q site:a.test', 'sk', 'sk', 3, credits, ok ? 1 : 0, ok ? null : 'Brave HTTP 429');
  return store;
}

const ROWS: [string, string, number, boolean][] = [
  ['2026-10-31T23:59:59.999Z', 'brave', 1, true], // last month (UTC): not counted for Brave
  ['2026-11-01T00:00:00.000Z', 'brave', 1, true],
  ['2026-11-20T10:00:00.000Z', 'brave', 1, true],
  ['2026-11-20T10:00:01.000Z', 'brave', 0, false], // failed: costs nothing, not counted
  ['2026-09-02T08:00:00.000Z', 'serper', 2, true], // Serper: all time
  ['2026-11-21T08:00:00.000Z', 'serper', 1, true],
  ['2026-11-21T08:00:02.000Z', 'serper', 0, false],
  ['2026-10-15T08:00:00.000Z', 'tavily', 1, true],
  ['2026-11-22T08:00:00.000Z', 'tavily', 1, true],
];

test('the month starts on the first day in UTC', () => {
  assert.equal(monthStartUtc(new Date('2026-11-25T12:00:00Z')), '2026-11-01T00:00:00.000Z');
  // 00:30 on 1 December in Central Europe is still November in UTC
  assert.equal(monthStartUtc(new Date('2026-12-01T00:30:00+01:00')), '2026-11-01T00:00:00.000Z');
  assert.equal(monthStartUtc(new Date('2027-01-01T00:00:00Z')), '2027-01-01T00:00:00.000Z');
});

test('the app counts the credits of successful calls: Brave and Tavily this month, Serper all time', async () => {
  const store = storeWith(ROWS);
  assert.equal(store.creditsUsed('brave', '2026-11-01T00:00:00.000Z'), 2);
  assert.equal(store.creditsUsed('brave', null), 3);
  assert.equal(store.creditsUsed('serper', null), 3);
  assert.equal(store.creditsUsed('nobody', null), 0);
  const usage = await providerUsage({
    ids: ['brave', 'serper', 'tavily'], limits: DEFAULT_LIMITS, cache: new MemoryCache(), appCredits: (id, since) => store.creditsUsed(id, since),
    now: new Date('2026-11-25T12:00:00Z'),
  });
  assert.deepEqual(usage, [
    { provider: 'brave', used: 2, limit: 1000, period: 'month', source: 'app', exhausted: false },
    { provider: 'serper', used: 3, limit: 2500, period: 'total', source: 'app', exhausted: false },
    { provider: 'tavily', used: 1, limit: 1000, period: 'month', source: 'app', exhausted: false },
  ]);
  store.close();
});

test('limits come from the environment; anything not a positive whole number keeps the default', () => {
  assert.deepEqual(limitsFromEnv({}), { brave: 1000, serper: 2500, tavily: 1000 });
  assert.deepEqual(limitsFromEnv({ BRAVE_MONTHLY_LIMIT: '2000', SERPER_TOTAL_LIMIT: ' 1_000 ', TAVILY_MONTHLY_LIMIT: '4,000' }), { brave: 2000, serper: 1000, tavily: 4000 });
  assert.deepEqual(limitsFromEnv({ BRAVE_MONTHLY_LIMIT: 'abc', SERPER_TOTAL_LIMIT: '0', TAVILY_MONTHLY_LIMIT: '-5' }), DEFAULT_LIMITS);
  assert.deepEqual(limitsFromEnv({ BRAVE_MONTHLY_LIMIT: '12.5' }).brave, 1000);
});

test('the bar turns yellow from 80 % and red at 100 % or when the provider is marked used up', () => {
  assert.equal(usageLevel(0, 1000), 'ok');
  assert.equal(usageLevel(799, 1000), 'ok');
  assert.equal(usageLevel(800, 1000), 'warn');
  assert.equal(usageLevel(999, 1000), 'warn');
  assert.equal(usageLevel(1000, 1000), 'full');
  assert.equal(usageLevel(1200, 1000), 'full');
  assert.equal(usageLevel(3, 1000, true), 'full');
  assert.equal(usageLevel(2000, 2500), 'warn');
});

test("Brave's rate-limit headers: the monthly window by its policy, nothing when unlimited or missing", () => {
  const h = (o: Record<string, string>) => new Headers(o);
  // the example of Brave's rate limiting guide
  assert.deepEqual(parseBraveRateLimit(h({
    'X-RateLimit-Limit': '1, 15000', 'X-RateLimit-Policy': '1;w=1, 15000;w=2592000', 'X-RateLimit-Remaining': '1, 1000', 'X-RateLimit-Reset': '1, 1419704',
  })), { limit: 15000, remaining: 1000, resetSeconds: 1419704 });
  // without a policy header: the last entry
  assert.deepEqual(parseBraveRateLimit(h({ 'X-RateLimit-Limit': '1, 2000', 'X-RateLimit-Remaining': '0, 1973', 'X-RateLimit-Reset': '1, 86400' })),
    { limit: 2000, remaining: 1973, resetSeconds: 86400 });
  // the monthly entry first in the list
  assert.deepEqual(parseBraveRateLimit(h({
    'X-RateLimit-Limit': '2000, 1', 'X-RateLimit-Policy': '2000;w=2592000, 1;w=1', 'X-RateLimit-Remaining': '1500, 1', 'X-RateLimit-Reset': '99, 1',
  })), { limit: 2000, remaining: 1500, resetSeconds: 99 });
  assert.equal(parseBraveRateLimit(h({ 'X-RateLimit-Limit': '1, 0', 'X-RateLimit-Remaining': '1, 0', 'X-RateLimit-Reset': '1, 0' })), null, '0 = unlimited');
  assert.equal(parseBraveRateLimit(h({})), null);
  assert.equal(parseBraveRateLimit(h({ 'X-RateLimit-Limit': '1, 2000', 'X-RateLimit-Remaining': '1', 'X-RateLimit-Reset': '1, 5' })), null);
  assert.equal(parseBraveRateLimit(h({ 'X-RateLimit-Limit': 'a, b', 'X-RateLimit-Remaining': '1, 2', 'X-RateLimit-Reset': '1, 5' })), null);
});

test("Brave's reported figures are kept from a search answer (no extra request) and preferred over the app's count", async () => {
  const calls: string[] = [];
  const f: FetchLike = async (url) => {
    calls.push(url);
    return new Response(JSON.stringify({ web: { results: [{ url: 'https://a.test/p', title: 'P' }] } }), {
      headers: {
        'Content-Type': 'application/json', 'X-RateLimit-Limit': '1, 2000', 'X-RateLimit-Policy': '1;w=1, 2000;w=2592000',
        'X-RateLimit-Remaining': '0, 1940', 'X-RateLimit-Reset': '1, 600000',
      },
    });
  };
  const cache = new MemoryCache();
  const chain = new ProviderChain([new BraveProvider('test-key')], cache, { fetch: f, sleep: async () => {} });
  const r = await chain.search({ query: 'thing', domains: ['a.test'] }, { country: 'sk', lang: 'sk' });
  assert.equal(r.hits.length, 1);
  assert.equal(calls.length, 1, 'only the search itself');
  const usage = await providerUsage({ ids: ['brave'], limits: DEFAULT_LIMITS, cache, appCredits: () => 7 });
  assert.deepEqual(usage, [{ provider: 'brave', used: 60, limit: 2000, period: 'month', source: 'provider', exhausted: false }]);
  // an exhausted mark shows on the bar
  await cache.set('provider_exhausted', 'brave', { kind: 'quota', status: 402, message: 'x', at: '2026-11-25T00:00:00Z' });
  assert.equal((await providerUsage({ ids: ['brave'], limits: DEFAULT_LIMITS, cache, appCredits: () => 7 }))[0].exhausted, true);
});

test('GET /api/usage: one entry per provider with a key, the agreed fields only, never key material', async () => {
  const store = storeWith(ROWS);
  const scheduler = new HostScheduler({ intervalMs: 0 });
  const secret = 'brv-secret-0123456789';
  const env = { BRAVE_API_KEY: secret, TAVILY_API_KEY: 'tvly-secret-987', SERPER_API_KEY: '  ', TAVILY_MONTHLY_LIMIT: '500' };
  const app = createApp({ shops: () => [], cache: store, scheduler, providers: () => [], usage: makeUsage(store, env) });
  const res = await app.request('/api/usage');
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.doesNotMatch(text, /secret|brv-|tvly-/);
  const list = JSON.parse(text) as Record<string, unknown>[];
  assert.deepEqual(list.map((u) => u.provider), ['brave', 'tavily'], 'Serper has no key: not listed');
  for (const u of list) assert.deepEqual(Object.keys(u).sort(), ['exhausted', 'limit', 'period', 'provider', 'source', 'used']);
  assert.equal(list[1].limit, 500);
  // without any key: an empty list
  const none = createApp({ shops: () => [], cache: store, scheduler, providers: () => [], usage: makeUsage(store, {}) });
  assert.deepEqual(await (await none.request('/api/usage')).json(), []);
  const noDep = createApp({ shops: () => [], cache: store, scheduler, providers: () => [] });
  assert.deepEqual(await (await noDep.request('/api/usage')).json(), []);
  store.close();
});
