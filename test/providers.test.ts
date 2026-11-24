// Web search adapters against mocked responses (shaped like the providers' documented responses;
// no key, no network). Live use is measured separately (see README), never in unit tests.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { FetchLike } from '../src/core/http.ts';
import { BraveProvider } from '../src/core/search/brave.ts';
import { ProviderChain, SiteSearchBatcher, siteQuery } from '../src/core/search/provider.ts';
import { SerperProvider } from '../src/core/search/serper.ts';
import { MemoryCache } from './helpers.ts';

const SERPER_OK = {
  searchParameters: { q: 'Oral-B Pro 3 3000 site:drmax.sk OR site:pilulka.sk', gl: 'sk', hl: 'sk', type: 'search', engine: 'google' },
  organic: [
    { title: 'Oral-B Pro 3 3000 elektrická zubná kefka | Dr.Max', link: 'https://www.drmax.sk/oral-b-pro-3-3000', snippet: '...', position: 1 },
    { title: 'Oral-B Pro 3 3000 Cross Action Black - Pilulka.sk', link: 'https://www.pilulka.sk/oral-b-pro-3-3000-cross-action-black', snippet: '...', position: 2 },
    { title: 'Unrelated', link: 'https://www.example.com/x', snippet: '', position: 3 },
  ],
  credits: 1,
};

const BRAVE_OK = {
  type: 'search',
  query: { original: 'q', more_results_available: false },
  web: { type: 'search', results: [{ title: 'Oral-B <strong>Pro 3</strong> 3000', url: 'https://www.drmax.sk/oral-b-pro-3-3000', description: 'desc' }] },
};

function recorder(responses: { status: number; body: unknown }[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  let i = 0;
  const f: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const r = responses[Math.min(i++, responses.length - 1)];
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
  };
  return { f, calls };
}

describe('Serper adapter (mocked)', () => {
  test('POST with key header, gl/hl from the locale, organic results parsed', async () => {
    const { f, calls } = recorder([{ status: 200, body: SERPER_OK }]);
    const p = new SerperProvider('test-key', 10);
    const r = await p.search('Oral-B Pro 3 3000 site:drmax.sk', { country: 'sk', lang: 'sk' }, f);
    assert.equal(r.hits.length, 3);
    assert.equal(r.credits, 1);
    assert.equal(calls[0].url, 'https://google.serper.dev/search');
    assert.equal(calls[0].init?.method, 'POST');
    assert.equal(new Headers(calls[0].init?.headers).get('x-api-key'), 'test-key');
    assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { q: 'Oral-B Pro 3 3000 site:drmax.sk', gl: 'sk', hl: 'sk', num: 10, autocorrect: false });
  });
  test('out of credits and rejected keys are "unavailable", not "no results"; the message has no key', async () => {
    const p = new SerperProvider('secret-key-value');
    for (const [status, body, kind] of [[400, { message: 'Not enough credits', statusCode: 400 }, 'quota'], [402, {}, 'quota'], [403, { message: 'Unauthorized.' }, 'auth']] as const) {
      const { f } = recorder([{ status, body }]);
      await assert.rejects(p.search('q', { country: 'sk', lang: 'sk' }, f), (e: Error & { kind?: string }) => {
        assert.equal(e.kind, kind);
        assert.ok(!e.message.includes('secret-key-value'));
        return true;
      });
    }
  });
});

describe('Brave adapter (mocked)', () => {
  test('GET with token header; SK falls back to country=ALL with search_lang=sk; AT keeps AT', async () => {
    const { f, calls } = recorder([{ status: 200, body: BRAVE_OK }]);
    const p = new BraveProvider('k', 20);
    const r = await p.search('x site:drmax.sk', { country: 'sk', lang: 'sk' }, f);
    assert.equal(r.hits[0].title, 'Oral-B Pro 3 3000');
    const u = new URL(calls[0].url);
    assert.equal(u.origin + u.pathname, 'https://api.search.brave.com/res/v1/web/search');
    assert.equal(u.searchParams.get('country'), 'ALL');
    assert.equal(u.searchParams.get('search_lang'), 'sk');
    assert.equal(u.searchParams.get('count'), '20');
    assert.equal(new Headers(calls[0].init?.headers).get('x-subscription-token'), 'k');
    assert.equal(new URL(p.buildUrl('x', { country: 'at', lang: 'de' })).searchParams.get('country'), 'AT');
  });
  test('402 = monthly credit used up', async () => {
    const { f } = recorder([{ status: 402, body: { type: 'ErrorResponse', error: { code: 'QUOTA_LIMITED' } } }]);
    await assert.rejects(new BraveProvider('k').search('q', { country: 'sk', lang: 'sk' }, f), (e: Error & { kind?: string }) => e.kind === 'quota');
  });
});

describe('provider chain', () => {
  const sk = { country: 'sk', lang: 'sk' };
  test('falls back to the next provider when the first is out of credit, and remembers it', async () => {
    const cache = new MemoryCache();
    const urls: string[] = [];
    const f: FetchLike = async (url) => {
      urls.push(url);
      if (url.includes('brave')) return new Response('{}', { status: 402 });
      return new Response(JSON.stringify(SERPER_OK), { status: 200 });
    };
    const chain = new ProviderChain([new BraveProvider('b'), new SerperProvider('s')], cache, { fetch: f, sleep: async () => {} });
    const r = await chain.search('q1', sk);
    assert.equal(r.provider, 'serper');
    assert.equal(r.hits.length, 3);
    const r2 = await chain.search('q2', sk);
    assert.equal(r2.provider, 'serper');
    assert.equal(urls.filter((u) => u.includes('brave')).length, 1, 'exhausted provider is not called again');
    assert.ok(await cache.get('provider_exhausted', 'brave'));
  });
  test('all providers unusable -> unavailable with the reasons', async () => {
    const f: FetchLike = async () => new Response('{"message":"Not enough credits"}', { status: 400 });
    const chain = new ProviderChain([new SerperProvider('s')], new MemoryCache(), { fetch: f, sleep: async () => {} });
    const r = await chain.search('q', sk);
    assert.match(r.unavailable ?? '', /credits used up/);
    assert.deepEqual(r.hits, []);
  });
  test('cached results are used without a call', async () => {
    const cache = new MemoryCache();
    let n = 0;
    const f: FetchLike = async () => {
      n++;
      return new Response(JSON.stringify(SERPER_OK), { status: 200 });
    };
    const chain = new ProviderChain([new SerperProvider('s')], cache, { fetch: f, sleep: async () => {} });
    await chain.search('q', sk);
    await chain.search('q', sk);
    assert.equal(n, 1);
  });
});

describe('site-search batching', () => {
  test('one combined query per country for all shops that asked; hits split by domain', async () => {
    const bodies: string[] = [];
    const f: FetchLike = async (_url, init) => {
      bodies.push(String(init?.body));
      return new Response(JSON.stringify(SERPER_OK), { status: 200 });
    };
    const chain = new ProviderChain([new SerperProvider('s')], new MemoryCache(), { fetch: f, sleep: async () => {} });
    const b = new SiteSearchBatcher({ chain, query: 'Oral-B Pro 3 3000', expected: 4, mode: 'combined', domainsPerQuery: 6, deadlineMs: 5000 });
    const p1 = b.find('drmax.sk', 'SK');
    const p2 = b.find('pilulka.sk', 'SK');
    const p3 = b.find('datart.cz', 'CZ');
    b.decline();
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    assert.equal(bodies.length, 2, 'SK and CZ');
    assert.ok(bodies.some((x) => JSON.parse(x).q === siteQuery('Oral-B Pro 3 3000', ['drmax.sk', 'pilulka.sk']) && JSON.parse(x).gl === 'sk'));
    assert.ok(bodies.some((x) => JSON.parse(x).gl === 'cz' && JSON.parse(x).hl === 'cs'));
    assert.deepEqual(r1.hits.map((h) => h.url), ['https://www.drmax.sk/oral-b-pro-3-3000']);
    assert.equal(r2.hits.length, 1);
    assert.equal(r3.hits.length, 0);
  });
});
