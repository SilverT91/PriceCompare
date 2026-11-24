import { readFileSync } from 'node:fs';
import type { Cache } from '../src/core/types.ts';

export class MemoryCache implements Cache {
  map = new Map<string, unknown>();
  async get<T>(ns: string, key: string): Promise<T | undefined> {
    return this.map.get(`${ns}\u0000${key}`) as T | undefined;
  }
  async set<T>(ns: string, key: string, value: T): Promise<void> {
    this.map.set(`${ns}\u0000${key}`, structuredClone(value));
  }
}

export interface JsonLdFixture {
  url: string;
  kind: string;
  blocks: unknown[];
}

export function fixture(name: string): JsonLdFixture {
  return JSON.parse(readFileSync(new URL(`./fixtures/jsonld/${name}.json`, import.meta.url), 'utf8'));
}

/** Wraps a fixture's JSON-LD blocks in a minimal HTML page, as a shop would serve them. */
export function fixtureHtml(name: string): { html: string; url: string } {
  const f = fixture(name);
  const scripts = f.blocks.map((b) => `<script type="application/ld+json">${JSON.stringify(b)}</script>`).join('\n');
  return { html: `<!doctype html><html><head><title>t</title>${scripts}</head><body><p>page</p></body></html>`, url: f.url };
}

export function linksHtml(name: string): string {
  return readFileSync(new URL(`./fixtures/links/${name}.html`, import.meta.url), 'utf8');
}
