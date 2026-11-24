// Node-specific wiring shared by the CLI and the server: .env, shops.yaml, SQLite, search provider.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { HostScheduler } from '../core/http.ts';
import { BraveProvider } from '../core/search/brave.ts';
import type { SearchProvider } from '../core/search/provider.ts';
import { SerperProvider } from '../core/search/serper.ts';
import { validateShops } from '../core/shops.ts';
import type { Shop } from '../core/types.ts';
import { Store } from './db.ts';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));

export function loadEnv(): void {
  const path = `${ROOT}.env`;
  if (existsSync(path)) process.loadEnvFile(path);
}

export function loadShops(path = `${ROOT}data/shops.yaml`): Shop[] {
  const { shops, problems } = validateShops(parse(readFileSync(path, 'utf8')));
  for (const p of problems) console.warn(`shops.yaml: ${p}`);
  return shops;
}

/** Default provider order; chosen from the measurement in the README ("Web search providers"). */
// Measured 2026-11-24 (3 products x 12 robots-disallowed shops): Brave found a correct or possible
// product page at as many shops as Serper (7 of 36 shop-searches each), and its credit renews monthly,
// so Brave goes first and Serper (one-time free credit) is the fallback.
export const DEFAULT_PROVIDER_ORDER = 'brave,serper';

/**
 * Web search providers in order of preference: the `order` argument (CLI --providers), else
 * SEARCH_PROVIDERS from .env, else DEFAULT_PROVIDER_ORDER. A provider is only used when its key
 * (SERPER_API_KEY / BRAVE_API_KEY) is set. "none" disables web search. Keys are never logged.
 */
export function providersFromEnv(order?: string): SearchProvider[] {
  const spec = (order ?? process.env.SEARCH_PROVIDERS ?? DEFAULT_PROVIDER_ORDER).toLowerCase();
  if (spec === 'none') return [];
  const out: SearchProvider[] = [];
  for (const id of spec.split(',').map((s) => s.trim())) {
    if (id === 'serper' && process.env.SERPER_API_KEY?.trim()) {
      out.push(new SerperProvider(process.env.SERPER_API_KEY.trim(), Number(process.env.SERPER_RESULTS) || 10));
    } else if (id === 'brave' && process.env.BRAVE_API_KEY?.trim()) {
      out.push(new BraveProvider(process.env.BRAVE_API_KEY.trim(), Number(process.env.BRAVE_RESULTS) || 20));
    }
  }
  return out;
}

export function openStore(opts: { noCache?: boolean } = {}): Store {
  const path = process.env.PRICE_COMPARE_DB ?? `${ROOT}.cache/price-compare.sqlite`;
  return new Store(path, opts.noCache ? { bypassNamespaces: ['offers', 'candidates', 'provider'] } : {});
}

export function makeScheduler(store: Store): HostScheduler {
  return new HostScheduler({ clock: store });
}
