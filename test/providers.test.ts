// Web search adapters against mocked responses (shaped like the providers' documented responses;
// no key, no network). Live use is measured separately (see README), never in unit tests.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { FetchLike } from '../src/core/http.ts';
import { BraveProvider } from '../src/core/search/brave.ts';
import { ProviderChain, ProviderUnavailableError, SiteSearchBatcher, siteQuery, untilNextMonth } from '../src/core/search/provider.ts';
import { SerperProvider } from '../src/core/search/serper.ts';
import { TavilyProvider } from '../src/core/search/tavily.ts';
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
    const r = await p.search({ query: 'Oral-B Pro 3 3000', domains: ['drmax.sk'] }, { country: 'sk', lang: 'sk' }, f);
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
      await assert.rejects(p.search({ query: 'q', domains: [] }, { country: 'sk', lang: 'sk' }, f), (e: Error & { kind?: string }) => {
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
    const r = await p.search({ query: 'x', domains: ['drmax.sk'] }, { country: 'sk', lang: 'sk' }, f);
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
    await assert.rejects(new BraveProvider('k').search({ query: 'q', domains: [] }, { country: 'sk', lang: 'sk' }, f), (e: Error & { kind?: string }) => e.kind === 'quota');
  });
});

describe('the search as data: Brave and Serper requests and cache keys as before', () => {
  const two = { query: 'Oral-B Pro 3 3000', domains: ['drmax.sk', 'pilulka.sk'] };
  const sk = { country: 'sk', lang: 'sk' };

  test('Brave: the same URL, character for character', async () => {
    const { f, calls } = recorder([{ status: 200, body: BRAVE_OK }]);
    await new BraveProvider('k', 20).search(two, sk, f);
    assert.equal(calls[0].url, 'https://api.search.brave.com/res/v1/web/search?q=Oral-B+Pro+3+3000+site%3Adrmax.sk+OR+site%3Apilulka.sk&count=20&country=ALL&search_lang=sk&safesearch=off');
  });

  test('Serper: the same body, character for character', async () => {
    const { f, calls } = recorder([{ status: 200, body: SERPER_OK }]);
    await new SerperProvider('k', 10).search(two, sk, f);
    assert.equal(String(calls[0].init?.body), '{"q":"Oral-B Pro 3 3000 site:drmax.sk OR site:pilulka.sk","gl":"sk","hl":"sk","num":10,"autocorrect":false}');
  });

  test('results cached under the old keys are still found, without a call; another domain set is another key', async () => {
    const cache = new MemoryCache();
    const hits = [{ url: 'https://www.drmax.sk/x', title: 't', snippet: '' }];
    await cache.set('provider', 'brave|20|sk|sk|Oral-B Pro 3 3000 site:drmax.sk OR site:pilulka.sk', hits);
    await cache.set('provider', 'serper|10|sk|sk|Oral-B Pro 3 3000 site:drmax.sk', hits);
    let n = 0;
    const f: FetchLike = async () => {
      n++;
      return new Response('{}', { status: 500 });
    };
    const chain = new ProviderChain([new BraveProvider('b'), new SerperProvider('s'), new TavilyProvider('t')], cache, { fetch: f, sleep: async () => {} });
    assert.deepEqual(await chain.cached(two, sk), { hits, provider: 'brave' });
    assert.deepEqual(await chain.cached({ query: 'Oral-B Pro 3 3000', domains: ['drmax.sk'] }, sk), { hits, provider: 'serper' });
    assert.equal(await chain.cached({ query: 'Oral-B Pro 3 3000', domains: ['pilulka.sk'] }, sk), undefined);
    assert.equal(n, 0);
  });
});

const TAVILY_OK = {
  query: 'Oral-B Pro 3 3000',
  answer: null,
  images: [],
  results: [
    { title: 'Oral-B Pro 3 3000 elektrická zubná kefka | Dr.Max', url: 'https://www.drmax.sk/oral-b-pro-3-3000', content: 'Elektrická zubná kefka ...', score: 0.81, raw_content: null },
    { title: 'Oral-B Pro 3 3000 Cross Action Black', url: 'https://www.pilulka.sk/oral-b-pro-3-3000-cross-action-black', content: '...', score: 0.77, raw_content: null },
  ],
  response_time: 1.2,
  usage: { credits: 1 },
  request_id: 'r1',
};

describe('Tavily adapter (mocked)', () => {
  const two = { query: 'Oral-B Pro 3 3000', domains: ['drmax.sk', 'pilulka.sk'] };

  test('POST with a Bearer key; the plain query and the domains as a list; cheapest depth, nothing generated', async () => {
    const { f, calls } = recorder([{ status: 200, body: TAVILY_OK }]);
    await new TavilyProvider('test-key').search(two, { country: 'sk', lang: 'sk' }, f);
    assert.equal(calls[0].url, 'https://api.tavily.com/search');
    assert.equal(calls[0].init?.method, 'POST');
    assert.match(new Headers(calls[0].init?.headers).get('authorization') ?? '', /^Bearer \S+$/);
    const body = JSON.parse(String(calls[0].init?.body));
    assert.deepEqual(body, {
      query: 'Oral-B Pro 3 3000', search_depth: 'basic', topic: 'general', max_results: 20, include_answer: false, include_raw_content: false,
      include_images: false, include_usage: true, include_domains: ['drmax.sk', 'pilulka.sk'], country: 'slovakia',
    });
    assert.ok(!body.query.includes('site:'));
  });

  test('country from the locale; left out for a country outside the list this app maps', () => {
    const p = new TavilyProvider('k');
    const country = (c: string) => p.body(two, { country: c, lang: 'x' }).country;
    assert.deepEqual(['sk', 'cz', 'de', 'at', 'pl'].map(country), ['slovakia', 'czech republic', 'germany', 'austria', 'poland']);
    assert.equal(country('hu'), undefined);
    assert.ok(!('country' in p.body(two, { country: 'hu', lang: 'hu' })));
    assert.equal(new TavilyProvider('k', 50).resultsPerQuery, 20, 'at most 20 results');
  });

  test('results map to url, title and snippet; credits from the answer', async () => {
    const { f } = recorder([{ status: 200, body: TAVILY_OK }]);
    const r = await new TavilyProvider('k').search(two, { country: 'sk', lang: 'sk' }, f);
    assert.deepEqual(r.hits[0], { url: 'https://www.drmax.sk/oral-b-pro-3-3000', title: 'Oral-B Pro 3 3000 elektrická zubná kefka | Dr.Max', snippet: 'Elektrická zubná kefka ...' });
    assert.equal(r.hits.length, 2);
    assert.equal(r.credits, 1);
  });

  test('401 = key rejected, 432/433 = credits used up (until the next month), 429 and 500 = a failure of this query; no key in messages', async () => {
    const p = new TavilyProvider('secret-key-value');
    for (const [status, kind] of [[401, 'auth'], [432, 'quota'], [433, 'quota'], [429, null], [500, null]] as const) {
      const { f } = recorder([{ status, body: { detail: { error: 'x' } } }]);
      await assert.rejects(p.search(two, { country: 'sk', lang: 'sk' }, f), (e: Error) => {
        assert.equal(e instanceof ProviderUnavailableError ? e.kind : null, kind, String(status));
        assert.ok(!e.message.includes('secret-key-value'));
        return true;
      });
    }
    const ttl = p.exhaustedTtlSeconds('quota');
    assert.ok(ttl > 0 && ttl <= 31 * 86400 && Math.abs(ttl - untilNextMonth()) <= 2, 'the mark lasts until the first of next month');
  });
});

describe('provider chain', () => {
  const sk = { country: 'sk', lang: 'sk' };
  const s = (query: string) => ({ query, domains: [] });
  test('falls back to the next provider when the first is out of credit, and remembers it', async () => {
    const cache = new MemoryCache();
    const urls: string[] = [];
    const f: FetchLike = async (url) => {
      urls.push(url);
      if (url.includes('brave')) return new Response('{}', { status: 402 });
      return new Response(JSON.stringify(SERPER_OK), { status: 200 });
    };
    const chain = new ProviderChain([new BraveProvider('b'), new SerperProvider('s')], cache, { fetch: f, sleep: async () => {} });
    const r = await chain.search(s('q1'), sk);
    assert.equal(r.provider, 'serper');
    assert.equal(r.hits.length, 3);
    const r2 = await chain.search(s('q2'), sk);
    assert.equal(r2.provider, 'serper');
    assert.equal(urls.filter((u) => u.includes('brave')).length, 1, 'exhausted provider is not called again');
    assert.ok(await cache.get('provider_exhausted', 'brave'));
  });
  test('Tavily out of credit -> the next provider; Brave out of credit -> Tavily; a rate limit marks nothing', async () => {
    const tavilyFirst = new MemoryCache();
    const f1: FetchLike = async (url) => (url.includes('tavily')
      ? new Response('{"detail":{"error":"plan limit"}}', { status: 432 })
      : new Response(JSON.stringify(SERPER_OK), { status: 200 }));
    const c1 = new ProviderChain([new TavilyProvider('t'), new SerperProvider('s')], tavilyFirst, { fetch: f1, sleep: async () => {} });
    assert.equal((await c1.search({ query: 'q', domains: ['drmax.sk'] }, sk)).provider, 'serper');
    assert.equal((await tavilyFirst.get<{ kind: string }>('provider_exhausted', 'tavily'))?.kind, 'quota');

    const urls: string[] = [];
    const f2: FetchLike = async (url) => {
      urls.push(url);
      return url.includes('brave') ? new Response('{}', { status: 402 }) : new Response(JSON.stringify(TAVILY_OK), { status: 200 });
    };
    const c2 = new ProviderChain([new BraveProvider('b'), new TavilyProvider('t')], new MemoryCache(), { fetch: f2, sleep: async () => {} });
    const r = await c2.search({ query: 'Oral-B Pro 3 3000', domains: ['drmax.sk', 'pilulka.sk'] }, sk);
    assert.equal(r.provider, 'tavily');
    assert.equal(r.hits.length, 2);
    assert.deepEqual(c2.calls.map((c) => [c.provider, c.ok, c.query]), [
      ['brave', false, 'Oral-B Pro 3 3000 site:drmax.sk OR site:pilulka.sk'],
      ['tavily', true, 'Oral-B Pro 3 3000 site:drmax.sk OR site:pilulka.sk'],
    ], 'the call log names the domains for every provider');

    const limited = new MemoryCache();
    const f3: FetchLike = async (url) => (url.includes('tavily') ? new Response('{}', { status: 429, headers: { 'retry-after': '60' } }) : new Response(JSON.stringify(SERPER_OK), { status: 200 }));
    const c3 = new ProviderChain([new TavilyProvider('t'), new SerperProvider('s')], limited, { fetch: f3, sleep: async () => {} });
    assert.equal((await c3.search(s('q'), sk)).provider, 'serper');
    assert.equal(await limited.get('provider_exhausted', 'tavily'), undefined, 'a rate limit is not exhaustion');
  });

  test('all providers unusable -> unavailable with the reasons', async () => {
    const f: FetchLike = async () => new Response('{"message":"Not enough credits"}', { status: 400 });
    const chain = new ProviderChain([new SerperProvider('s')], new MemoryCache(), { fetch: f, sleep: async () => {} });
    const r = await chain.search(s('q'), sk);
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
    await chain.search(s('q'), sk);
    await chain.search(s('q'), sk);
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
    assert.ok(bodies.some((x) => JSON.parse(x).q === siteQuery('Oral-B Pro 3 3000', ['datart.cz'])), 'without queryFor every country gets the query');
    assert.equal(r2.hits.length, 1);
    assert.equal(r3.hits.length, 0);
  });

  test('each country gets its own text (the pipeline sends shops abroad the core query); still one query per country', async () => {
    const bodies: { q: string; gl: string }[] = [];
    const f: FetchLike = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify(SERPER_OK), { status: 200 });
    };
    const chain = new ProviderChain([new SerperProvider('s')], new MemoryCache(), { fetch: f, sleep: async () => {} });
    const typed = 'Oral-B iO Series 9 čierna zubná kefka';
    const b = new SiteSearchBatcher({
      chain, query: typed, queryFor: (c) => (c === 'SK' ? typed : 'Oral-B iO Series 9'), expected: 3, mode: 'combined', domainsPerQuery: 6, deadlineMs: 5000,
    });
    await Promise.all([b.find('drmax.sk', 'SK'), b.find('pilulka.sk', 'SK'), b.find('datart.cz', 'CZ')]);
    assert.equal(bodies.length, 2);
    assert.deepEqual(bodies.map((x) => [x.gl, x.q]).sort(), [
      ['cz', 'Oral-B iO Series 9 site:datart.cz'],
      ['sk', `${typed} site:drmax.sk OR site:pilulka.sk`],
    ]);
  });
});
