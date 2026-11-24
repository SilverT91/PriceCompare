// The HTTP API streams one SSE "shop" event per shop as soon as that shop is done (mocked shops,
// one fast and one slow), not after the slowest one.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../src/app.ts';
import { HostScheduler } from '../src/core/http.ts';
import { validateShops } from '../src/core/shops.ts';
import { MemoryCache } from './helpers.ts';

test('GET /api/search streams shop results progressively', async () => {
  const { shops } = validateShops({
    shops: [
      { id: 'fast', name: 'Fast', domain: 'fast.test', search_url_template: 'https://fast.test/s?q={query}' },
      { id: 'slow', name: 'Slow', domain: 'slow.test', search_url_template: 'https://slow.test/s?q={query}' },
    ],
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('https://slow.test')) await new Promise((r) => setTimeout(r, 600));
    if (url.endsWith('/robots.txt')) return new Response('User-agent: *\nDisallow:');
    if (url.includes('frankfurter')) return new Response('[]');
    return new Response('<html><body>nothing</body></html>');
  }) as typeof fetch;
  try {
    const app = createApp({ shops: () => shops, cache: new MemoryCache(), scheduler: new HostScheduler({ intervalMs: 0 }), providers: () => [] });
    const res = await app.request('/api/search?q=Thing%201');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const dec = new TextDecoder();
    const t0 = Date.now();
    const arrivals: { event: string; shop?: string; t: number }[] = [];
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const event = /^event: (.*)$/m.exec(block)?.[1] ?? '';
        const data = /^data: (.*)$/m.exec(block)?.[1] ?? '{}';
        arrivals.push({ event, shop: event === 'shop' ? JSON.parse(data).result.shopId : undefined, t: Date.now() - t0 });
      }
    }
    const fast = arrivals.find((a) => a.shop === 'fast');
    const slow = arrivals.find((a) => a.shop === 'slow');
    assert.ok(fast && slow);
    assert.ok(fast.t + 300 < slow.t, `fast shop must arrive well before the slow one (${fast.t} ms vs ${slow.t} ms)`);
    assert.equal(arrivals[0].event, 'start');
    assert.equal(arrivals.at(-1)?.event, 'done');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('GET /api/search without q is a 400', async () => {
  const app = createApp({ shops: () => [], cache: new MemoryCache(), scheduler: new HostScheduler({ intervalMs: 0 }), providers: () => [] });
  assert.equal((await app.request('/api/search')).status, 400);
});
