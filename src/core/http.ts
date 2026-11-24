// Polite HTTP client for shop pages. Rules enforced here (they override coverage):
// - robots.txt is checked for every URL, including each redirect hop; a disallowed URL is never fetched;
// - at least 3 s between requests to the same host (measured from the end of the previous request);
// - at most 6 requests per shop per search (robots.txt and redirect hops count);
// - a timeout on every request; no retries at all (so none on 403 or 429);
// - a plain generic User-Agent; no cookies, no browser impersonation.

import { detectBotWall } from './botwall.ts';
import { robotsAllows, robotsFromResponse, type RobotsRecord } from './robots.ts';
import { CACHE_TTL, type Cache } from './types.ts';

export const USER_AGENT = 'price-compare/0.1';
export const MIN_HOST_INTERVAL_MS = 3000;
export const MAX_REQUESTS_PER_SHOP = 6;
export const TIMEOUT_MS = 15_000;
export const MAX_BYTES = 6_000_000;
const MAX_REDIRECTS = 3;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HostClock {
  getLast(host: string): Promise<number | undefined>;
  setLast(host: string, t: number): Promise<void>;
}

/** Serialises requests per host and keeps the minimum gap. Shared by all searches in a process. */
export class HostScheduler {
  private tails = new Map<string, Promise<unknown>>();
  private last = new Map<string, number>();
  private readonly intervalMs: number;
  private readonly clock: HostClock | undefined;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: { intervalMs?: number; clock?: HostClock; sleep?: (ms: number) => Promise<void> } = {}) {
    this.intervalMs = opts.intervalMs ?? MIN_HOST_INTERVAL_MS;
    this.clock = opts.clock;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  schedule<T>(host: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(host) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(async () => {
      let last = this.last.get(host);
      if (last === undefined && this.clock) last = await this.clock.getLast(host);
      if (last !== undefined) {
        const wait = last + this.intervalMs - Date.now();
        if (wait > 0) await this.sleep(wait);
      }
      try {
        return await fn();
      } finally {
        const t = Date.now();
        this.last.set(host, t);
        if (this.clock) await this.clock.setLast(host, t).catch(() => undefined);
      }
    });
    this.tails.set(host, run);
    return run;
  }
}

export function registeredDomain(host: string): string {
  const parts = host.toLowerCase().split(':')[0].split('.');
  return parts.length >= 2 ? parts.slice(-2).join('.') : host.toLowerCase();
}

export interface PageResult {
  ok: boolean;
  status: number | null;
  url: string;
  finalUrl: string;
  text: string;
  /** Set when a bot wall / challenge page was recognised. */
  blocked?: string;
  /** Set when robots.txt disallowed the URL or a redirect target; nothing was fetched for it. */
  robotsDisallowed?: string;
  budgetExhausted?: boolean;
  offsiteRedirect?: string;
  error?: string;
}

export interface RequestLogEntry {
  kind: string;
  url: string;
  status: number | null;
  ms: number;
  note?: string;
}

function charsetOf(contentType: string | null, head: Uint8Array): string {
  const m = /charset=["']?([\w-]+)/i.exec(contentType ?? '');
  if (m) return m[1];
  const ascii = new TextDecoder('latin1').decode(head.slice(0, 4096));
  const mm = /<meta[^>]+charset=["']?([\w-]+)/i.exec(ascii);
  return mm ? mm[1] : 'utf-8';
}

async function readCapped(res: Response, max: number): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  const out = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    out.set(c.subarray(0, Math.min(c.byteLength, size - off)), off);
    off += c.byteLength;
    if (off >= size) break;
  }
  return out;
}

function decode(bytes: Uint8Array, contentType: string | null): string {
  const cs = charsetOf(contentType, bytes);
  try {
    return new TextDecoder(cs).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

export interface ShopSessionDeps {
  scheduler: HostScheduler;
  cache: Cache;
  fetch?: FetchLike;
  budget?: number;
  timeoutMs?: number;
  acceptLanguage?: string;
}

/** One shop during one search: owns the request budget and the request log. */
export class ShopSession {
  used = 0;
  readonly log: RequestLogEntry[] = [];
  private robotsMemo = new Map<string, { rec: RobotsRecord; blocked?: string }>();
  private readonly deps: ShopSessionDeps;
  private readonly baseDomain: string;
  private readonly budget: number;

  constructor(domain: string, deps: ShopSessionDeps) {
    this.deps = deps;
    this.baseDomain = registeredDomain(domain);
    this.budget = deps.budget ?? MAX_REQUESTS_PER_SHOP;
  }

  remaining(): number {
    return this.budget - this.used;
  }

  private async raw(url: string, kind: string): Promise<{ res?: Response; bytes?: Uint8Array; error?: string; ms: number }> {
    const host = new URL(url).host;
    const f = this.deps.fetch ?? fetch;
    this.used++;
    return this.deps.scheduler.schedule(host, async () => {
      const t0 = Date.now();
      try {
        const res = await f(url, {
          method: 'GET',
          redirect: 'manual',
          headers: {
            'User-Agent': USER_AGENT,
            Accept: kind === 'robots' ? 'text/plain,*/*;q=0.5' : 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
            'Accept-Language': this.deps.acceptLanguage ?? 'sk,cs;q=0.8,en;q=0.6',
          },
          signal: AbortSignal.timeout(this.deps.timeoutMs ?? TIMEOUT_MS),
        });
        const bytes = await readCapped(res, MAX_BYTES);
        const ms = Date.now() - t0;
        this.log.push({ kind, url, status: res.status, ms });
        return { res, bytes, ms };
      } catch (e) {
        const ms = Date.now() - t0;
        const error = e instanceof Error ? `${e.name}: ${e.message}`.slice(0, 160) : String(e);
        this.log.push({ kind, url, status: null, ms, note: error });
        return { error, ms };
      }
    });
  }

  /** robots.txt for the URL's origin, from cache or fetched (fetching counts against the budget). */
  async robots(url: string): Promise<{ rec: RobotsRecord; blocked?: string; budgetExhausted?: boolean }> {
    const origin = new URL(url).origin;
    const memo = this.robotsMemo.get(origin);
    if (memo) return memo;
    const cached = await this.deps.cache.get<RobotsRecord>('robots', origin);
    if (cached) {
      const r = { rec: cached };
      this.robotsMemo.set(origin, r);
      return r;
    }
    let target = `${origin}/robots.txt`;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (this.remaining() <= 0) return { rec: { mode: 'disallow_all', rules: [], status: null }, budgetExhausted: true };
      const r = await this.raw(target, 'robots');
      if (!r.res) {
        const rec = robotsFromResponse(null, null);
        // Do not cache network errors for a day: a later search may reach it.
        this.robotsMemo.set(origin, { rec });
        return { rec };
      }
      const status = r.res.status;
      if (status >= 300 && status < 400 && r.res.headers.get('location')) {
        const next = new URL(r.res.headers.get('location') as string, target);
        if (registeredDomain(next.host) !== this.baseDomain) {
          const rec: RobotsRecord = { mode: 'disallow_all', rules: [], status, note: 'robots.txt redirects off-site' };
          this.robotsMemo.set(origin, { rec });
          return { rec };
        }
        target = next.href;
        continue;
      }
      const text = decode(r.bytes ?? new Uint8Array(), r.res.headers.get('content-type'));
      // A robots.txt served as plain text with 200 is never a wall, even if its rules mention
      // "captcha" or "challenge-platform" paths (Mountfield, MediaMarkt do).
      const html = /html/i.test(r.res.headers.get('content-type') ?? '') || /^\s*<(!doctype|html)/i.test(text);
      const wall = status >= 200 && status < 300 && !html ? { detected: false, vendor: null } : detectBotWall(status, r.res.headers, text);
      if (wall.detected) {
        const res = { rec: { mode: 'disallow_all' as const, rules: [], status, note: 'bot wall on robots.txt' }, blocked: wall.vendor ?? 'unknown' };
        this.robotsMemo.set(origin, res);
        return res;
      }
      const rec = robotsFromResponse(status, text);
      await this.deps.cache.set('robots', origin, rec, CACHE_TTL.robots);
      this.robotsMemo.set(origin, { rec });
      return { rec };
    }
    const rec: RobotsRecord = { mode: 'disallow_all', rules: [], status: null, note: 'too many robots.txt redirects' };
    return { rec };
  }

  async allowed(url: string): Promise<{ allowed: boolean; blocked?: string; budgetExhausted?: boolean; note?: string }> {
    const r = await this.robots(url);
    if (r.blocked) return { allowed: false, blocked: r.blocked };
    if (r.budgetExhausted) return { allowed: false, budgetExhausted: true };
    return { allowed: robotsAllows(r.rec, url), note: r.rec.note };
  }

  /** GET a page: robots check for every hop, same-site redirects only, bot wall detection. */
  async get(url: string, kind: string): Promise<PageResult> {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const perm = await this.allowed(current);
      if (perm.blocked) return { ok: false, status: null, url, finalUrl: current, text: '', blocked: perm.blocked };
      if (perm.budgetExhausted) return { ok: false, status: null, url, finalUrl: current, text: '', budgetExhausted: true };
      if (!perm.allowed) return { ok: false, status: null, url, finalUrl: current, text: '', robotsDisallowed: current };
      if (this.remaining() <= 0) return { ok: false, status: null, url, finalUrl: current, text: '', budgetExhausted: true };
      const r = await this.raw(current, kind);
      if (!r.res) return { ok: false, status: null, url, finalUrl: current, text: '', error: r.error };
      const status = r.res.status;
      if (status >= 300 && status < 400 && r.res.headers.get('location')) {
        const next = new URL(r.res.headers.get('location') as string, current);
        if (registeredDomain(next.host) !== this.baseDomain) {
          return { ok: false, status, url, finalUrl: current, text: '', offsiteRedirect: next.href };
        }
        current = next.href;
        continue;
      }
      const text = decode(r.bytes ?? new Uint8Array(), r.res.headers.get('content-type'));
      const wall = detectBotWall(status, r.res.headers, text);
      if (wall.detected) return { ok: false, status, url, finalUrl: current, text: '', blocked: wall.vendor ?? 'unknown' };
      return { ok: status >= 200 && status < 300, status, url, finalUrl: current, text };
    }
    return { ok: false, status: null, url, finalUrl: current, text: '', error: 'too many redirects' };
  }
}
