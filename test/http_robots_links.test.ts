import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { detectBotWall } from '../src/core/botwall.ts';
import { HostScheduler, ShopSession, USER_AGENT, type FetchLike } from '../src/core/http.ts';
import { extractLinkCandidates, stripTrackingParams } from '../src/core/links.ts';
import { parseRobots, robotsAllows, robotsFromResponse } from '../src/core/robots.ts';
import { MemoryCache, linksHtml } from './helpers.ts';

describe('robots.txt', () => {
  const txt = `
User-agent: *
Disallow: /vyhladavanie
Disallow: /*?q=
Allow: /vyhladavanie/help$
Disallow: /cart

User-agent: price-compare
Disallow: /private
`;
  test('our own group wins over *', () => {
    const rec = { mode: 'rules' as const, rules: parseRobots(txt), status: 200 };
    assert.equal(robotsAllows(rec, 'https://s.sk/vyhladavanie?q=x'), true);
    assert.equal(robotsAllows(rec, 'https://s.sk/private/1'), false);
  });
  test('* group: longest match wins, allow wins ties, * and $ work', () => {
    const rec = { mode: 'rules' as const, rules: parseRobots(txt, 'other-bot'), status: 200 };
    assert.equal(robotsAllows(rec, 'https://s.sk/vyhladavanie?q=iphone'), false);
    assert.equal(robotsAllows(rec, 'https://s.sk/hladat?q=iphone'), false);
    assert.equal(robotsAllows(rec, 'https://s.sk/vyhladavanie/help'), true);
    assert.equal(robotsAllows(rec, 'https://s.sk/vyhladavanie/help/more'), false);
    assert.equal(robotsAllows(rec, 'https://s.sk/p/iphone-16'), true);
  });
  test('4xx = no rules, 5xx and unreachable = disallow everything', () => {
    assert.equal(robotsFromResponse(404, '').mode, 'allow_all');
    assert.equal(robotsFromResponse(503, '').mode, 'disallow_all');
    assert.equal(robotsFromResponse(null, null).mode, 'disallow_all');
  });
  test('the Planeo search path with "$" in it is matched literally', () => {
    const rec = { mode: 'rules' as const, rules: parseRobots('User-agent: *\nDisallow: /vyhladavanie$a1013-search'), status: 200 };
    // "$" in the middle of a pattern is a literal character, only a trailing "$" anchors
    assert.equal(robotsAllows(rec, 'https://www.planeo.sk/vyhladavanie$a1013-search?query=x'), false);
  });
});

describe('tracking parameters', () => {
  test('search-engine and widget click parameters are removed, real ones kept', () => {
    // Google results carry ?srsltid=..., which tetadrogerie.sk's robots.txt disallows ("/*srsltid=").
    const teta = robotsFromResponse(200, 'User-agent: *\nDisallow: /*srsltid=');
    const hit = 'https://www.tetadrogerie.sk/produkty/Elek-a-bater-zubne-kefky-a-sprchy/D160500-Oral-B-iO-Series-3/?srsltid=AfmBOoq1';
    assert.equal(robotsAllows(teta, hit), false);
    assert.equal(stripTrackingParams(hit), 'https://www.tetadrogerie.sk/produkty/Elek-a-bater-zubne-kefky-a-sprchy/D160500-Oral-B-iO-Series-3/');
    assert.equal(robotsAllows(teta, stripTrackingParams(hit)), true);
    assert.equal(stripTrackingParams('https://www.pilulka.sk/oral-b-pro-3900?gtmClickEvent=clickBestSoldCategory'), 'https://www.pilulka.sk/oral-b-pro-3900');
    assert.equal(stripTrackingParams('https://x.test/p?id=5&utm_source=a&gclid=b'), 'https://x.test/p?id=5');
    assert.equal(stripTrackingParams('https://x.test/p?page=2'), 'https://x.test/p?page=2');
    assert.equal(stripTrackingParams('https://www.datart.cz/kartacek.html?ltm_source=letak&ltm_medium=interni&ltm_campaign=x'), 'https://www.datart.cz/kartacek.html');
  });
});

describe('bot wall detection', () => {
  test('403 challenge page and cf-mitigated header', () => {
    assert.equal(detectBotWall(403, new Headers(), '<html>Just a moment...</html>').vendor, 'cloudflare');
    assert.equal(detectBotWall(200, new Headers({ 'cf-mitigated': 'challenge' }), 'x').detected, true);
    assert.equal(detectBotWall(429, new Headers(), '').detected, true);
  });
  test('a big normal page that loads a reCAPTCHA script is not a wall', () => {
    const big = '<html>' + 'x'.repeat(70_000) + '<script src="recaptcha.js"></script></html>';
    assert.equal(detectBotWall(200, new Headers(), big).detected, false);
  });
});

function mockSite(routes: Record<string, { status: number; body?: string; headers?: Record<string, string> }>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const f: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const r = routes[url];
    if (!r) return new Response('not found', { status: 404 });
    return new Response(r.body ?? '', { status: r.status, headers: r.headers });
  };
  return { f, calls };
}

describe('ShopSession politeness', () => {
  test('robots.txt is checked before every URL and a disallowed URL is never requested', async () => {
    const { f, calls } = mockSite({
      'https://s.sk/robots.txt': { status: 200, body: 'User-agent: *\nDisallow: /search' },
      'https://s.sk/p/1': { status: 200, body: '<html>ok</html>' },
    });
    const s = new ShopSession('s.sk', { scheduler: new HostScheduler({ intervalMs: 0 }), cache: new MemoryCache(), fetch: f });
    const a = await s.get('https://s.sk/search?q=x', 'search');
    assert.equal(a.robotsDisallowed, 'https://s.sk/search?q=x');
    const b = await s.get('https://s.sk/p/1', 'product');
    assert.equal(b.ok, true);
    assert.deepEqual(calls.map((c) => c.url), ['https://s.sk/robots.txt', 'https://s.sk/p/1']);
    const headers = new Headers(calls[1].init?.headers);
    assert.equal(headers.get('user-agent'), USER_AGENT);
    assert.equal(USER_AGENT, 'price-compare/0.1');
  });
  test('a redirect to a disallowed URL is not followed; off-site redirects are not followed', async () => {
    const { f, calls } = mockSite({
      'https://s.sk/robots.txt': { status: 200, body: 'User-agent: *\nDisallow: /hidden' },
      'https://s.sk/a': { status: 302, headers: { location: '/hidden/b' } },
      'https://s.sk/c': { status: 301, headers: { location: 'https://other.com/x' } },
    });
    const s = new ShopSession('s.sk', { scheduler: new HostScheduler({ intervalMs: 0 }), cache: new MemoryCache(), fetch: f });
    assert.equal((await s.get('https://s.sk/a', 'p')).robotsDisallowed, 'https://s.sk/hidden/b');
    assert.equal((await s.get('https://s.sk/c', 'p')).offsiteRedirect, 'https://other.com/x');
    assert.ok(!calls.some((c) => c.url.includes('hidden') || c.url.includes('other.com')));
  });
  test('403 challenge: reported as blocked, no retry', async () => {
    const { f, calls } = mockSite({
      'https://s.sk/robots.txt': { status: 200, body: '' },
      'https://s.sk/p': { status: 403, body: '<title>Just a moment...</title>' },
    });
    const s = new ShopSession('s.sk', { scheduler: new HostScheduler({ intervalMs: 0 }), cache: new MemoryCache(), fetch: f });
    const r = await s.get('https://s.sk/p', 'p');
    assert.equal(r.blocked, 'cloudflare');
    assert.equal(calls.filter((c) => c.url === 'https://s.sk/p').length, 1);
  });
  test('a plain-text robots.txt that mentions captcha / challenge-platform paths is not a bot wall', async () => {
    const { f } = mockSite({
      'https://s.sk/robots.txt': { status: 200, body: 'User-agent: *\nDisallow: /captcha\nDisallow: /cdn-cgi/challenge-platform/', headers: { 'content-type': 'text/plain' } },
      'https://s.sk/p': { status: 200, body: 'x' },
    });
    const s = new ShopSession('s.sk', { scheduler: new HostScheduler({ intervalMs: 0 }), cache: new MemoryCache(), fetch: f });
    const r = await s.get('https://s.sk/p', 'p');
    assert.equal(r.ok, true);
    assert.equal((await s.get('https://s.sk/captcha', 'p')).robotsDisallowed, 'https://s.sk/captcha');
  });
  test('the request budget (6 per shop) counts robots.txt and redirects', async () => {
    const routes: Record<string, { status: number; body?: string; headers?: Record<string, string> }> = { 'https://s.sk/robots.txt': { status: 200, body: '' } };
    for (let i = 0; i < 10; i++) routes[`https://s.sk/p${i}`] = { status: 200, body: 'x' };
    const { f, calls } = mockSite(routes);
    const s = new ShopSession('s.sk', { scheduler: new HostScheduler({ intervalMs: 0 }), cache: new MemoryCache(), fetch: f });
    const results = [];
    for (let i = 0; i < 10; i++) results.push(await s.get(`https://s.sk/p${i}`, 'p'));
    assert.equal(calls.length, 6);
    assert.equal(results.filter((r) => r.ok).length, 5);
    assert.ok(results[9].budgetExhausted);
  });
  test('robots.txt comes from the cache on the next search', async () => {
    const cache = new MemoryCache();
    const { f, calls } = mockSite({ 'https://s.sk/robots.txt': { status: 200, body: '' }, 'https://s.sk/p': { status: 200, body: 'x' } });
    for (let i = 0; i < 2; i++) {
      const s = new ShopSession('s.sk', { scheduler: new HostScheduler({ intervalMs: 0 }), cache, fetch: f });
      await s.get('https://s.sk/p', 'p');
    }
    assert.equal(calls.filter((c) => c.url.endsWith('robots.txt')).length, 1);
  });
});

describe('HostScheduler', () => {
  test('keeps the minimum gap per host and runs different hosts in parallel', async () => {
    const sleeps: number[] = [];
    const sch = new HostScheduler({ intervalMs: 3000, sleep: async (ms) => { sleeps.push(ms); } });
    const order: string[] = [];
    await Promise.all([
      sch.schedule('a', async () => order.push('a1')),
      sch.schedule('a', async () => order.push('a2')),
      sch.schedule('b', async () => order.push('b1')),
    ]);
    assert.deepEqual(order.filter((x) => x.startsWith('a')), ['a1', 'a2']);
    assert.equal(sleeps.length, 1, 'only the second request to host a waits');
    assert.ok(sleeps[0] > 2900 && sleeps[0] <= 3000);
  });
});

describe('search page links (no ItemList)', () => {
  test('NAY search page: product links, nav and filter links excluded, duplicates merged', () => {
    const c = extractLinkCandidates(linksHtml('nay_oralb_search_links'), 'https://www.nay.sk/vyhladavanie?q=Oral-B+Pro+3+3000', 'Oral-B Pro 3 3000');
    assert.ok(c.length >= 3);
    assert.ok(c.every((x) => !x.url.includes('#') && !x.url.includes('/vyhladavanie')));
    assert.equal(new Set(c.map((x) => x.url)).size, c.length);
    assert.ok(c.some((x) => x.url === 'https://www.nay.sk/zubna-kefka-oral-b-pro-3-kids-lion-king' && /Kids Lion King/.test(x.title)));
  });
  test('Mironet search page: iPhone links found with titles', () => {
    const c = extractLinkCandidates(linksHtml('mironet_iphone16_search_links'), 'https://www.mironet.cz/ProductList/showSearch?EXPF=iPhone+16+128GB', 'iPhone 16 128GB');
    assert.ok(c.some((x) => /apple-iphone-16-128gb/.test(x.url)));
    // of the several anchors per product (name, spec line) the one naming the product is used
    const black = c.find((x) => x.url.includes('apple-iphone-16-128gb-cerna'));
    assert.equal(black?.title, 'Apple iPhone 16 128GB černá');
  });
});
