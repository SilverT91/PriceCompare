// SQLite storage through Node's built-in node:sqlite (stability 1.2, release candidate, in Node 26).
// Holds: the TTL cache (extracted offers, candidates, robots.txt rules, exchange rates, web search
// results, blocked-shop marks), the last request time per host, search history and the web search
// usage ledger, and the local database of what searches found (History: product pages read, which
// pages matched a query at a shop, the last result per shop and query). No page bodies are stored.

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import * as sqlite from 'node:sqlite';

// Node 26 renamed DatabaseSync to Database (DatabaseSync stays as a deprecated alias of the same
// class); @types/node 26.6 only declares DatabaseSync, so pick the runtime name with the old type.
const Database: typeof sqlite.DatabaseSync = (sqlite as unknown as { Database?: typeof sqlite.DatabaseSync }).Database ?? sqlite.DatabaseSync;
type Database = sqlite.DatabaseSync;
import type { HostClock } from '../core/http.ts';
import type { ProviderCall } from '../core/search/provider.ts';
import type { Cache, FoundPage, History, StoredPage, StoredRun } from '../core/types.ts';

export class Store implements Cache, HostClock, History {
  readonly db: Database;
  private readonly noCache: Set<string>;

  constructor(path: string, opts: { bypassNamespaces?: string[] } = {}) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { timeout: 5000 });
    this.noCache = new Set(opts.bypassNamespaces ?? []);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS cache (
        ns TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        PRIMARY KEY (ns, key)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS host_clock (host TEXT PRIMARY KEY, last_ms INTEGER NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS searches (
        id INTEGER PRIMARY KEY AUTOINCREMENT, query TEXT NOT NULL, location TEXT NOT NULL,
        started_at TEXT NOT NULL, ms INTEGER, status_counts TEXT, offers INTEGER, groups_found INTEGER
      ) STRICT;
      CREATE TABLE IF NOT EXISTS provider_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, provider TEXT NOT NULL, query TEXT NOT NULL,
        country TEXT NOT NULL, lang TEXT NOT NULL, results INTEGER NOT NULL, credits INTEGER NOT NULL,
        ok INTEGER NOT NULL, error TEXT
      ) STRICT;
      -- The local database (History): kept without an expiry.
      CREATE TABLE IF NOT EXISTS stored_pages (url TEXT PRIMARY KEY, shop_id TEXT NOT NULL, value TEXT NOT NULL, at TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS found_pages (
        query TEXT NOT NULL, shop_id TEXT NOT NULL, url TEXT NOT NULL, title TEXT NOT NULL, route TEXT NOT NULL, at TEXT NOT NULL,
        PRIMARY KEY (query, shop_id, url)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS shop_runs (
        query TEXT NOT NULL, shop_id TEXT NOT NULL, status TEXT NOT NULL, route TEXT NOT NULL, at TEXT NOT NULL, web_at TEXT,
        PRIMARY KEY (query, shop_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, at TEXT NOT NULL) STRICT;
    `);
  }

  // ---- History: the local database of what searches found (types.ts) ----------------------------

  async pagesFor(query: string, shopId: string): Promise<FoundPage[]> {
    return this.db.prepare('SELECT url, title, route, at FROM found_pages WHERE query = ? AND shop_id = ? ORDER BY at DESC').all(query, shopId) as never;
  }

  async page(url: string): Promise<{ page: StoredPage; at: string } | null> {
    const row = this.db.prepare('SELECT value, at FROM stored_pages WHERE url = ?').get(url) as { value: string; at: string } | undefined;
    return row ? { page: JSON.parse(row.value) as StoredPage, at: row.at } : null;
  }

  async lastRun(query: string, shopId: string): Promise<StoredRun | null> {
    const row = this.db.prepare('SELECT status, route, at, web_at FROM shop_runs WHERE query = ? AND shop_id = ?').get(query, shopId) as
      | { status: StoredRun['status']; route: StoredRun['route']; at: string; web_at: string | null }
      | undefined;
    return row ? { status: row.status, route: row.route, at: row.at, ...(row.web_at ? { webAt: row.web_at } : {}) } : null;
  }

  async savePage(url: string, shopId: string, page: StoredPage): Promise<void> {
    this.db.prepare('INSERT INTO stored_pages (url, shop_id, value, at) VALUES (?, ?, ?, ?) ON CONFLICT(url) DO UPDATE SET shop_id = excluded.shop_id, value = excluded.value, at = excluded.at')
      .run(url, shopId, JSON.stringify(page), new Date().toISOString());
  }

  /**
   * The result of one shop for one query. When the shop answered (found or nothing matching), the
   * matching pages replace the stored ones; a page found before keeps the date it was first found,
   * so a page re-read without a web search does not count as newly found. A failure (blocked, error)
   * keeps the pages found before.
   */
  async saveRun(query: string, shopId: string, run: StoredRun, found: Omit<FoundPage, 'at'>[]): Promise<void> {
    const now = new Date().toISOString();
    this.db.prepare('INSERT INTO shop_runs (query, shop_id, status, route, at, web_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(query, shop_id) DO UPDATE SET status = excluded.status, route = excluded.route, at = excluded.at, web_at = excluded.web_at')
      .run(query, shopId, run.status, run.route, run.at, run.webAt ?? null);
    if (run.status !== 'ok' && run.status !== 'no_match') return;
    const keep = new Set(found.map((f) => f.url));
    for (const old of await this.pagesFor(query, shopId)) {
      if (!keep.has(old.url)) this.db.prepare('DELETE FROM found_pages WHERE query = ? AND shop_id = ? AND url = ?').run(query, shopId, old.url);
    }
    for (const f of found) {
      this.db.prepare('INSERT INTO found_pages (query, shop_id, url, title, route, at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(query, shop_id, url) DO NOTHING')
        .run(query, shopId, f.url, f.title, f.route, now);
    }
  }

  async saveRates(value: unknown): Promise<void> {
    this.db.prepare('INSERT INTO kv (key, value, at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, at = excluded.at')
      .run('rates', JSON.stringify(value), new Date().toISOString());
  }

  async lastRates(): Promise<{ value: unknown; at: string } | null> {
    const row = this.db.prepare("SELECT value, at FROM kv WHERE key = 'rates'").get() as { value: string; at: string } | undefined;
    return row ? { value: JSON.parse(row.value), at: row.at } : null;
  }

  async get<T>(ns: string, key: string): Promise<T | undefined> {
    if (this.noCache.has(ns)) return undefined;
    const row = this.db.prepare('SELECT value, expires_at FROM cache WHERE ns = ? AND key = ?').get(ns, key) as
      | { value: string; expires_at: number }
      | undefined;
    if (!row) return undefined;
    if (row.expires_at < Date.now()) {
      this.db.prepare('DELETE FROM cache WHERE ns = ? AND key = ?').run(ns, key);
      return undefined;
    }
    return JSON.parse(row.value) as T;
  }

  async set<T>(ns: string, key: string, value: T, ttlSeconds: number): Promise<void> {
    const now = Date.now();
    this.db
      .prepare('INSERT INTO cache (ns, key, value, created_at, expires_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(ns, key) DO UPDATE SET value = excluded.value, created_at = excluded.created_at, expires_at = excluded.expires_at')
      .run(ns, key, JSON.stringify(value), now, now + ttlSeconds * 1000);
  }

  async getLast(host: string): Promise<number | undefined> {
    const row = this.db.prepare('SELECT last_ms FROM host_clock WHERE host = ?').get(host) as { last_ms: number } | undefined;
    return row?.last_ms;
  }

  async setLast(host: string, t: number): Promise<void> {
    this.db.prepare('INSERT INTO host_clock (host, last_ms) VALUES (?, ?) ON CONFLICT(host) DO UPDATE SET last_ms = excluded.last_ms').run(host, t);
  }

  recordSearch(s: { query: string; location: string; startedAt: string; ms: number; statusCounts: unknown; offers: number; groups: number }) {
    this.db
      .prepare('INSERT INTO searches (query, location, started_at, ms, status_counts, offers, groups_found) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(s.query, s.location, s.startedAt, s.ms, JSON.stringify(s.statusCounts), s.offers, s.groups);
  }

  history(limit = 20) {
    return this.db.prepare('SELECT id, query, location, started_at, ms, status_counts, offers, groups_found FROM searches ORDER BY id DESC LIMIT ?').all(limit);
  }

  recordProviderCall(c: ProviderCall) {
    this.db
      .prepare('INSERT INTO provider_calls (at, provider, query, country, lang, results, credits, ok, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(new Date().toISOString(), c.provider, c.query, c.locale.country, c.locale.lang, c.results, c.credits, c.ok ? 1 : 0, c.error ?? null);
  }

  /**
   * Credits of the successful calls of one provider since an ISO time (null = all time). A failed call
   * is logged with ok = 0 and 0 credits and is not counted. `at` is an ISO time in UTC, so it compares as text.
   */
  creditsUsed(provider: string, sinceIso: string | null): number {
    const row = this.db
      .prepare('SELECT COALESCE(SUM(credits), 0) AS used FROM provider_calls WHERE provider = ? AND ok = 1 AND (? IS NULL OR at >= ?)')
      .get(provider, sinceIso, sinceIso) as { used: number };
    return Number(row.used);
  }

  providerUsage(): { provider: string; calls: number; credits: number }[] {
    return this.db.prepare('SELECT provider, COUNT(*) AS calls, SUM(credits) AS credits FROM provider_calls GROUP BY provider').all() as never;
  }

  purgeExpired() {
    this.db.prepare('DELETE FROM cache WHERE expires_at < ?').run(Date.now());
  }

  close() {
    this.db.close();
  }
}
